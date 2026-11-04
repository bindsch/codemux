/**
 * The agy driver's shared state and wire plumbing: the constructor, the
 * options record, the outbound event queue, and the emit/ack/write helpers
 * every side of the driver speaks through. src/session/agy-driver.ts owns
 * the lifecycle.
 */

import { randomUUID } from "node:crypto";
import { reportSpawnThrow } from "./stdin-frame.js";
import type { AutonomyLevel, ReasoningEffort, ResultUsageBlock } from "../types.js";
import { providerHost, type SessionCallContext } from "../call-log.js";
import { emptyUsage } from "../result-envelope.js";
import { agySessionCapabilities } from "./agy-session.js";
import { SessionFsm } from "./fsm.js";
import {
  BoundedOutboundQueue,
  codemuxFatalMessage,
  installSessionSignalHandlers,
  SESSION_SIGNAL_EXIT_CODE,
  type SessionFatal,
  type SessionProcess,
  type SessionSignalGate,
} from "./process.js";
import { buildEvent, buildInputAck, type InputRejectionReason } from "./protocol.js";
import type { SandboxTrust } from "./registry.js";

export interface AgyDriverOptions {
  /** The conversation id to resume, or null to start fresh. */
  resumeConversationId: string | null;
  autonomy: AutonomyLevel;
  model?: string;
  effort?: ReasoningEffort;
  /** The validated working directory — also the registry's cwd record. */
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
  sessionTimeoutMs: number | null;
  /** Null disables registry writes (unit tests); the CLI always passes one. */
  registryPath: string | null;
  /** The harness state home recorded for this session (§4.8). */
  harnessHome: string;
  /** The provider identity recorded for the resume guard (review D3):
   * the override's base URL, or null for the operator's own login. agy
   * refuses overrides outright, so the CLI's value is always null —
   * wired uniformly so the record cannot drift from the guard. */
  providerBaseUrl: string | null;
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

type Timer = ReturnType<typeof setTimeout>;

export abstract class AgyDriverIo {
  protected readonly fsm = new SessionFsm();
  protected readonly capabilities = agySessionCapabilities();
  protected readonly out: BoundedOutboundQueue;
  protected readonly signals: SessionSignalGate;
  protected proc: SessionProcess | null = null;
  protected readonly earlyLines: string[] = [];
  protected seq = 0;
  protected turnCounter = 0;
  /** The conversation id: harness-issued, adopted from the first result
   * envelope that names it (a fresh session), or the registry-vouched
   * resume id adopted at spawn. Null until one of those lands. */
  protected conversationId: string | null;
  /** Codemux's own id for this session, minted at construction: what the
   * call ledger records while no result frame has named the conversation
   * (and ever after, if none ever does), so id-less sessions never share
   * a key (review ul6). */
  private readonly codemuxSessionId = randomUUID();
  /** Starts unknown (all-null), not zero: a counter a turn never reports
   * must stay null rather than be guessed as 0 (§4.2). */
  protected cumulative: ResultUsageBlock = emptyUsage();
  protected registryRecorded = false;
  /** The CLI claimed the record for a resume before the spawn
   * (`adoptResumeClaim`): every end path releases the claim, and one
   * that ended cleanly before the session start still reports the
   * session resumable (review live20). */
  protected resumeClaimed = false;
  /** A result named this conversation: the harness confirmed it. A
   * resumed session records at spawn, from the registry-vouched id, so
   * the record alone does not prove agy can load the conversation
   * (review live21). */
  protected harnessConfirmed = false;
  /** Whether a failed turn-path registry stamp already warned: the touch
   * is best-effort and never waits (review live13), so sustained
   * contention would otherwise repeat the same stderr line every turn. */
  protected touchWarned = false;
  protected finished = false;
  /** The end path's exit code, updatable while cleanup drains: a failure
   * arriving inside the grace window (a tier-3 fatal, a handler exception,
   * a registry failure) must still cost success — `finish` stays
   * idempotent, the verdict does not freeze until the child settles
   * (review live7). Monotone: only a higher code ever wins. */
  protected endExitCode = 0;
  /** True only once the end path has settled the child: harness lines
   * keep flowing (and keep being parsed and emitted) through the whole
   * shutdown drain, because the grace window exists precisely so the
   * harness can finish persisting and say so — a final result envelope
   * arriving during it must reach the caller, not vanish because
   * `finish` began (review live5). `finished` alone is the end path's
   * re-entry guard and flips at its start. */
  protected settled = false;
  protected stdinClosed = false;
  /** The first fatal the session reported, carried by a crash end's
   * synthesized turn completion (review live17). */
  protected firstFatal: string | null = null;
  private sessionTimer: Timer | null = null;
  /** The wall clock each open turn started at, keyed by turn id: the
   * ledger's session_turn records carry each turn's own duration. */
  protected readonly turnStartedAt = new Map<string, number>();
  /** The session's own start, for the closing ledger record's duration. */
  protected readonly sessionStartedAt = Date.now();
  /** The launch facts the call ledger records on every turn and at the
   * end (call-log.ts); agy refuses overrides, so the provider is always
   * "default". */
  protected readonly callLedger: SessionCallContext;
  private readonly done: Promise<number>;
  protected resolveDone!: (code: number) => void;

