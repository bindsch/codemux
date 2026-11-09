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
import { SessionOutputQueue } from "./completion.js";
import {
  installSessionSignalHandlers,
  type SessionSignalGate,
} from "./process.js";
import type { SandboxTrust } from "./registry.js";
import type { SessionPrivateHome } from "./private-home-types.js";
import type { KimiNoToolsFile } from "../kimi-no-tools.js";
import { writeKimiNoToolsFile } from "../kimi-no-tools.js";
import { assertKimiResumeTools } from "./kimi-tools.js";
import { buildKimiSessionCommand } from "./kimi-session.js";
import { currentPrivateHomeDir } from "./private-home-key.js";
import { enforceKimiSessionDenyPolicy, kimiPrivateBrandHome, writeKimiSessionHermeticConfig } from "../kimi-hermetic.js";
import { kimiSessionIds } from "./kimi-session-index.js";
import { prepareKimiPlaywright } from "../kimi-run-policy.js";
import { kimiHermeticTurnContext } from "./kimi-turn-context.js";
import type { ExecutableCheck } from "../executable-security.js";
import { isCallerHarnessHome } from "./harness-home.js";

export interface KimiDriverOptions {
  /** The native session id to resume, or null to start fresh. */
  resumeSessionId: string | null;
  autonomy: AutonomyLevel;
  /** Hermetic sessions can deny every tool through native config rules.
   * This does not create a permission request channel on the print wire. */
  permissionPolicy?: "default" | "deny";
  tools?: "none" | "default";
  turnTimeoutMs?: number | null;
  playwrightMcp?: boolean;
  playwrightPathEnv?: string;
  preserveCustomization?: boolean;
  /** The model reported on session_started and recorded in the registry
   * (the CLI's resolved model, override included). */
  model?: string;
  /** The `-m` value as typed when it resolved through `config.models`,
   * else null: reported as `model_alias` on the model-bearing events and
   * recorded with every ledger line (design P5). */
  modelAlias?: string | null;
  /** The `--model` value the per-turn commands carry: the resolved
   * model, except under a provider override, where the synthesized
   * `KIMI_MODEL_*` provider is the default and `--model` stays off (the
   * run adapter's rule; the CLI owns that mapping). */
  wireModel?: string;
  /** The validated working directory — also the registry's cwd record
   * and the directory kimi's own store pins the session to. */
  cwd: string;
  hermetic: boolean;
  /** A project-settings session (--experiment-project-settings, which
   * requires hermetic mode): the per-turn commands drop their
   * --skills-dir so the repository's own skill directories load
   * (kimi-session.ts), and the record carries `project_settings` for
   * the resume guard. */
  experimentProjectSettings?: boolean;
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
  /** Overrides the off-stream start record's retry budget (attempts and
   * retry sleep) for tests that prove the busy-exhaustion path without
   * holding a rival lock for the shipped ~10 s. */
  registryStartBudget?: { attempts: number; retryMs: number };
  /** The harness state home recorded for this session (§4.8). */
  harnessHome: string;
  /** The provider identity recorded for the resume guard (review D3):
   * the override's base URL, or null for the operator's own login. */
  providerBaseUrl: string | null;
  /** Spawns one process per turn (the CLI's scode/env wiring around
   * SessionProcess); a throw is reported as a codemux failure, never an
   * unhandled rejection. Typed to the slice the machine names; real
   * children are SessionProcess instances. */
  spawnTurn: (argv: string[], abandoned?: () => boolean, checks?: readonly ExecutableCheck[]) => Promise<TurnChild>;
  /** The operator brand home a hermetic session's filtered config is
   * generated from (null when the operator has none); the driver reads it
   * once, generating the private brand home's config.toml at the first
   * turn of a fresh home. */
  hermeticSourceHome?: string | null;
  /** The launcher's per-session private home a hermetic session runs in
   * (src/session/private-home-types.ts): reported on
   * session_started.private_home, keyed by the session id in the
   * registry's harness_home, and settled at the first resume hint's
   * child exit (the hint arrives while the turn child still writes its
   * store under the private KIMI_CODE_HOME, so the rename waits for the
   * child). */
  privateHome?: SessionPrivateHome | null;
  sink?: (line: string) => Promise<void> | void;
}

type Timer = ReturnType<typeof setTimeout>;

export abstract class KimiDriverIo {
  protected noToolsProfile?: KimiNoToolsFile;
  protected resumeToolsChecked = false;
  protected sessionIdsBeforeTurn: ReadonlySet<string> = new Set();
  protected playwrightChecks: ExecutableCheck[] = [];

  protected cleanupNoToolsProfile(): void {
    try { this.noToolsProfile?.finalize(); this.noToolsProfile = undefined; }
    catch (error) { console.error("codemux: Kimi no-tools profile cleanup failed", error); }
  }

