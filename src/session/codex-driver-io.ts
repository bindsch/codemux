/**
 * The codex driver's shared state and wire plumbing: the constructor, the
 * options record, the outbound event queue, the JSON-RPC call registry, and
 * the emit/ack/write helpers every side of the driver speaks through.
 * src/session/codex-driver.ts owns the lifecycle.
 */

import type { AutonomyLevel, ReasoningEffort } from "../types.js";
import { reportSpawnThrow } from "./stdin-frame.js";
import { providerHost, type SessionCallContext } from "../call-log.js";
import {
  buildInitializeRequest,
  CodexStreamParser,
  codexSessionCapabilities,
  codexSessionPolicy,
  type CodexSessionPolicy,
} from "./codex-session.js";
import { SessionFsm } from "./fsm.js";
import {
  BoundedOutboundQueue,
  codemuxFatalMessage,
  SESSION_SIGNAL_EXIT_CODE,
  type SessionFatal,
  type SessionProcess,
  type SessionSignalGate,
} from "./process.js";
import { SessionStopEscalation } from "./stop-escalation.js";
import {
  buildEvent,
  buildInputAck,
  buildUnknownEvent,
  type InputRejectionReason,
} from "./protocol.js";
import type { SandboxTrust } from "./registry.js";
import type { SessionPrivateHome } from "./private-home-types.js";

export interface CodexDriverOptions {
  /** The thread id to resume, or null to start a fresh thread. */
  resumeThreadId: string | null;
  autonomy: AutonomyLevel;
  model?: string;
  /** The model the wire requests carry, when the caller computed one
   * itself: a string sends exactly that, null sends none, and undefined
   * falls back to `model`. Under a provider override the session home's
   * config.toml owns model selection — the run path's never-`-m` rule —
   * so the CLI passes null there while `model` stays the reported one. */
  wireModel?: string | null;
  effort?: ReasoningEffort;
  /** The validated working directory — also the ceiling's launch scope. */
  cwd: string;
  sandboxed: boolean;
  /** The trust the session actually runs at; recorded and reported as-is
   * (the resume guard compares against exactly this value). */
  sandboxTrust: SandboxTrust;
  /** The containment flags this session actually runs with; recorded
   * as-is, and the resume guard refuses a resume that clears either. */
  sandboxNoNet: boolean;
  /** The caller's --sandbox-block paths, canonicalized; recorded and
   * compared on resume (registry/format.ts). */
  sandboxBlock?: readonly string[];
  sandboxScrubEnv: boolean;
  /** The `--pass-env` names the child runs with; recorded for the
   * resume guard (review live16). */
  passEnv: readonly string[];
  /** Prefix harness-bound text with `[<author>] ` (§4.4, default on). */
  authorPrefix: boolean;
  permissionTimeoutMs: number;
  turnTimeoutMs: number | null;
  sessionTimeoutMs: number | null;
  /** Null disables registry writes (unit tests); the CLI always passes one. */
  registryPath: string | null;
  /** The harness state home recorded for this session (§4.8). */
  harnessHome: string;
  /** The provider identity recorded for the resume guard (review D3):
   * the override's base URL, or null for the operator's own login. */
  providerBaseUrl: string | null;
  /** The same record's home keyed by the session id, when the recorded
   * value depends on the id the harness has not named yet — a codex
   * override session's fresh run-shaped CODEX_HOME, or a hermetic
   * session's private home, whose final (resume-computed) path names
   * the thread. Preferred over `harnessHome` at the record, once the id
   * exists. */
  harnessHomeFor?: (sessionId: string) => string;
  /** The end-of-session settlement of a per-session harness home (the
   * codex override session home's `settle`, codex-provider.ts), called
   * once from the end path after the child settled and the resumable
   * verdict is known. Returns whether the home ended where a resume
   * finds it; the reported `resumable` is false without it (review D2,
   * correctness-2 2). Never throws out of the end path. */
  settleSessionHome?: (sessionId: string | null, resumable: boolean) => boolean;
  /** True when the session runs hermetic; recorded in the call ledger
   * and the registry record. */
  hermetic?: boolean;
  /** The launcher's per-session private home a hermetic session runs in
   * (src/session/private-home-types.ts): reported on
   * session_started.private_home, keyed by the thread id in the
   * registry's harness_home, and settled by the end path once the child
   * is gone (the long-lived app-server cannot survive the rename). */
  privateHome?: SessionPrivateHome | null;
  /** Injectable event sink; defaults to codemux stdout, one line each. */
  sink?: (line: string) => Promise<void> | void;
}

