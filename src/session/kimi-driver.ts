/**
 * The kimi session driver (design §4.7): turn-per-process over kimi's
 * own session store. Each caller input spawns one headless kimi process
 * (`--prompt`, `--output-format stream-json`; src/session/kimi-
 * session.ts pins the wire), and its exit is the turn's verdict. State
 * carries across turns through the native session id: a fresh session
 * learns its id from the first turn's `session.resume_hint` meta line
 * — the only line that names one — and every later turn resumes it
 * with `--session <id>`, kimi's own store replaying the transcript.
 *
 * Round al28 makes this file an EXECUTOR only: every decision lives in
 * the state machine (kimi-machine.ts; the table is documented once, in
 * turn-per-process.ts). The driver translates process callbacks into
 * events (deliver), performs the effects the transition returns, in
 * order, and owns the two asynchronous procedures the effects start —
 * the end path (runEndPath: wait for or stop what the state owes, then
 * deliver children_settled, the machine's one transition into `ended`)
 * and the hold (an abandoned spawn's late-landing child stopped and
 * settled before the registry record is released). An effect list
 * produced by one transition is executed to completion in order (round
 * al29's effect-completion rule): a delivery raised while the list
 * runs — the outbound queue's overflow fires inside an emit — is
 * queued and dispatched after the list finishes, never allowed to
 * abort the remaining effects. The abort it replaces once skipped
 * ledger_session and resolve_done when the session_ended emit itself
 * tripped the queue, leaving run() pending on a session the machine
 * had already ended.
 *
 * The prompt rides argv (kimi 0.31.1 has no stdin transport), so the
 * run path's 32 KiB argv bound is the per-turn cap, checked before the
 * ack, and a turn process is spawned with its whole input already in
 * hand: nothing is ever written to the child's stdin — a piped stdin
 * kimi never reads, closed by endInput() once the spawn lands. No
 * usage appears on the wire: every turn reports all-null usage, the
 * honest null rather than a guessed zero, and the ledger mirrors it.
 */

import { randomUUID } from "node:crypto";
import type { AutonomyLevel } from "../types.js";
import {
  appendSessionCallRecord,
  appendSessionTurnCallRecord,
  providerHost,
  type SessionCallContext,
} from "../call-log.js";
import { emptyUsage } from "../result-envelope.js";
import {
  buildKimiSessionCommand,
  kimiSessionCapabilities,
} from "./kimi-session.js";
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
  awaitFinalFlush,
  buildSessionEnded,
  shutdownRequested,
  BoundedOutboundQueue,
  codemuxFatalMessage,
  installSessionSignalHandlers,
  type SessionFatal,
  type SessionSignalGate,
} from "./process.js";
import {
  buildEvent,
  buildInputAck,
  buildUnknownEvent,
  buildUserMessage,
} from "./protocol.js";
import {
  recordSessionStart,
  releaseSessionRecord,
  touchSession,
  type SandboxTrust,
} from "./registry.js";

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

