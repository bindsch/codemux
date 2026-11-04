/**
 * The kimi driver's shared state and plumbing: the options record,
 * the constructor with the outbound queue and signal install, the
 * delivery loop, and the emit and ledger helpers every side speaks
 * through. src/session/kimi-driver.ts owns the lifecycle.
 */

import { randomUUID } from "node:crypto";
import type { AutonomyLevel } from "../types.js";
import { providerHost, type SessionCallContext } from "../call-log.js";
import {
  initialKimiState,
  step,
  type KimiEffect,
  type KimiEvent,
  type KimiMachineConfig,
  type KimiMachineState,
  type TurnChild,
} from "./kimi-machine.js";
import {
  BoundedOutboundQueue,
  installSessionSignalHandlers,
  type SessionSignalGate,
} from "./process.js";
import type { SandboxTrust } from "./registry.js";

export interface KimiDriverOptions {
  /** The native session id to resume, or null to start fresh. */
  resumeSessionId: string | null;
  autonomy: AutonomyLevel;
  /** The model reported on session_started and recorded in the registry
   * (the CLI's resolved model, override included). */
  model?: string;
  /** The `--model` value the per-turn commands carry: the resolved
   * model, except under a provider override, where the synthesized
   * `KIMI_MODEL_*` provider is the default and `--model` stays off (the
   * run adapter's rule; the CLI owns that mapping). */
  wireModel?: string;
  /** The validated working directory — also the registry's cwd record
   * and the directory kimi's own store pins the session to. */
  cwd: string;
  hermetic: boolean;
  sandboxed: boolean;
  /** The trust the session actually runs at; recorded and reported as-is. */
  sandboxTrust: SandboxTrust;
  sandboxNoNet: boolean;
  /** The caller's --sandbox-block paths, canonicalized; recorded and
   * compared on resume (registry/format.ts). */
  sandboxBlock?: readonly string[];
  sandboxScrubEnv: boolean;
  /** The `--pass-env` names the child runs with; recorded for the
   * resume guard. */
  passEnv: readonly string[];
  authorPrefix: boolean;
  sessionTimeoutMs: number | null;
  /** Null disables registry writes (unit tests); the CLI always passes one. */
  registryPath: string | null;
  /** The harness state home recorded for this session (§4.8). */
  harnessHome: string;
  /** The provider identity recorded for the resume guard (review D3):
   * the override's base URL, or null for the operator's own login. */
  providerBaseUrl: string | null;
  /** Spawns one process per turn (the CLI's scode/env wiring around
   * SessionProcess); a throw is reported as a codemux failure, never an
   * unhandled rejection. Typed to the slice the machine names; real
   * children are SessionProcess instances. */
  spawnTurn: (argv: string[]) => Promise<TurnChild>;
  sink?: (line: string) => Promise<void> | void;
}

type Timer = ReturnType<typeof setTimeout>;

export abstract class KimiDriverIo {
  private readonly config: KimiMachineConfig;
  protected readonly state: KimiMachineState = initialKimiState(null);
  protected readonly out: BoundedOutboundQueue;
  protected readonly signals: SessionSignalGate;
  protected seq = 0;
  /** Codemux's own id for this session, minted at construction: what the
   * call ledger records while no resume hint has named the session (and
   * ever after, if none ever does), so id-less sessions never share a
   * key. */
  private readonly codemuxSessionId = randomUUID();
  /** The in-flight turn spawn, set when the spawn effect runs and
   * cleared once its continuation has delivered (or the hold took it). */
  protected spawnPromise: Promise<TurnChild> | null = null;
  /** Resolves the end path's graceful spawn wait when a later cause
   * cuts it; null outside that wait. */
  protected cutResolve: (() => void) | null = null;
  /** The current child's exit delivery promise (exited → settled → the
   * child_exit event); the end path awaits the same promise, so the
   * exit is always classified before children_settled runs. */
  protected childDelivery: Promise<void> = Promise.resolve();
  /** True once the end-path procedure has started (the end_path effect
   * fires exactly once; a later one would be spurious). */
  protected endPathBegun = false;
  /** The hold's resolution: resolved once an abandoned spawn can no
   * longer create a child (its rejection, or its late landing stopped
   * and settled). finishDone awaits it — past done, by design — before
   * releasing the registry record, for a release is a promise no child
   * is coming. A spawn that never settles holds the record until this
   * process dies. */
  protected readonly holdReleased: Promise<void>;
  protected resolveHold: (() => void) | null = null;
  /** True once the hold resolved (the abandoned spawn can no longer
   * create a child); the signal handlers's extended install reads it. */
  protected holdDone = false;
  protected signalsDisposed = false;
  /** The children a second signal's escalation kills by group (round
   * al30, edges major 3): the turn child this driver attached, and the
   * abandoned spawn's late child the hold is settling. */
  protected activeChild: TurnChild | null = null;
  protected stoppedChild: TurnChild | null = null;
  /** Latched when the operator's second signal escalated the stop (round
   * al31, correctness major 3): a signal landing between an abandoned
   * spawn and its child's arrival finds no child to kill yet, so the
   * latch carries the escalation to `settleChild`, which escalates the
   * late child the moment it exists instead of giving it the graceful
   * requestStop the abandoned end path owes it. */
  protected escalateRequested = false;
  /** Warned once about a failed activity stamp (the stamps stay
   * best-effort, single-attempt, never a wait). */
  protected touchWarned = false;
  protected sessionTimer: Timer | null = null;
  protected runDelivered = false;
  /** True while an event is being dispatched through the machine and its
   * effects performed. A delivery raised inside that window — the
   * outbound queue's overflow fires inside an emit — is parked here and
   * dispatched after the current effect list has run to completion (the
   * al29 effect-completion rule: no nested event may abort the effects
   * the machine already issued). */
  private delivering = false;
  private readonly pendingEvents: KimiEvent[] = [];
  /** The session's own start, for the closing ledger record's duration. */
  protected readonly sessionStartedAt = Date.now();
  /** The launch facts the call ledger records on every turn and at the
   * end (call-log.ts); the provider is the override's host or "default". */
  protected readonly callLedger: SessionCallContext;
  protected closingLedger: Extract<KimiEffect, { kind: "ledger_session" }> | null = null;
  protected readonly done: Promise<number>;
  protected resolveDone!: (code: number) => void;