export type SessionEndReason =
  | "shutdown"
  | "stdin-close"
  | "signal"
  | "timeout"
  | "crash"
  | "harness_failed";

/** What one outstanding codemux-originated request is waiting on. */
export type PendingCall =
  | "initialize"
  | "thread_start"
  | "thread_resume"
  /** `completedHarnessTurnId`: the harness id a turn that completed before
   * this response arrived adopted; the response must name it (round 244). */
  | { kind: "turn_start"; turnId: string; completedHarnessTurnId?: string }
  /** The caller lines one steer request carries, so a rejection names
   * them (review live23). */
  | { kind: "steer"; inputSeqs: number[]; turnId: string | null }
  | "interrupt";

export type Timer = ReturnType<typeof setTimeout>;

export abstract class CodexDriverIo {
  protected readonly fsm = new SessionFsm();
  protected readonly parser = new CodexStreamParser();
  protected readonly capabilities = codexSessionCapabilities();
  protected readonly policy: CodexSessionPolicy;
  protected readonly out: BoundedOutboundQueue;
  protected readonly pendingTimers = new Map<string, Timer>();

  /** Codemux-originated JSON-RPC requests awaiting their response. */
  protected readonly pendingCalls = new Map<number, PendingCall>();

  protected proc: SessionProcess | null = null;
  protected readonly earlyLines: string[] = [];
  /** The second-signal escalation (src/session/stop-escalation.ts). */
  protected readonly stopEscalation = new SessionStopEscalation();
  /** Caller lines that arrived before the thread existed; replayed once
   * session_started fires so their acks and echoes carry the thread id.
   * Two event classes in that window carry the empty id: the
   * starting-state shutdown path's ack and `shutting_down` rejections,
   * which end the session without waiting for a handshake, and the end
   * path's `shutting_down` rejections of what the replay never reached
   * (review live10). */
  protected readonly preSessionLines: string[] = [];
  /** The parked lines' bytes, bounded with their count: a handshake
   * that never answers must not grow codemux's memory without limit. */
  protected preSessionBytes = 0;

  protected readonly signals: SessionSignalGate;
  protected seq = 0;

  protected requestCounter = 0;
  /** The thread id: the codemux session id. Null on a fresh thread until
   * the thread/start response (or thread/started) names it. */
  protected threadId: string | null;

  /** The launch facts the call ledger records on every turn and at the
   * end (call-log.ts); the provider is the override's host or "default". */
  protected readonly callLedger: SessionCallContext;

  protected finished = false;
  /** The end path's exit code, updatable while cleanup drains: a failure
   * arriving inside the grace window (a tier-3 fatal, a handler
   * exception, a registry failure) must still cost success. Monotone:
   * only a higher code ever wins (review live7). */
  protected endExitCode = 0;
  /** True only once the end path has settled the child: harness lines
   * keep flowing (parsed and emitted) through the whole shutdown drain,
   * because the grace window exists so the harness can finish
   * persisting — the interrupted turn's completion and usage arrive
   * during it (review live5). `finished` alone is the end path's
   * re-entry guard and flips at its start. */
  protected settled = false;

  /** The first fatal the session reported, carried by a crash end's
   * synthesized turn completion (review live17). */
  protected firstFatal: string | null = null;

  private sessionTimer: Timer | null = null;
  private readonly done: Promise<number>;

  protected resolveDone!: (code: number) => void;

  constructor(protected readonly options: CodexDriverOptions) {
    this.done = new Promise<number>((resolve) => {
      this.resolveDone = resolve;
    });
    this.callLedger = {
      agent: "codex",
      model: options.model ?? null,
      provider: providerHost(options.providerBaseUrl),
      autonomy: options.autonomy,
      // The real value: either flag says hermetic, so a launcher that
      // hands only the private home still records it.
      hermetic: options.hermetic === true || options.privateHome != null,
      sandboxed: options.sandboxed,
      cwd: options.cwd,
    };
    this.threadId = options.resumeThreadId;
    this.policy = codexSessionPolicy(options.autonomy, options.sandboxed, options.cwd);
    this.out = new BoundedOutboundQueue(
      options.sink ?? defaultEventSink(),
      (failure) => {
        // Both failure classes end the session (§4.2): the caller stopped
        // reading (overflow) or the sink itself failed (a closed pipe). A
        // codemux failure, not a harness one, but the end path is the
        // same; the diagnostic rides on stderr.
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
        void this.finish("crash", 1);
      }
    );
    this.signals = this.stopEscalation.install(
      () => void this.finish("signal", SESSION_SIGNAL_EXIT_CODE),
      () => [this.proc]
    );
  }