export class KimiSessionDriver {
  private readonly config: KimiMachineConfig;
  private readonly state: KimiMachineState = initialKimiState(null);
  private readonly out: BoundedOutboundQueue;
  private readonly signals: SessionSignalGate;
  private seq = 0;
  /** Codemux's own id for this session, minted at construction: what the
   * call ledger records while no resume hint has named the session (and
   * ever after, if none ever does), so id-less sessions never share a
   * key. */
  private readonly codemuxSessionId = randomUUID();
  /** The in-flight turn spawn, set when the spawn effect runs and
   * cleared once its continuation has delivered (or the hold took it). */
  private spawnPromise: Promise<TurnChild> | null = null;
  /** Resolves the end path's graceful spawn wait when a later cause
   * cuts it; null outside that wait. */
  private cutResolve: (() => void) | null = null;
  /** The current child's exit delivery promise (exited → settled → the
   * child_exit event); the end path awaits the same promise, so the
   * exit is always classified before children_settled runs. */
  private childDelivery: Promise<void> = Promise.resolve();
  /** True once the end-path procedure has started (the end_path effect
   * fires exactly once; a later one would be spurious). */
  private endPathStarted = false;
  /** The hold's resolution: resolved once an abandoned spawn can no
   * longer create a child (its rejection, or its late landing stopped
   * and settled). finishDone awaits it — past done, by design — before
   * releasing the registry record, for a release is a promise no child
   * is coming. A spawn that never settles holds the record until this
   * process dies. */
  private readonly holdReleased: Promise<void>;
  private resolveHold: (() => void) | null = null;
  /** True once the hold resolved (the abandoned spawn can no longer
   * create a child); the signal handlers's extended install reads it. */
  private holdDone = false;
  private signalsDisposed = false;
  /** The children a second signal's escalation kills by group (round
   * al30, edges major 3): the turn child this driver attached, and the
   * abandoned spawn's late child the hold is settling. */
  private activeChild: TurnChild | null = null;
  private stoppedChild: TurnChild | null = null;
  /** Latched when the operator's second signal escalated the stop (round
   * al31, correctness major 3): a signal landing between an abandoned
   * spawn and its child's arrival finds no child to kill yet, so the
   * latch carries the escalation to `settleChild`, which escalates the
   * late child the moment it exists instead of giving it the graceful
   * requestStop the abandoned end path owes it. */
  private escalateRequested = false;
  /** Warned once about a failed activity stamp (the stamps stay
   * best-effort, single-attempt, never a wait). */
  private touchWarned = false;
  private sessionTimer: Timer | null = null;
  private runDelivered = false;
  /** True while an event is being dispatched through the machine and its
   * effects performed. A delivery raised inside that window — the
   * outbound queue's overflow fires inside an emit — is parked here and
   * dispatched after the current effect list has run to completion (the
   * al29 effect-completion rule: no nested event may abort the effects
   * the machine already issued). */
  private delivering = false;
  private readonly pendingEvents: KimiEvent[] = [];
  /** The session's own start, for the closing ledger record's duration. */
  private readonly sessionStartedAt = Date.now();
  /** The launch facts the call ledger records on every turn and at the
   * end (call-log.ts); the provider is the override's host or "default". */
  private readonly callLedger: SessionCallContext;
  private closingLedger: Extract<KimiEffect, { kind: "ledger_session" }> | null = null;
  private readonly done: Promise<number>;
  private resolveDone!: (code: number) => void;