  constructor(protected readonly options: KimiDriverOptions) {
    this.done = new Promise<number>((resolve) => {
      this.resolveDone = resolve;
    });
    this.holdReleased = new Promise<void>((resolve) => {
      this.resolveHold = resolve;
    });
    // The state's identity field is machine state, not a driver field:
    // set before anything can deliver.
    this.state.sessionId = options.resumeSessionId;
    this.config = {
      authorPrefix: options.authorPrefix,
      registryEnabled: options.registryPath !== null,
    };
    this.callLedger = {
      agent: "kimi",
      model: options.model ?? null,
      provider: providerHost(options.providerBaseUrl),
      autonomy: options.autonomy,
      hermetic: options.hermetic,
      sandboxed: options.sandboxed,
      cwd: options.cwd,
    };
    this.out = new BoundedOutboundQueue(
      options.sink ?? defaultEventSink(),
      (failure) => {
        // Both failure classes end the session (§4.2); the diagnostic
        // rides stderr because the final events may not fit. The queue
        // latches, so further enqueues cannot re-fire this.
        if (failure.kind === "overflow") {
          console.error(
            `codemux: event output overran its bounds (${failure.events} events, ` +
              `${failure.bytes} bytes pending); ending the session`
          );
        } else {
          console.error(
            `codemux: event output failed (${failure.error instanceof Error ? failure.error.message : String(failure.error)}); ending the session`
          );
        }
        this.deliver({
          kind: "fatal",
          source: "codemux",
          message:
            failure.kind === "overflow"
              ? "event output overran its bounds, so the session cannot keep its contract with the caller"
              : "event output failed, so the session cannot keep its contract with the caller",
        });
      }
    );
    this.signals = installSessionSignalHandlers(
      () => {
        this.deliver({ kind: "signal" });
      },
      () => {
        this.escalateStop();
      }
    );
  }

  /** Performs each effect the transition returns, in order
   * (src/session/kimi-driver-events.ts). */
  protected abstract performOne(effect: KimiEffect): void;

  /** SIGKILL every child group this driver still owns
   * (src/session/kimi-driver-finalize.ts). */
  protected abstract escalateStop(): void;

  // --- the transition and its effects --------------------------------------

  protected deliver(event: KimiEvent): void {
    if (this.delivering) {
      this.pendingEvents.push(event);
      return;
    }
    this.delivering = true;
    try {
      this.dispatch(event);
      // The drain runs after the list that raised each queued event has
      // finished, in arrival order, one full transition at a time — a
      // dispatch inside the drain parks the same way.
      while (this.pendingEvents.length > 0) {
        this.dispatch(this.pendingEvents.shift()!);
      }
    } finally {
      this.delivering = false;
    }
  }

  private dispatch(event: KimiEvent): void {
    this.perform(step(this.state, event, this.config));
  }

  private perform(effects: KimiEffect[]): void {
    for (const effect of effects) {
      this.performOne(effect);
    }
  }

  // --- helpers ---------------------------------------------------------------

  protected sessionIdOrEmpty(): string {
    return this.state.announced ? this.state.sessionId ?? "" : "";
  }

  /** The id the call ledger keys this session's records by: the harness's
   * own session id once a resume hint has named one, else the
   * codemux-minted id every session owns from construction — never "",
   * which merged every id-less session under one key. */
  protected ledgerSessionId(): string {
    return this.state.sessionId || this.codemuxSessionId;
  }

  /** A final enqueue failure raises the event, ledger, and process exit
   * even after the machine has ended and stopped accepting callbacks. */
  protected finalEmissionFailed = false;

  protected emit(line: string, options?: { terminal?: boolean | "fatal" }): void {
    if (!this.out.enqueue(line, options) && this.state.phase === "ended") {
      this.finalEmissionFailed = true;
      console.error("codemux: fatal: a final session event could not be queued");
    }
  }

  protected clearSessionTimer(): void {
    if (this.sessionTimer !== null) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
  }
}

/** The default event sink: one JSONL line per write on stdout. */
function defaultEventSink(): (line: string) => Promise<void> {
  return async (line: string): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${line}\n`, (error) => {
        if (error !== null && error !== undefined) reject(error);
        else resolve();
      });
    });
  };
}