  constructor(protected readonly options: AgyDriverOptions) {
    this.done = new Promise<number>((resolve) => {
      this.resolveDone = resolve;
    });
    this.conversationId = options.resumeConversationId;
    this.callLedger = {
      agent: "agy",
      model: options.model ?? null,
      provider: providerHost(options.providerBaseUrl),
      autonomy: options.autonomy,
      hermetic: false,
      sandboxed: options.sandboxed,
      cwd: options.cwd,
    };
    this.out = new BoundedOutboundQueue(
      options.sink ?? defaultEventSink(),
      (failure) => {
        // Both failure classes end the session (§4.2): the caller stopped
        // reading (overflow) or the sink itself failed (a closed pipe). A
        // codemux failure, not a harness one, but the end path is the same
        // and the final events may not fit — the diagnostic rides on
        // stderr.
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
    this.signals = installSessionSignalHandlers(() => {
      void this.finish("signal", SESSION_SIGNAL_EXIT_CODE);
    });
  }

  /** Every end path's funnel (§4.6); src/session/agy-finalize.ts owns it. */
  protected abstract finish(
    reason: SessionEndReason,
    exitCode: number
  ): Promise<void>;

  /** One line from the harness stdout (src/session/agy-turns.ts). */
  abstract handleHarnessLine(line: string): void;

  /** The deferred session_started announcement and its registry record
   * (src/session/agy-finalize.ts). */
  protected abstract announceSessionStarted(): void;

  /** Set between spawnPending() and attach()/spawnAbandoned(): an end
   * path that begins inside that window holds at the late-child wait in
   * finish until one of them answers, so the record release,
   * session_ended, and run()'s resolution never report the session ended
   * while its child is still being born (review round 64; the claude
   * driver's round 18 rule). */
  private lateChild: Promise<SessionProcess | null> | null = null;
  private resolveLateChild: ((proc: SessionProcess | null) => void) | null = null;

  /** The CLI calls this immediately before its spawn, whose preflight is
   * async: a signal delivered there starts the end path with no child to
   * stop, and the end path must not release the resume record and emit
   * session_ended before the child that needs stopping exists. */
  spawnPending(): void {
    this.lateChild = new Promise((resolve) => {
      this.resolveLateChild = resolve;
    });
  }

  /** The CLI's spawn ended without a child (it threw): an end path
   * waiting on the late child proceeds with none — this invocation never
   * ran its harness. */
  spawnAbandoned(): void {
    this.resolveLateChild?.(null);
    this.resolveLateChild = null;
  }

  /** True once an end path has begun: the CLI's spawn-throw catch hands
   * the ending to that path (round 20, minor 8; review round 65). */
  endPathStarted(): boolean {
    return this.finished;
  }

  /** The spawn-throw catch's exit once endPathStarted() is true: the end
   * path owns the ending — session_ended and the record's release inside
   * its own ordering, over the late child spawnAbandoned() answered with
   * none — so await its verdict and leave through the session's exit
   * code; a rethrow would release the record a second time and exit the
   * process hard first (review round 65). */
  async finishAfterSpawnThrow(error: unknown): Promise<void> {
    reportSpawnThrow(error);
    const code = await this.done;
    this.dispose();
    process.stdin.destroy();
    process.exitCode = code;
  }

  /** The pending-spawn wait an end path holds when it begins before
   * attach(): resolves with the child once it has settled (attach()
   * stopped it first), with null when the spawn abandoned, and is null
   * when no spawn was pending. */
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
      proc.requestStop();
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
        `the agy process exited unexpectedly ` +
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
    // An early line that ended the session (a tier-3 fatal) must not be
    // followed by a resumed session's start or its record (review live23).
    if (this.finished) return this.done;
    if (this.conversationId !== null) {
      // A resumed session knows its identity at spawn: the id is
      // registry-vouched caller input, and the first result only has to
      // agree with it (the parser's mismatch check).
      const error = this.fsm.transition({ kind: "session_started" });
      if (error !== null) {
        this.emitError(true, "harness", error.message);
        void this.finish("crash", 1);
        return this.done;
      }
      this.announceSessionStarted();
    }
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

  // --- helpers -----------------------------------------------------------

  /** Events before the first identity-bearing fact carry an empty
   * session id — the alternative would be buffering the first user line
   * forever, since its result is what names the conversation. */
  protected sessionIdOrEmpty(): string {
    return this.conversationId ?? "";
  }

  /** The id the call ledger keys this session's records by: the harness's
   * own conversation id once a result frame has named one (the registry
   * key, stable across a resume), else the codemux-minted id every session
   * owns from construction — never "", which merged every id-less session
   * under one key in `calls --sum` (review ul6). */
  protected ledgerSessionId(): string {
    return this.conversationId || this.codemuxSessionId;
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

  protected writeToHarness(line: string): void {
    const proc = this.proc;
    if (proc === null) return;
    const result = proc.writeLine(line);
    if (!result.ok) {
      // A line that cannot reach the harness after its ack is a codemux
      // failure, not a diagnostic: the turn it belongs to would hang open
      // with no way for the caller to know. Writes that land after
      // `finished` (an already-ending session) stay silent — the end path
      // owns that window.
      if (this.finished) return;
      this.emitError(
        true,
        "codemux",
        `could not deliver a line to the harness (${result.reason ?? "unknown"})`
      );
      void this.finish("crash", 1);
    }
  }

  protected clearTimers(): void {
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