  constructor(private readonly options: KimiDriverOptions) {
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

  /** The CLI's resume claim succeeded: this process owns the record from
   * now on, whether or not the session start is ever reached. */
  adoptResumeClaim(): void {
    this.state.resumeClaimed = true;
  }

  /** The main wait: resolves with codemux's exit code when the session
   * has fully ended. There is no child to watch while idle — a turn
   * process's death is that turn's business, not the session's, until
   * the machine says otherwise. */
  async run(): Promise<number> {
    if (this.runDelivered || this.state.phase === "ended") return this.done;
    this.runDelivered = true;
    this.deliver({ kind: "run_started" });
    return this.done;
  }

  /** One line from the open turn process's stdout. Never throws; the
   * machine decides whether the line is parsed at all. */
  handleHarnessLine(line: string): void {
    this.deliver({ kind: "child_line", line });
  }

  /** A tier-3 fatal from the process layer (non-UTF-8, line overflow, a
   * stdout read failure), classified here — a codemux-side framing or
   * I/O failure is reported with its own words on stderr as well. */
  handleFatal(fatal: SessionFatal): void {
    if (fatal.kind === "handler" || fatal.kind === "read-error") {
      console.error(`codemux: ${codemuxFatalMessage(fatal)}`, fatal.error);
      this.deliver({
        kind: "fatal",
        source: "codemux",
        message: codemuxFatalMessage(fatal),
      });
      return;
    }
    this.deliver({
      kind: "fatal",
      source: "harness",
      message: `unusable harness output (${fatal.kind}, ${fatal.bytes} bytes): ${fatal.excerpt}`,
    });
  }

  /** One framed line from the caller's stdin. Never throws. Blank lines
   * are framing whitespace, not input. */
  handleCallerLine(line: string): void {
    if (line.trim() === "") return;
    this.deliver({ kind: "user_input", line });
  }

  /** The caller closed stdin; a read error is carried as the event's
   * error, for the machine to fail the input channel with. */
  handleCallerEnd(error?: unknown): void {
    this.deliver({ kind: "stdin_eof", error });
  }

  dispose(): void {
    // The signal handlers outlive this call when a hold is pending
    // (round al30, edges major 3): an abandoned spawn still settling past
    // `session_ended` keeps them installed, and a second SIGINT/SIGTERM
    // in that window escalates (escalateStop) instead of meeting the
    // default disposition, which would kill codemux mid-hold. finishDone
    // disposes them once the hold has settled.
    if (!this.state.spawnAbandoned || this.holdDone) this.disposeSignals();
    this.clearSessionTimer();
  }

  // --- the transition and its effects --------------------------------------

  private deliver(event: KimiEvent): void {
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

  private performOne(effect: KimiEffect): void {
    switch (effect.kind) {
      case "ack":
        this.emit(
          buildInputAck(
            ++this.seq,
            this.sessionIdOrEmpty(),
            effect.inputSeq,
            effect.accepted,
            effect.reason
          )
        );
        return;
      case "emit":
        // Final turn emissions share the fatal reservation, leaving the
        // lane's last slot for session_ended. Live turn events still use
        // ordinary capacity. A refused final emission raises the exit
        // directly: the ended machine no longer accepts fatal events.
        this.emit(this.renderEvent(effect), {
          terminal: effect.event === "session_ended"
            ? true
            : this.state.phase === "ended" ||
              (effect.event === "turn_completed" && this.state.end.cause !== null) ? "fatal" : undefined,
        });
        return;
      case "error":
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "error", null, {
            fatal: effect.fatal,
            source: effect.source,
            message: effect.message,
          }),
          { terminal: effect.fatal ? "fatal" : undefined }
        );
        return;
      case "announce":
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "session_started", null, {
            agent: "kimi",
            model: this.options.model ?? null,
            autonomy: this.options.autonomy,
            cwd: this.options.cwd,
            sandboxed: this.options.sandboxed,
            sandbox_trust: this.options.sandboxTrust,
            capabilities: kimiSessionCapabilities(),
            protocol: "codemux-live-session/1",
          })
        );
        return;
      case "spawn": {
        const argv = buildKimiSessionCommand({
          model: this.options.wireModel,
          resumeSessionId: this.state.sessionId ?? undefined,
          prompt: effect.prompt,
        });
        let promise: Promise<TurnChild>;
        try {
          promise = this.options.spawnTurn(argv);
        } catch (error) {
          // A synchronous throw from the spawn closure (the CLI's
          // per-turn validateRunRequest) is the spawn's own failure. No
          // promise exists, so no continuation will ever land a child or
          // resolve the hold — the hold completes here instead (round
          // al37, edges major 1), or a fatal end that had abandoned the
          // in-flight spawn waits in finishDone forever.
          this.deliver({ kind: "spawn_failed", error });
          this.completeHold();
          return;
        }
        this.spawnPromise = promise;
        // The continuation registers before anything can race it (the
        // end path's wait attaches to the same promise afterwards), so
        // the event is delivered — and the child attached — before any
        // waiter of the spawn resumes.
        void promise.then(
          (child) => this.spawnContinuation(child, null),
          (error: unknown) => this.spawnContinuation(null, error)
        );
        return;
      }
      case "attach_child": {
        const child = effect.child;
        this.activeChild = child;
        this.childDelivery = child.exited.then(async (outcome) => {
          // The exit is classified only once the tree has settled: the
          // drained output the caller is owed arrived first.
          await child.settled;
          if (this.activeChild === child) this.activeChild = null;
          this.deliver({ kind: "child_exit", child, outcome });
        });
        child.endInput();
        return;
      }
      case "stop_child":
        void this.settleChild(effect.child);
        return;
      case "arm_session_timer":
        if (this.options.sessionTimeoutMs !== null && this.sessionTimer === null) {
          this.sessionTimer = setTimeout(() => {
            this.deliver({ kind: "session_timeout" });
          }, this.options.sessionTimeoutMs);
          this.sessionTimer.unref?.();
        }
        return;
      case "disarm_session_timer":
        this.clearSessionTimer();
        return;
      case "record_start": {
        const registryPath = this.options.registryPath;
        const sessionId = this.state.sessionId;
        // Unreachable otherwise: the machine issues record_start only
        // with a registry and a named session.
        if (registryPath === null || sessionId === null) return;
        const outcome = recordSessionStart(registryPath, {
          id: sessionId,
          agent: "kimi",
          cwd: this.options.cwd,
          hermetic: this.options.hermetic,
          harness_home: this.options.harnessHome,
          model: this.options.model ?? null,
          autonomy: this.options.autonomy,
          sandboxed: this.options.sandboxed,
          sandbox_trust: this.options.sandboxTrust,
          sandbox_no_net: this.options.sandboxNoNet,
          sandbox_scrub_env: this.options.sandboxScrubEnv,
          pass_env: [...this.options.passEnv],
          playwright_mcp: false,
          provider_base_url: this.options.providerBaseUrl,
        });
        this.deliver({
          kind: "record_outcome",
          ok: outcome.ok,
          ...(outcome.ok ? {} : { error: outcome.error }),
        });
        return;
      }
      case "end_path":
        void this.runEndPath();
        return;
      case "cut_waits":
        this.cutResolve?.();
        return;
      case "hold_release":
        // The hold's tracker exists from construction; the machine's
        // effect records the decision to defer the release behind the
        // abandoned spawn's settling.
        return;
      case "release_registry":
        this.releaseRegistryRecord();
        return;
      case "stamp_activity": {
        if (!this.state.registryRecorded || this.options.registryPath === null) return;
        const outcome = touchSession(this.options.registryPath, this.state.sessionId ?? "", {
          attempts: 1,
        });
        if (!outcome.ok && !this.touchWarned) {
          this.touchWarned = true;
          console.error(
            `codemux: cannot stamp the session registry for ${this.state.sessionId} ` +
              `(${outcome.error}); activity tracking may lag`
          );
        }
        return;
      }
      case "ledger_turn":
        appendSessionTurnCallRecord(
          this.callLedger,
          this.ledgerSessionId(),
          effect.turnId,
          effect.startedAt,
          effect.finish,
          emptyUsage()
        );
        return;
      case "ledger_session":
        this.closingLedger = effect;
        return;
      case "resolve_done":
        void this.finishDone(Math.max(effect.code, this.finalEmissionFailed ? 1 : 0));
        return;
    }
  }

  private renderEvent(effect: KimiEffect & { kind: "emit" }): string {
    const sid = this.sessionIdOrEmpty();
    switch (effect.event) {
      case "user_message":
        return buildUserMessage(
          ++this.seq,
          sid,
          effect.inputSeq,
          effect.text,
          effect.author,
          effect.turnId
        );
      case "turn_started":
        return buildEvent(++this.seq, sid, "turn_started", null, { turn_id: effect.turnId });
      case "turn_completed":
        return buildEvent(++this.seq, sid, "turn_completed", null, {
          turn_id: effect.turnId,
          finish: effect.finish,
          ...(effect.reason !== undefined ? { reason: effect.reason } : {}),
          usage: emptyUsage(),
        });
      case "assistant_message":
        return buildEvent(++this.seq, sid, "assistant_message", effect.raw, {
          text: effect.text,
          turn_id: effect.turnId,
        });
      case "tool_call":
        return buildEvent(++this.seq, sid, "tool_call", effect.raw, {
          call_id: effect.callId,
          name: effect.name,
          input: effect.input,
        });
      case "tool_result":
        return buildEvent(++this.seq, sid, "tool_result", effect.raw, {
          call_id: effect.callId,
          output: effect.output,
          is_error: false,
        });
      case "unknown_event":
        return buildUnknownEvent(++this.seq, sid, effect.raw);
      case "session_ended":
        return buildSessionEnded(++this.seq, sid, effect.harnessExit, {
          reason: effect.reason,
          shutdown_requested: this.state.end.cause !== null &&
            [this.state.end.cause, ...this.state.end.later].some((cause) => shutdownRequested(cause.reason)),
          exit_code: Math.max(effect.exitCode ?? 0, this.finalEmissionFailed ? 1 : 0),
          usage: effect.usage,
          resumable: effect.resumable && !this.finalEmissionFailed,
        });
    }
  }

  // --- the two procedures ----------------------------------------------------

  /** The end path (the end_path effect starts it exactly once): wait for
   * or stop what the state owes — a graceful end awaits an in-flight
   * spawn and then the turn's own completion; a killing end stops the
   * child at once — and deliver children_settled once every child of
   * the end path has settled. Every wait is cut by a later cause
   * (cut_waits resolves the race; the drain's predicate reads the
   * machine's cause log). */
  private async runEndPath(): Promise<void> {
    if (this.endPathStarted) return;
    this.endPathStarted = true;
    const spawn = this.spawnPromise;
    if (
      this.state.child === null &&
      spawn !== null &&
      this.state.spawnInFlight &&
      !this.state.spawnAbandoned
    ) {
      // A graceful end owes the in-flight spawn its wait: the probes the
      // spawn closure runs may still land a child whose argv already
      // carries the prompt. The wait ends when the spawn settles (the
      // continuation delivers its event first — it registered before
      // this wait) or when a later cause's cut abandons the spawn.
      await new Promise<void>((resolve) => {
        this.cutResolve = resolve;
        void spawn.then(
          () => resolve(),
          () => resolve()
        );
      });
      this.cutResolve = null;
    }
    const child = this.state.child;
    if (child !== null) {
      if (this.state.graceOpen && !this.state.end.cut) {
        // The graceful drain: the turn's own completion (its closing
        // hint and exit), a later cause's cut, or the child's
        // exit/grace deadline answers the wait — then the stop signal
        // and the settle.
        await child.awaitEndAnswer(
          () =>
            this.state.turn === null ||
            this.state.end.cut ||
            this.state.phase === "ended"
        );
      }
      child.requestStop();
      // The exit delivery (attach_child's wiring) resolves this only
      // after the exit has been classified, so children_settled always
      // sees it.
      await this.childDelivery;
    }
    this.deliver({ kind: "children_settled" });
  }

  /** A spawn that settled: delivered as the event while the session can
   * still adopt it, or — when the end path abandoned it, or the session
   * ended — routed to the hold: the late child stopped and settled (or
   * the rejection resolved outright) before the registry record is
   * released. */
  private async spawnContinuation(child: TurnChild | null, error: unknown): Promise<void> {
    this.spawnPromise = null;
    if (this.state.spawnAbandoned || this.state.phase === "ended") {
      if (child !== null) await this.settleChild(child);
      else this.completeHold();
      return;
    }
    if (child === null) this.deliver({ kind: "spawn_failed", error });
    else this.deliver({ kind: "spawn_settled", child: child! });
  }

  /** Stop one child nobody will drain and settle it before the hold
   * resolves — the guarantee the registry release rests on. A latched
   * escalation (the escalateRequested field's note) skips the graceful
   * stop: the late child gets the tree SIGKILL the operator already
   * asked for, on arrival. */
  private async settleChild(child: TurnChild): Promise<void> {
    this.stoppedChild = child;
    if (this.escalateRequested && child.escalateStop !== undefined) {
      child.escalateStop();
    } else {
      child.requestStop();
    }
    try {
      await child.settled;
    } catch {
      // A settle failure changes nothing: the child is gone, which is
      // all the hold asserts.
    }
    this.stoppedChild = null;
    this.completeHold();
  }

  /** Resolve the hold: the abandoned spawn can no longer create a child,
   * so the registry record may be released and the signal handlers taken
   * down (they stayed installed through the hold — round al30, edges
   * major 3). */
  private completeHold(): void {
    this.holdDone = true;
    this.resolveHold?.();
  }

  /** A second SIGINT/SIGTERM while the first signal's shutdown still
   * runs (round al30, edges major 3): SIGKILL every child group this
   * driver still owns, at once. No diagnostic event — the session may
   * already have ended, and `ended` absorbs — and no state change: this
   * is the operator's hand on the same tree the end path is stopping. */
  private escalateStop(): void {
    // Latch before any kill: a spawn still in flight has no child to
    // signal yet, and the continuation's settleChild reads the latch the
    // moment the late child arrives (round al31, correctness major 3).
    this.escalateRequested = true;
    // One child under several aliases — an attached turn child is both
    // activeChild and state.child — is escalated once, not once per
    // alias (round al33, edges major 3: the duplicate sends raced each
    // other and the second attempt's evidence overwrote the first's).
    const targets = new Set<TurnChild>();
    if (this.activeChild !== null) targets.add(this.activeChild);
    if (this.stoppedChild !== null) targets.add(this.stoppedChild);
    if (this.state.child !== null) targets.add(this.state.child);
    for (const child of targets) child.escalateStop?.();
  }

  /** Take the signal handlers down, once (the finishDone tail and the
   * CLI's dispose share this; whichever runs first wins). */
  private disposeSignals(): void {
    if (this.signalsDisposed) return;
    this.signalsDisposed = true;
    this.signals.dispose();
  }

  /** The registry release, once no child of this session can exist
   * anymore (children_settled, or the hold's tail). */
  private releaseRegistryRecord(): void {
    if (this.options.registryPath === null || this.state.sessionId === null) return;
    if (!this.state.registryRecorded && !this.state.resumeClaimed) return;
    releaseSessionRecord(this.options.registryPath, this.state.sessionId);
  }

  /** The final step: flush what remains of the event stream, then hand
   * the caller the end path's code — raised once more only when the
   * final events could not be delivered. The held release resolves past
   * done by design: the caller's code and session_ended land first;
   * only the registry record waits, behind the abandoned spawn's
   * settling. The signal handlers come down only after that wait
   * (round al30, edges major 3): a second SIGINT/SIGTERM while the hold
   * runs escalates instead of being absorbed. */
  private async finishDone(code: number): Promise<void> {
    const delivered = await awaitFinalFlush(this.out);
    const exitCode = delivered ? code : Math.max(code, 1);
    if (this.closingLedger !== null) {
      appendSessionCallRecord(
        this.callLedger,
        this.ledgerSessionId(),
        this.sessionStartedAt,
        this.closingLedger.reason,
        exitCode,
        this.closingLedger.usage
      );
    }
    this.resolveDone(exitCode);
    if (this.state.spawnAbandoned) {
      await this.holdReleased;
      this.releaseRegistryRecord();
    }
    this.disposeSignals();
  }

  // --- helpers ---------------------------------------------------------------

  private sessionIdOrEmpty(): string {
    return this.state.announced ? this.state.sessionId ?? "" : "";
  }

  /** The id the call ledger keys this session's records by: the harness's
   * own session id once a resume hint has named one, else the
   * codemux-minted id every session owns from construction — never "",
   * which merged every id-less session under one key. */
  private ledgerSessionId(): string {
    return this.state.sessionId || this.codemuxSessionId;
  }

  /** A final enqueue failure raises the event, ledger, and process exit
   * even after the machine has ended and stopped accepting callbacks. */
  private finalEmissionFailed = false;

  private emit(line: string, options?: { terminal?: boolean | "fatal" }): void {
    if (!this.out.enqueue(line, options) && this.state.phase === "ended") {
      this.finalEmissionFailed = true;
      console.error("codemux: fatal: a final session event could not be queued");
    }
  }

  private clearSessionTimer(): void {
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