  /** Every end path's funnel (§4.6); the final class owns it
   * (src/session/codex-driver.ts). */
  protected abstract finish(reason: SessionEndReason, exitCode: number): Promise<void>;

  /** One line from the harness stdout
   * (src/session/codex-driver-events.ts). */
  abstract handleHarnessLine(line: string): void;

  /** One framed line from the caller's stdin
   * (src/session/codex-driver-input.ts). */
  abstract handleCallerLine(line: string): void;

  /** Forget and clear the open turn timer (src/session/codex-turns.ts). */
  protected abstract clearTurnTimer(): void;

  /** The session id events carry (src/session/codex-ledger.ts). */
  protected abstract sessionIdOrEmpty(): string;

  /** Set between spawnPending() and attach()/spawnAbandoned(): an end
   * path that begins inside that window holds at the late-child wait in
   * finish until one answers, so session never reports ended while its
   * child is still being born (review round 64). */
  private lateChild: Promise<SessionProcess | null> | null = null;
  private resolveLateChild: ((proc: SessionProcess | null) => void) | null = null;

  /** The CLI calls this immediately before its spawn, whose preflight
   * is async: a signal delivered there starts the end path with no
   * child to stop yet. */
  spawnPending(): void {
    this.lateChild = new Promise((resolve) => {
      this.resolveLateChild = resolve;
    });
  }

  /** The CLI's spawn ended without a child (it threw): an end path
   * waiting on the late child proceeds with none. */
  spawnAbandoned(): void {
    this.resolveLateChild?.(null);
    this.resolveLateChild = null;
  }

  /** True once an end path has begun: the spawn-throw catch hands the
   * ending to that path (round 20, minor 8; review round 65). */
  endPathStarted(): boolean {
    return this.finished;
  }

  /** The spawn-throw catch's exit once endPathStarted() is true: the end
   * path owns the ending — session_ended and the record's release in
   * its own ordering — so await its verdict and leave through the
   * session's exit code; a rethrow would release the record twice
   * (review round 65). */
  async finishAfterSpawnThrow(error: unknown): Promise<void> {
    reportSpawnThrow(error);
    const code = await this.done;
    this.dispose();
    process.stdin.destroy();
    process.exitCode = code;
  }

  /** The pending-spawn wait an end path holds when it begins before
   * attach(): resolves with the stopped child, null when the spawn
   * abandoned, and is null when no spawn was pending. */
  protected awaitLateChild(): Promise<SessionProcess | null> | null {
    return this.lateChild;
  }

  /** Hand the driver the spawned process; lines that arrived before this
   * run are replayed in order. */
  attach(proc: SessionProcess): void {
    this.proc = proc;
    // A signal between construction and this call finished the driver with
    // no child to stop (the CLI's spawn runs an async compatibility probe
    // before it attaches). The end path waiting on this child drains it
    // the way every shutdown does, EOF first, the grace, then the stop
    // request, and awaits its settlement before the record release and
    // session_ended (review round 64); an immediate SIGTERM here turned a
    // child that would have exited on EOF into a harness failure (round
    // 69).
    if (this.finished && this.resolveLateChild === null) {
      // No end path waits for this child (the end completed with no spawn
      // pending): nothing will drain it, so it is stopped at once or it
      // outlives the session it was spawned for.
      if (!this.stopEscalation.escalateIfRequested(proc)) proc.requestStop();
      return;
    }
    this.resolveLateChild?.(proc);
    this.resolveLateChild = null;
  }

  /** The main wait: resolves with codemux's exit code when the session
   * has fully ended (every end path funnels through `finish`). */
  async run(): Promise<number> {
    const proc = this.proc;
    if (proc === null) throw new Error("attach() must be called before run()");
    if (this.finished) return this.done;
    void proc.exited.then((outcome) => {
      // An exit codemux did not initiate: the crash path (§4.6).
      if (this.finished) return;
      this.emitError(
        true,
        "harness",
        `the codex process exited unexpectedly ` +
          `(code ${outcome.code ?? "null"}, signal ${outcome.signal ?? "none"}; ` +
          "its stderr is passed through on codemux's stderr)"
      );
      void this.finish("crash", 1);
    });
    if (this.options.sessionTimeoutMs !== null) {
      this.sessionTimer = setTimeout(
        () => void this.finish("timeout", 1),
        this.options.sessionTimeoutMs
      );
      this.sessionTimer.unref?.();
    }
    while (this.earlyLines.length > 0) {
      const line = this.earlyLines.shift() as string;
      this.handleHarnessLine(line);
    }
    // An early line that ended the session (a tier-3 fatal) leaves no
    // handshake to start (review live23).
    if (this.finished) return this.done;
    // The handshake codemux owns (§4.7): initialize, the initialized
    // notification, then the thread. The thread request goes out on the
    // initialize response so the fake and the real server see the same
    // ordering the fixture recorded.
    this.call("initialize", (id) => buildInitializeRequest(id));
    return this.done;
  }