  protected currentBrandHome(): string {
    return this.options.privateHome != null ? kimiPrivateBrandHome(this.options.privateHome.dir) : this.options.harnessHome;
  }

  protected prepareTurn(prompt: string): string[] {
    const home = this.options.privateHome;
    const callerHome = isCallerHarnessHome(home) ? home : undefined;
    callerHome?.verify();
    const brandHome = this.currentBrandHome();
    if (home != null && this.state.sessionId === null) this.sessionIdsBeforeTurn = kimiSessionIds(brandHome, this.options.cwd);
    const argv = buildKimiSessionCommand({ model: this.options.wireModel,
      resumeSessionId: this.state.sessionId ?? undefined, prompt,
      callerHome,
      hermeticHome: home == null || callerHome || this.options.preserveCustomization ? undefined : currentPrivateHomeDir(home, this.state.sessionId ?? ""),
      brandHome: home != null && this.options.preserveCustomization ? brandHome : undefined,
      projectSettings: this.options.experimentProjectSettings === true });
    if (this.options.resumeSessionId !== null && !this.resumeToolsChecked) {
      assertKimiResumeTools(brandHome, this.options.resumeSessionId, this.options.tools);
      this.resumeToolsChecked = true;
    } else if (this.state.sessionId === null && this.options.tools === "none") {
      this.noToolsProfile = writeKimiNoToolsFile(brandHome);
      argv.splice(argv.indexOf("--output-format"), 0, "--agent-file", this.noToolsProfile.path);
    }
    if (this.options.permissionPolicy === "deny" && home == null) {
      throw new Error("kimi --permission-policy deny requires a hermetic private home");
    }
    if (home != null && !callerHome && !home.resumed && !this.hermeticConfigWritten && !this.options.preserveCustomization) {
      writeKimiSessionHermeticConfig(brandHome, this.options.hermeticSourceHome ?? null);
      this.hermeticConfigWritten = true;
    }
    if (this.options.permissionPolicy === "deny") enforceKimiSessionDenyPolicy(brandHome);
    if (this.options.playwrightMcp) {
      if (home == null || this.options.playwrightPathEnv === undefined) throw new Error("Kimi session Playwright needs a private home and execution PATH");
      const context = kimiHermeticTurnContext(home);
      prepareKimiPlaywright({ agent: "kimi", prompt, sandboxed: this.options.sandboxed, enablePlaywrightMcp: true }, context,
        { pathEnv: this.options.playwrightPathEnv, forbiddenRoot: this.options.cwd });
      this.playwrightChecks = context.playwrightMcpCheck ? [context.playwrightMcpCheck] : [];
    }
    return argv;
  }
  private readonly config: KimiMachineConfig;
  protected readonly state: KimiMachineState = initialKimiState(null);
  protected readonly out: SessionOutputQueue;
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
   * process dies — unless no record ever landed, where the wait is
   * skipped (round 391, item 15). */
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
  protected turnTimer: Timer | null = null;

  protected clearTurnTimer(): void {
    if (this.turnTimer !== null) clearTimeout(this.turnTimer);
    this.turnTimer = null;
  }

  protected armTurnTimer(): void {
    this.clearTurnTimer();
    if (this.options.turnTimeoutMs == null) return;
    this.turnTimer = setTimeout(() => this.deliver({ kind: "turn_timeout" }), this.options.turnTimeoutMs);
    this.turnTimer.unref?.();
  }
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
  /** True once this process generated the private brand home's
   * config.toml (the first turn of a fresh hermetic home; later turns
   * and resumes never rewrite it). */
  protected hermeticConfigWritten = false;
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
      modelAlias: options.modelAlias ?? null,
      provider: providerHost(options.providerBaseUrl),
      autonomy: options.autonomy,
      // The real value: either flag says hermetic, so a launcher that
      // hands only the private home still records it.
      hermetic: options.hermetic || (options.privateHome != null && !isCallerHarnessHome(options.privateHome) && !options.preserveCustomization),
      sandboxed: options.sandboxed,
      cwd: options.cwd,
    };
    this.out = new SessionOutputQueue(
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

  /** Settle the hermetic private home once the session id exists and no
   * child is alive: kimi is turn-per-process, and a turn's child writes
   * its store under the private KIMI_CODE_HOME until it exits, so the
   * rename onto the session-keyed name waits for the exit — the first
   * one after the resume hint, always before the record's release. A
   * settle that fails leaves the home run-shaped: the resume guard's
   * harness_home check then refuses the next resume (fail closed), which
   * session_ended's resumable fold reports honestly. */
  protected settlePrivateHome(): void {
    const home = this.options.privateHome;
    if (home == null || isCallerHarnessHome(home) || home.settled || this.state.sessionId === null) return;
    try {
      home.settle(this.state.sessionId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`codemux: hermetic session home settlement failed: ${detail}`);
    }
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