  /** A tier-3 fatal from the process layer (non-UTF-8, line overflow). */
  handleFatal(fatal: SessionFatal): void {
    if (this.settled) return;
    if (fatal.kind === "handler" || fatal.kind === "read-error") {
      console.error(`codemux: ${codemuxFatalMessage(fatal)}`, fatal.error);
      this.emitError(true, "codemux", codemuxFatalMessage(fatal));
      void this.finish("crash", 1);
      return;
    }
    this.emitError(
      true,
      "harness",
      `unusable harness output (${fatal.kind}, ${fatal.bytes} bytes): ${fatal.excerpt}`
    );
    void this.finish("crash", 1);
  }

  dispose(): void {
    this.signals.dispose();
    this.clearTimers();
  }

  /** Queue one event line. The session's end events (the option) ride
   * the queue's terminal lane (round al32): session_ended and the fatals
   * that end the session reach the caller even when the ordinary bounds
   * refuse everything else, while turn_completed and the input acks are
   * ordinary entries that drop with the rest. Two terminal classes
   * (round al35, edges major 4): `terminal: true` is session_ended
   * alone, and `terminal: "fatal"` is a fatal, so the lane reserves its
   * last slot for the end event and a flood of fatals cannot take it.
   * The enqueue's boolean is deliberately ignored — a refused line has
   * already fired the queue's own failure callback, which starts the
   * crash end; a terminal line is refused only when its lane class is
   * full, and the overflow that reports starts the same end. */
  protected emit(line: string, options?: { terminal?: boolean | "fatal" }): void {
    this.out.enqueue(line, options);
  }

  protected ack(inputSeq: number, accepted: boolean, reason?: InputRejectionReason): void {
    this.emit(
      buildInputAck(++this.seq, this.sessionIdOrEmpty(), inputSeq, accepted, reason)
    );
  }

  /** Tier 2 (§4.2): a harness line that breaks the stream's grammar
   * still goes out raw, then the fatal names the violation (review
   * live21, the claude-family sibling). A null line is the
   * response-adoption path, codemux-originated, with nothing to mirror. */
  protected emitGrammarViolation(rawLine: string | null, message: string): void {
    if (rawLine !== null) {
      this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
    }
    this.emitError(true, "harness", message);
  }

  protected emitError(
    fatal: boolean,
    source: "codemux" | "harness",
    message: string
  ): void {
    if (fatal && this.firstFatal === null) this.firstFatal = message;
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "error", null, {
        fatal,
        source,
        message,
      }),
      // A fatal rides the lane's fatal class (capped one slot short of
      // the lane), so the slot the end event needs survives a flood of
      // them (round al35, edges major 4).
      { terminal: fatal ? "fatal" : undefined }
    );
  }

  protected writeToHarness(line: string): boolean {
    const proc = this.proc;
    if (proc === null) return false;
    const result = proc.writeLine(line);
    if (!result.ok) {
      // A line that cannot reach the harness after its ack is a codemux
      // failure, not a diagnostic: the turn or approval it belongs to
      // would hang open with no way for the caller to know. Writes that
      // land after `finished` (an already-ending session) stay silent —
      // the end path owns that window.
      if (this.finished) return false;
      this.emitError(
        true,
        "codemux",
        `could not deliver a line to the harness (${result.reason ?? "unknown"})`
      );
      void this.finish("crash", 1);
      return false;
    }
    return true;
  }

  /** Send one request under the next integer id and remember what it
   * waits on. Returns the id, so the caller that needs to match its own
   * response or rejection to this exact call can (the interrupt state,
   * review live11), or null when the write was refused (no response can
   * then arrive, so nothing is left pending). The call is registered
   * only after the write succeeds: a refused write starts the crash end
   * synchronously, and a `turn_start` still registered then made the end
   * path queue its interrupt behind a response that could never come and
   * wait the whole grace (review live25). No response can arrive between
   * the write and the registration, because both run in one tick. */
  protected call(kind: PendingCall, build: (id: number) => string): number | null {
    this.requestCounter += 1;
    const id = this.requestCounter;
    if (!this.writeToHarness(build(id))) return null;
    this.pendingCalls.set(id, kind);
    return id;
  }

  protected clearTimers(): void {
    this.clearTurnTimer();
    if (this.sessionTimer !== null) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    this.pendingTimers.clear();
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
