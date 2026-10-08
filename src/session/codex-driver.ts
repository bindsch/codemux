/**
 * The codex app-server session driver (design §4.7): the launcher-owned
 * context that turns one SessionProcess plus the caller's stdin into the
 * event stream. All per-run state lives here — the FSM, the JSON-RPC
 * request correlation, the parser, the pending-approval timers, the
 * output queue, the registry writes — never on a singleton adapter. The
 * driver never throws across the stream: every failure is an event, an
 * end path, or both.
 *
 * Turn model: the caller sees codemux-local turn ids t1, t2, … assigned
 * the moment an input is submitted from idle (the `user_message` echo
 * carries its turn synchronously); the driver maps that to the harness
 * turn id from the turn/start response. The caller-facing `turn_started`
 * event is emitted at submit, immediately after the FSM opens the turn —
 * the same place the claude family emits its own — so every completion
 * path (the wire's turn/completed, a failed turn/start, a synthesized
 * interruption at session end) answers a start the caller actually saw;
 * a turn/start that never answers leaves an orphan completion (review
 * live15). The harness's turn/started notification still parses under
 * the grammar checks but mirrors as tier-1 unknown, like every other
 * harness echo of something codemux already announced. Mid-turn input
 * queues in the codemux-side FIFO (`user_during_turn: "queue"`); steering
 * and interrupts ride turn/steer and turn/interrupt once the harness
 * turn id is known — before that they buffer and flush on the response.
 */

import type { AutonomyLevel, ReasoningEffort, ResultUsageBlock } from "../types.js";
import { emptyUsage } from "../result-envelope.js";
import {
  buildInitializeRequest,
  buildInitializedNotification,
  buildInterruptRequest,
  buildJsonRpcErrorResponse,
  buildJsonRpcResponse,
  buildSteerRequest,
  buildThreadResumeRequest,
  buildThreadStartRequest,
  buildTurnStartRequest,
  CODEX_THREAD_ID_PATTERN,
  codexApprovalCeiling,
  codexSessionCapabilities,
  CodexStreamParser,
  type CodexApprovalKind,
  type CodexParse,
  type CodexSessionPolicy,
  codexSessionPolicy,
  offersRefusal,
  pickApprovalDecision,
  type RequestId,
} from "./codex-session.js";
import { SessionFsm } from "./fsm.js";
import {
  awaitFinalFlush,
  BoundedOutboundQueue,
  callerStdinFailure,
  codemuxFatalMessage,
  crashSynthesisReason,
  drainFailureMessage,
  SESSION_SIGNAL_EXIT_CODE,
  harnessLineDeliverable,
  harnessTextDeliverable,
  installSessionSignalHandlers,
  MAX_PENDING_EVENT_BYTES,
  MAX_PENDING_EVENTS,
  type SessionFatal,
  type SessionProcess,
  type SessionSignalGate,
} from "./process.js";
import {
  applyAuthorPrefix,
  buildEvent,
  buildInputAck,
  buildPermissionResolved,
  buildUnknownEvent,
  buildUserMessage,
  parseInputLine,
  type InputMessage,
  type InputRejectionReason,
} from "./protocol.js";
import {
  releaseSessionRecord,
  recordSessionStart,
  touchSession,
  type SandboxTrust,
} from "./registry.js";
import { accumulateUsage, addTurnUsage } from "./usage.js";

/** Bounds on each in-memory hold of caller input (review live19): the
 * lines parked behind the handshake, the user inputs queued behind an
 * open turn, and the steer texts held until the harness names its turn.
 * A quarter of the outbound queue's count: the replay or the end path
 * answers the whole parked buffer in one synchronous burst of up to
 * three events per line, which must fit the queue rather than overflow
 * it. */
export const MAX_HELD_INPUT_LINES = MAX_PENDING_EVENTS / 4;
export const MAX_HELD_INPUT_BYTES = MAX_PENDING_EVENT_BYTES / 2;

/** Whether one more text fits a hold under both bounds. */
function heldInputFits(held: readonly string[], next: string): boolean {
  if (held.length >= MAX_HELD_INPUT_LINES) return false;
  let bytes = Buffer.byteLength(next);
  for (const text of held) bytes += Buffer.byteLength(text);
  return bytes <= MAX_HELD_INPUT_BYTES;
}

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
   * override session starts in a fresh run-shaped CODEX_HOME whose final
   * (resume-computed) path names the thread (codex-provider.ts). Preferred
   * over `harnessHome` at the record, and only once the id exists. */
  harnessHomeFor?: (sessionId: string) => string;
  /** The end-of-session settlement of a per-session harness home (the
   * codex override session home's `settle`, codex-provider.ts), called
   * once from the end path after the child settled and the resumable
   * verdict is known. Returns whether the home ended where a resume
   * finds it; the reported `resumable` is false without it (review D2,
   * correctness-2 2). Never throws out of the end path. */
  settleSessionHome?: (sessionId: string | null, resumable: boolean) => boolean;
  /** Injectable event sink; defaults to codemux stdout, one line each. */
  sink?: (line: string) => Promise<void> | void;
}

export type SessionEndReason =
  | "shutdown"
  | "stdin-close"
  | "signal"
  | "timeout"
  | "crash";

/** What one outstanding codemux-originated request is waiting on. */
type PendingCall =
  | "initialize"
  | "thread_start"
  | "thread_resume"
  | { kind: "turn_start"; turnId: string }
  /** The caller lines one steer request carries, so a rejection names
   * them (review live23). */
  | { kind: "steer"; inputSeqs: number[]; turnId: string | null }
  | "interrupt";

type Timer = ReturnType<typeof setTimeout>;

/** How many closed harness turn ids are kept for straggler matching. */
const CLOSED_TURN_IDS_KEPT = 1024;

export class CodexSessionDriver {
  private readonly fsm = new SessionFsm();
  private readonly parser = new CodexStreamParser();
  private readonly capabilities = codexSessionCapabilities();
  private readonly policy: CodexSessionPolicy;
  private readonly out: BoundedOutboundQueue;
  private readonly pendingTimers = new Map<string, Timer>();
  /** The approval facts the ceiling judges; membership lives in the FSM.
   * The wire id keeps its original type — numeric ids must be answered
   * numerically for the server to correlate the reply (JSON-RPC). */
  private readonly pendingApprovals = new Map<
    string,
    { id: RequestId; kind: CodexApprovalKind; input: Record<string, unknown> }
  >();
  /** Codemux-originated JSON-RPC requests awaiting their response. */
  private readonly pendingCalls = new Map<number, PendingCall>();
  private proc: SessionProcess | null = null;
  private readonly earlyLines: string[] = [];
  /** Caller lines that arrived before the thread existed; replayed once
   * session_started fires so their acks and echoes carry the thread id.
   * Two event classes in that window carry the empty id: the
   * starting-state shutdown path's ack and its `shutting_down`
   * rejections of lines parked ahead of it (see `handleCallerLine`),
   * which must end the session without waiting for a handshake that may
   * never answer, and the end path's `shutting_down` rejections of
   * whatever the replay never reached (see `finish`, review live10). */
  private readonly preSessionLines: string[] = [];
  /** The parked lines' bytes, bounded with their count: a handshake
   * that never answers must not let the caller grow codemux's memory
   * without limit. */
  private preSessionBytes = 0;
  /** User inputs accepted mid-turn, submitted as turns in order. */
  private readonly turnQueue: { text: string; inputSeq: number }[] = [];
  /** Steer texts held until the harness turn id is known; flushed as one
   * batched turn/steer. */
  private readonly steerBuffer: Array<{ text: string; inputSeq: number }> = [];
  private readonly signals: SessionSignalGate;
  private seq = 0;
  private turnCounter = 0;
  private requestCounter = 0;
  /** The thread id: the codemux session id. Null on a fresh thread until
   * the thread/start response (or thread/started) names it. */
  private threadId: string | null;
  /** The harness turn id of the open turn, from the turn/start response;
   * null while no turn is open and while a turn/start request is still
   * in flight (steers and interrupts buffer until it is named). */
  private harnessTurnId: string | null = null;
  /** The harness ids of turns that closed: a usage, item, or delta
   * notification naming one after its `turn/completed` is late, not the
   * open turn's (review live18), even once a later turn is named (the
   * parser's `closedTurnIds`, review live20). Every closed turn is kept,
   * not only the last (review live23), bounded to the most recent
   * CLOSED_TURN_IDS_KEPT. */
  private readonly closedHarnessTurnIds = new Set<string>();
  private queuedInputs = 0;
  private interruptQueued = false;
  /** The input_seq of a caller interrupt riding the turn/start response,
   * so a delivery the harness refuses then names the line it acked
   * (review live23); null for the timeout's and the end path's own. */
  private interruptQueuedSeq: number | null = null;
  private interruptFromTimeout = false;
  /** The request id of the interrupt call in flight, so a stale rejection
   * — a call whose turn already completed while a later turn's interrupt
   * is pending — clears nothing but itself (review live11). */
  private interruptCallId: number | null = null;
  private turnUsage: ResultUsageBlock | null = null;
  /** Starts unknown (all-null), not zero: a counter a turn never reports
   * must stay null rather than be guessed as 0 (§4.2). */
  private cumulative: ResultUsageBlock = emptyUsage();
  private registryRecorded = false;
  /** The CLI claimed the record for a resume before the spawn
   * (`adoptResumeClaim`): every end path releases the claim and reports
   * the session resumable, even one that ended before the session start
   * (review live20). */
  private resumeClaimed = false;
  /** Whether a failed turn-path registry stamp already warned: the touch
   * is best-effort and never waits (review live13), so sustained
   * contention would otherwise repeat the same stderr line every turn. */
  private touchWarned = false;
  private finished = false;
  /** The end path's exit code, updatable while cleanup drains: a failure
   * arriving inside the grace window (a tier-3 fatal, a handler exception,
   * an unknown-response-id fatal, a registry failure) must still cost
   * success — `finish` stays idempotent, the verdict does not freeze
   * until the child settles (review live7). Monotone: only a higher code
   * ever wins. */
  private endExitCode = 0;
  /** True only once the end path has settled the child: harness lines
   * keep flowing (and keep being parsed and emitted) through the whole
   * shutdown drain, because the grace window exists precisely so the
   * harness can finish persisting and say so — the interrupted turn's
   * completion and its usage arrive during it and must reach the caller
   * (review live5). `finished` alone is the end path's re-entry guard
   * and flips at its start. */
  private settled = false;
  private stdinClosed = false;
  /** The first fatal the session reported, carried by a crash end's
   * synthesized turn completion (review live17). */
  private firstFatal: string | null = null;
  /** Whether the open turn's `--turn-timeout` already fired its
   * interrupt; a second expiry on the same turn ends the session. */
  private turnTimeoutFired = false;
  private turnTimer: Timer | null = null;
  private sessionTimer: Timer | null = null;
  private readonly done: Promise<number>;
  private resolveDone!: (code: number) => void;

  constructor(private readonly options: CodexDriverOptions) {
    this.done = new Promise<number>((resolve) => {
      this.resolveDone = resolve;
    });
    this.threadId = options.resumeThreadId;
    this.policy = codexSessionPolicy(options.autonomy, options.sandboxed, options.cwd);
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

  /** Hand the driver the spawned process; lines that arrived before this
   * run are replayed in order. */
  attach(proc: SessionProcess): void {
    this.proc = proc;
    // A signal between construction and this call finished the driver with
    // no child to stop (the CLI's spawn runs an async compatibility probe
    // before it attaches); the child arriving now must be stopped at once
    // or it outlives the session it was spawned for.
    if (this.finished) proc.requestStop();
  }

  /** The CLI's resume claim succeeded: this process owns the record from
   * now on, whether or not the session start is ever reached. */
  adoptResumeClaim(): void {
    this.resumeClaimed = true;
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

  /** One line from the harness stdout. Never throws. Lines are parsed and
   * emitted until the end path settles (`settled`): the shutdown grace
   * window is exactly the interval in which the harness's last output —
   * the end-interrupt's response, the interrupted turn's completion, its
   * usage — is still arriving, and dropping it there would report a
   * session that ended mid-sentence. */
  handleHarnessLine(line: string): void {
    if (this.proc === null) {
      this.earlyLines.push(line);
      return;
    }
    if (this.settled) return;
    const wasEnding = this.finished;
    const parses = this.parser.feed(line, {
      threadId: this.threadId,
      activeTurnId: this.harnessTurnId,
      closedTurnIds: this.closedHarnessTurnIds,
    });
    for (const parse of parses) {
      this.applyParse(parse, line);
      // A parse that started the end path ends this line's application;
      // parses that arrive while an already-running end path drains still
      // apply, all the way to settlement.
      if (this.settled || (!wasEnding && this.finished)) return;
    }
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

  /** One framed line from the caller's stdin. Never throws. */
  handleCallerLine(line: string): void {
    if (line.trim() === "") return;
    if (this.finished) {
      // The input contract (§4.1): every line is answered, an end path
      // included — during the drain window (`finished` and not yet
      // `settled`) the answer is the `shutting_down` rejection (review
      // live9; a repeated shutdown during the drain is the same honest
      // no-op notification). Once `settled`, `session_ended` is already
      // on the stream and nothing may follow it, so later lines drop.
      if (!this.settled) this.ack(this.fsm.nextInputSeq(), false, "shutting_down");
      return;
    }
    // Before session_started nothing can be answered: a fresh thread's id
    // may be known from the response while the session event has not
    // fired, and a turn submitted then would break the FSM's grammar.
    // Buffer the line whole and replay it once session_started fires —
    // except shutdown: a stalled handshake must not hold the graceful end
    // hostage (an initialize that never answers has no session to keep).
    if (this.fsm.state === "starting") {
      const early = parseInputLine(line, {
        capabilities: this.capabilities,
        hasActiveTurn: false,
        pendingRequestIds: new Set(this.fsm.pendingIds),
        shuttingDown: this.stdinClosed,
      });
      if (early.ok && early.message.type === "shutdown") {
        // Parked lines are rejected first, in arrival order (review
        // live14): the acks must not reorder around the shutdown's, or a
        // broker matching them by order reads the earlier user line's
        // rejection as the shutdown's answer. finish() drains the same
        // buffer the same way, so the pair stays idempotent.
        while (this.preSessionLines.length > 0) {
          this.preSessionLines.shift();
          this.ack(this.fsm.nextInputSeq(), false, "shutting_down");
        }
        this.preSessionBytes = 0;
        this.ack(this.fsm.nextInputSeq(), true);
        void this.finish("shutdown", 0);
        return;
      }
      // The seq is assigned at replay, so the peek above must not count.
      this.preSessionLines.push(line);
      this.preSessionBytes += Buffer.byteLength(line);
      if (
        this.preSessionLines.length > MAX_HELD_INPUT_LINES ||
        this.preSessionBytes > MAX_HELD_INPUT_BYTES
      ) {
        // Over the bound, the session ends: rejecting this one line now
        // would give it an input_seq ahead of the parked lines it follows.
        // finish() rejects every parked line, this one included, in order.
        this.emitError(
          true,
          "codemux",
          `the caller sent more than ${MAX_HELD_INPUT_LINES} lines or ${MAX_HELD_INPUT_BYTES} bytes ` +
            "before the codex handshake completed"
        );
        void this.finish("crash", 1);
      }
      return;
    }
    const inputSeq = this.fsm.nextInputSeq();
    const parsed = parseInputLine(line, {
      capabilities: this.capabilities,
      hasActiveTurn: this.fsm.state === "turn_active",
      pendingRequestIds: new Set(this.fsm.pendingIds),
      shuttingDown: this.stdinClosed || this.fsm.state === "shutting_down" || this.fsm.state === "ended",
    });
    if (!parsed.ok) {
      this.ack(inputSeq, false, parsed.reason);
      return;
    }
    const message = parsed.message;
    switch (message.type) {
      case "user": {
        const harnessText = applyAuthorPrefix(
          message.text,
          message.author,
          this.options.authorPrefix
        );
        // Deliverability before the ack: the turn/start frame cannot be
        // built yet (the JSON-RPC id and thread id are assigned at send
        // time), so the check is the escaped literal plus a conservative
        // wrapper margin against the harness write cap.
        if (!harnessTextDeliverable(harnessText)) {
          this.ack(inputSeq, false, "text_too_long");
          return;
        }
        if (
          this.fsm.state !== "idle" &&
          !heldInputFits(this.turnQueue.map((entry) => entry.text), harnessText)
        ) {
          // The queue behind an open turn is bounded (review live19).
          this.ack(inputSeq, false, "busy");
          return;
        }
        this.ack(inputSeq, true);
        const turnId = this.fsm.state === "idle" ? this.submitTurn() : null;
        if (turnId === null) this.queuedInputs += 1;
        this.emit(
          buildUserMessage(
            ++this.seq,
            this.sessionIdOrEmpty(),
            inputSeq,
            message.text,
            message.author,
            turnId
          )
        );
        if (turnId !== null) {
          this.sendTurnStart(turnId, harnessText);
        } else {
          this.turnQueue.push({ text: harnessText, inputSeq });
        }
        return;
      }
      case "steer": {
        const harnessText = applyAuthorPrefix(
          message.text,
          message.author,
          this.options.authorPrefix
        );
        // Same pre-ack deliverability check (the steer frame carries the
        // escaped literal under the same write cap).
        if (!harnessTextDeliverable(harnessText)) {
          this.ack(inputSeq, false, "text_too_long");
          return;
        }
        if (
          this.harnessTurnId === null &&
          !heldInputFits(this.steerBuffer.map((entry) => entry.text), harnessText)
        ) {
          // Held until the harness names its turn, and bounded (review
          // live19).
          this.ack(inputSeq, false, "busy");
          return;
        }
        // Steer input is live mid-turn input, delivered as one batched
        // steer request. With the harness turn named it is written now,
        // before the ack: a refused write started the crash end, and the
        // line is rejected rather than acked for text the harness never
        // got (review live23). Otherwise it waits for the turn/start
        // response, and a later failure is reported by its input_seq.
        this.steerBuffer.push({ text: harnessText, inputSeq });
        this.flushSteer(inputSeq);
        if (this.finished) {
          this.rejectUndelivered(inputSeq);
          return;
        }
        this.ack(inputSeq, true);
        this.emit(
          buildUserMessage(
            ++this.seq,
            this.sessionIdOrEmpty(),
            inputSeq,
            message.text,
            message.author,
            this.fsm.activeTurn
          )
        );
        return;
      }
      case "interrupt": {
        // No active turn: an acknowledged no-op (§4.1).
        if (this.fsm.state !== "turn_active") {
          this.ack(inputSeq, true);
          return;
        }
        // §4.1: a pending approval is answered decline on interrupt,
        // before the turn closes (permission_resolved: "superseded").
        // The interrupt is written before the ack: a refused write
        // started the crash end, and an accepted ack would report an
        // interrupt the harness never got (review live23).
        // A refused decline above already started the end, whose own
        // interrupt must stay the pending one, so nothing more is written.
        this.supersedeApprovals();
        if (!this.finished) this.sendInterrupt();
        if (this.finished) {
          this.rejectUndelivered(inputSeq);
          return;
        }
        if (this.interruptQueued) this.interruptQueuedSeq = inputSeq;
        this.ack(inputSeq, true);
        return;
      }
      case "permission_decision": {
        this.applyPermissionDecision(inputSeq, message);
        return;
      }
      case "shutdown": {
        this.ack(inputSeq, true);
        void this.finish("shutdown", 0);
        return;
      }
    }
  }

  /** The caller closed stdin: the graceful end (§4.6), exit 0. A read
   * error is not a close: the same end path runs, but the failure is
   * reported and costs success (review live17). */
  handleCallerEnd(error?: unknown): void {
    this.stdinClosed = true;
    // `session_ended` is already on the stream once settled, and nothing
    // may follow it: a read error landing during the final flush goes to
    // stderr only (review live18).
    if (this.settled) {
      if (error !== undefined) console.error(`codemux: ${callerStdinFailure(error)}`);
      return;
    }
    if (this.finished) {
      // An end already began and owns the exit code: stdin is no longer
      // read, so a read error now loses nothing and is reported without
      // turning that end into a failure (review live22).
      if (error !== undefined) this.emitError(false, "codemux", callerStdinFailure(error));
      return;
    }
    if (error !== undefined) {
      this.emitError(true, "codemux", callerStdinFailure(error));
      void this.finish("stdin-close", 1);
      return;
    }
    void this.finish("stdin-close", 0);
  }

  dispose(): void {
    this.signals.dispose();
    this.clearTimers();
  }

  // --- harness side -----------------------------------------------------

  private applyParse(parse: CodexParse, rawLine: string): void {
    switch (parse.kind) {
      case "unusable":
        // Tier 3 (§4.2): the fatal report carries the excerpt; the line
        // itself is not mirrored (there is no event to preserve).
        this.emitError(
          true,
          "harness",
          `unusable harness output (not JSON, ${parse.bytes} bytes): ${parse.excerpt}`
        );
        void this.finish("crash", 1);
        return;
      case "grammar_error":
        // Tier 2: the raw event still goes out, then the fatal end.
        this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
        this.emitError(true, "harness", parse.message);
        void this.finish("crash", 1);
        return;
      case "response":
        this.applyResponse(parse.id, parse.result, rawLine);
        return;
      case "response_error":
        this.applyResponseError(parse.id, parse.message, rawLine);
        return;
      case "thread_started": {
        if (this.fsm.state !== "starting" || this.finished) {
          // The session already started — the resume path adopted it from
          // the thread/resume response (review live11) — or an end path
          // began mid-handshake and the codemux-initiated chain stopped
          // (review live15). A thread/started landing now is a benign
          // duplicate on the first path and a dead echo on the second:
          // tier-1 passthrough either way, never a fatal (the parser's
          // seen-once flag cannot know the driver adopted ahead of the
          // notification), and never an adoption or announcement.
          this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
          return;
        }
        if (this.threadId !== null && parse.threadId !== this.threadId) {
          // The mirror of the response-side cross-check: the thread
          // response may have adopted an id before this notification
          // arrived (the fresh path adopts from whichever comes first),
          // and one session cannot run under two ids (review live15).
          this.emitGrammarViolation(
            rawLine,
            `the app-server announced thread ${parse.threadId}, not the adopted ${this.threadId}`
          );
          void this.finish("crash", 1);
          return;
        }
        if (this.threadId === null) this.threadId = parse.threadId;
        this.announceSession(rawLine);
        return;
      }
      case "turn_started":
        // The caller's turn_started went out at submit; the harness's
        // notification is an echo of that announcement and mirrors as
        // tier-1 unknown, never silently dropped — the same rule as the
        // claude family's replay echo of codemux's own user line
        // (review live15).
        this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
        return;
      case "assistant_delta":
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "assistant_delta", rawLine, {
            delta: parse.text,
            turn_id: this.turnIdFor(parse.turnId),
          })
        );
        return;
      case "assistant_text":
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "assistant_message", rawLine, {
            text: parse.text,
            turn_id: this.turnIdFor(parse.turnId),
          })
        );
        return;
      case "tool_call":
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "tool_call", rawLine, {
            call_id: parse.callId,
            name: "commandExecution",
            input: parse.input,
          })
        );
        return;
      case "tool_result":
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "tool_result", rawLine, {
            call_id: parse.callId,
            output: parse.output,
            is_error: parse.isError,
          })
        );
        return;
      case "file_change":
        // Native on codex (§4.3): no `derived` marker.
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "file_change", rawLine, {
            path: parse.path,
            action: parse.action,
          })
        );
        return;
      case "usage": {
        // Per-turn accumulation for the open turn: the session cumulative
        // folds at turn completion (§4.2), so a notification is never
        // counted twice. A notification that belongs to no open turn — it
        // landed after its turn's `turn/completed`, with no turn open or
        // before the next turn's id is known — was being charged to the
        // NEXT turn (review live18). It is real usage, so it folds into
        // the session cumulative directly and its event carries a null
        // `turn_id`. While the open turn's harness id is known, the
        // parser has already checked the notification names it.
        // A notification naming the closed turn is late even after the
        // next turn's id is known: the parser accepts it as a straggler
        // then (review live20 — it was a grammar error that ended the
        // session when queued input opened the next turn at once).
        const forOpenTurn =
          this.fsm.state === "turn_active" &&
          !(typeof parse.turnId === "string" && this.closedHarnessTurnIds.has(parse.turnId)) &&
          (this.harnessTurnId !== null || typeof parse.turnId === "string");
        if (forOpenTurn) {
          this.turnUsage = accumulateUsage(this.turnUsage, parse.usage);
        } else {
          this.cumulative = addTurnUsage(this.cumulative, parse.usage);
        }
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "usage", rawLine, {
            turn_id: forOpenTurn ? this.fsm.activeTurn : null,
            usage: parse.usage,
          })
        );
        return;
      }
      case "turn_completed":
        this.completeTurn(parse, rawLine);
        return;
      case "permission_request": {
        if (
          parse.kindOfApproval === "commandExecution" &&
          !offersRefusal(parse.input["availableDecisions"])
        ) {
          // An approval whose availableDecisions carry neither "decline"
          // nor "cancel" has no refusal codemux may send, and a decision
          // the server did not offer could be rejected, leaving the
          // approval open and the turn hung after the caller had been
          // told deny (review live17). Such a request never reaches the
          // caller: it is answered with a JSON-RPC error (a protocol
          // answer, not a decision), passed through raw, and the turn is
          // interrupted so it cannot wait on it.
          // The raw line goes out before the answer: a refused write
          // ends the session, and its fatal must follow the line, with no
          // "answered" notice after it (review live23).
          this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
          const answered = this.writeToHarness(
            buildJsonRpcErrorResponse(
              parse.id,
              -32602,
              "codemux: the approval offered no refusal decision; refused"
            )
          );
          if (!answered) return;
          const interrupting = this.fsm.state === "turn_active" && !this.finished;
          this.emitError(
            false,
            "harness",
            `an approval request offered no refusal decision; it was answered with an error${interrupting ? " and the turn interrupted" : ""}`
          );
          if (interrupting) {
            this.supersedeApprovals();
            if (!this.finished) this.sendInterrupt();
          }
          return;
        }
        const error = this.fsm.addPending(parse.requestId);
        if (error !== null) {
          this.emitGrammarViolation(rawLine, error.message);
          void this.finish("crash", 1);
          return;
        }
        this.pendingApprovals.set(parse.requestId, {
          id: parse.id,
          kind: parse.kindOfApproval,
          input: parse.input,
        });
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "permission_request", rawLine, {
            request_id: parse.requestId,
            tool: parse.kindOfApproval,
            input: parse.input,
            options: this.allowDeliverable(parse.kindOfApproval, parse.input)
              ? ["allow", "deny"]
              : ["deny"],
          })
        );
        if (this.finished) {
          // The drain window: caller decisions are already refused and
          // the expiry timers are cleared with every other on the end
          // path, so a request landing now could never be decided — yet
          // the app-server waits on its answer inside the very grace
          // window that exists so it can persist. Decline it at once
          // with the same supersede treatment `finish` gave the
          // approvals it found pending (review live8).
          this.supersedeApprovals();
          return;
        }
        const timer = setTimeout(
          () => this.expireApproval(parse.requestId),
          this.options.permissionTimeoutMs
        );
        timer.unref?.();
        this.pendingTimers.set(parse.requestId, timer);
        return;
      }
      case "unparseable_approval": {
        // The request could not be judged, so it is declined — never
        // silently ignored — and the raw event reaches the caller with a
        // non-fatal error (§4.2: permission shapes never kill a session).
        // Raw line first, then the answer (review live23, as above).
        this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
        if (!this.writeToHarness(this.approvalDecline(parse.id, parse.method, null))) return;
        this.emitError(
          false,
          "harness",
          `an approval request could not be parsed and was declined (${parse.method})`
        );
        return;
      }
      case "server_request": {
        // A server request codemux does not implement: answered with a
        // JSON-RPC error and passed through raw — never silently
        // dropped (§4.7).
        // Raw line first, then the answer (review live23, as above).
        this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
        const answered = this.writeToHarness(
          buildJsonRpcErrorResponse(
            parse.id,
            -32601,
            `codemux does not implement ${parse.method}`
          )
        );
        if (!answered) return;
        this.emitError(
          false,
          "harness",
          `the app-server sent a request codemux does not implement (${parse.method}); it was answered with an error`
        );
        return;
      }
      case "unknown":
        this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
        return;
    }
  }

  /** Run the session-start machinery both start paths share: the FSM
   * transition, the registry record, the announcement, and the buffered
   * input replay. The announcement follows the record's verdict: a
   * required record that failed must not announce — §4.8's fail-closed
   * rule, nothing is vouchable — while a record that succeeded announces
   * even while an end path drains, so the registry and the caller agree
   * the session existed. A null registryPath records nothing and always
   * announces. `rawLine` is the notification the announcement mirrors on
   * the thread/started path, null on the response-adoption path
   * (codemux-originated). */
  private announceSession(rawLine: string | null): void {
    const error = this.fsm.transition({ kind: "session_started" });
    if (error !== null) {
      this.emitGrammarViolation(rawLine, error.message);
      void this.finish("crash", 1);
      return;
    }
    this.recordStart();
    if (
      this.settled ||
      (this.options.registryPath !== null && !this.registryRecorded)
    ) {
      return;
    }
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "session_started", rawLine, {
        agent: "codex",
        model: this.options.model ?? null,
        autonomy: this.options.autonomy,
        cwd: this.options.cwd,
        sandboxed: this.options.sandboxed,
        sandbox_trust: this.options.sandboxTrust,
        capabilities: this.capabilities,
        protocol: "codemux-live-session/1",
      })
    );
    while (this.preSessionLines.length > 0 && !this.finished) {
      this.handleCallerLine(this.preSessionLines.shift() as string);
    }
    this.preSessionBytes = 0;
    this.drainTurnQueue();
  }

  /** The model thread/start and thread/resume carry: `wireModel` when the
   * caller computed one (null sends none — the provider-override rule),
   * else `model`. */
  private threadWireModel(): string | undefined {
    const wire = this.options.wireModel;
    if (wire === null) return undefined;
    return wire ?? this.options.model;
  }

  private applyResponse(id: number | string, result: unknown, rawLine: string): void {
    // Request ids are matched strictly: codemux numbers every request it
    // sends, so a string id — even a numeric-looking "1" — is not the
    // reply to any call this driver made. `Number(id)` accepted it
    // (review live15).
    if (typeof id !== "number") {
      this.emitGrammarViolation(rawLine, `a response references unknown request id ${String(id)}`);
      void this.finish("crash", 1);
      return;
    }
    const pending = this.pendingCalls.get(id);
    if (pending === undefined) {
      // Tier 2: a response nothing asked for breaks the request/response
      // grammar the whole driver is built on.
      this.emitGrammarViolation(rawLine, `a response references unknown request id ${String(id)}`);
      void this.finish("crash", 1);
      return;
    }
    this.pendingCalls.delete(id);
    if (pending === "initialize" || pending === "thread_start" || pending === "thread_resume") {
      if (this.finished) {
        // The handshake is codemux's own continuation chain — initialize
        // answers into thread/start or thread/resume, which answers into
        // the announcement — and it stops the moment an end path began:
        // the response is consumed, nothing further is sent, adopted, or
        // recorded, and the caller's already-acked shutdown stays the
        // verdict. This is deliberately unlike the claude family's init
        // frame and agy's first result, which are harness-initiated
        // identity frames carrying the first real content and keep the
        // live5 announce-during-drain rule (review live15).
        return;
      }
    }
    if (pending === "initialize") {
      // Wire order, as the fixture recorded it: the initialized
      // notification, then the thread request.
      // A refused write started the crash end; the thread request would
      // follow it into a harness that stopped reading (review live23).
      if (!this.writeToHarness(buildInitializedNotification())) return;
      this.call(
        this.options.resumeThreadId === null ? "thread_start" : "thread_resume",
        (nextId) =>
          this.options.resumeThreadId === null
            ? buildThreadStartRequest(nextId, this.policy, this.options.cwd, this.threadWireModel())
            : buildThreadResumeRequest(
                nextId,
                this.options.resumeThreadId,
                this.policy,
                this.options.cwd,
                this.threadWireModel()
              )
      );
      return;
    }
    if (pending === "thread_start" || pending === "thread_resume") {
      const thread = (result as { thread?: unknown } | null)?.thread;
      const threadId = (thread as { id?: unknown } | null)?.id;
      if (typeof threadId !== "string" || threadId.length === 0) {
        this.emitGrammarViolation(rawLine, "the thread response carries no thread id");
        void this.finish("crash", 1);
        return;
      }
      // The registry key and the `--resume` argument: an id `--resume`
      // would refuse is refused here too (review live16).
      if (!CODEX_THREAD_ID_PATTERN.test(threadId)) {
        this.emitGrammarViolation(rawLine, "the thread response carries an invalid thread id");
        void this.finish("crash", 1);
        return;
      }
      if (pending === "thread_resume" && threadId !== this.options.resumeThreadId) {
        // The response's thread.id is the subscription proof — the echo
        // the reference clients of the same app-server validate — and it
        // was never checked: `threadId` is preset to the requested id at
        // construction, so the adopt-if-null below never ran for a
        // resume, and a server that resumed into a DIFFERENT thread left
        // codemux recording and announcing the requested id while the
        // harness ran another thread — later turn/start and steer
        // requests would go to an id the server may not hold (review
        // live12). Fail closed: name both ids and end.
        this.emitGrammarViolation(
          rawLine,
          `the app-server resumed thread ${threadId}, not the requested ${this.options.resumeThreadId}`
        );
        void this.finish("crash", 1);
        return;
      }
      if (this.threadId !== null && threadId !== this.threadId) {
        // The fresh-thread sibling of the resume echo check: a
        // thread/started notification may adopt the id BEFORE the
        // thread/start response answers (the starting-state path below),
        // and the response was then never compared with what was adopted
        // (review live15) — two ids for one session, with turn/start
        // aimed at whichever one this branch happened to keep. Fail
        // closed naming both, like the resume mismatch.
        this.emitGrammarViolation(
          rawLine,
          `the app-server started thread ${threadId}, not the announced ${this.threadId}`
        );
        void this.finish("crash", 1);
        return;
      }
      if (this.threadId === null) this.threadId = threadId;
      if (pending === "thread_resume" && this.fsm.state === "starting") {
        // The resume response is itself the subscription proof — its
        // thread.id echoes the requested id (checked above), which is
        // exactly what the reference clients of the same app-server
        // validate; none of them waits for a thread/started on resume,
        // and the real server does not send one there (re-proven live,
        // review live11). Start the session from the response; a late
        // thread/started (a server that announces anyway) passes through
        // as tier-1 unknown in the notification case above. A fresh
        // thread/start keeps waiting for the notification, which the
        // recorded fixture proves follows.
        this.announceSession(null);
      }
      return;
    }
    if (typeof pending === "object" && pending.kind === "turn_start") {
      const turn = (result as { turn?: unknown } | null)?.turn;
      const turnId = (turn as { id?: unknown } | null)?.id;
      if (typeof turnId !== "string" || turnId.length === 0) {
        // A success the server answered without naming its turn: the
        // turn may well be running, and without its id codemux can
        // neither interrupt nor steer it. Failing only the codemux turn
        // sent the next queued turn/start to a busy thread (review
        // live22), so the session ends instead; the end path stops the
        // child and synthesizes the failed completion.
        this.emitGrammarViolation(rawLine, "the turn/start response carries no turn id");
        void this.finish("crash", 1);
        return;
      }
      this.harnessTurnId = turnId;
      // An interrupt buffered while the harness turn id was unknown.
      if (this.interruptQueued) {
        this.interruptQueued = false;
        const queuedSeq = this.interruptQueuedSeq;
        this.interruptQueuedSeq = null;
        if (!this.deliverInterrupt() && queuedSeq !== null) {
          this.emitError(
            false,
            "codemux",
            `the interrupt accepted while the turn was starting (input_seq ${queuedSeq}) could not be delivered`
          );
        }
      }
      this.flushSteer();
      return;
    }
    // steer and interrupt responses carry nothing codemux needs.
  }

  private applyResponseError(id: number | string, message: string, rawLine: string): void {
    // Strict ids, as in applyResponse: codemux numbers its requests
    // (review live15).
    if (typeof id !== "number") {
      this.emitGrammarViolation(rawLine, `an error response references unknown request id ${String(id)}`);
      void this.finish("crash", 1);
      return;
    }
    const pending = this.pendingCalls.get(id);
    if (pending === undefined) {
      this.emitGrammarViolation(rawLine, `an error response references unknown request id ${String(id)}`);
      void this.finish("crash", 1);
      return;
    }
    this.pendingCalls.delete(id);
    if (pending === "initialize" || pending === "thread_start" || pending === "thread_resume") {
      if (this.finished) {
        // The success branch stops once an end path began (review
        // live15); its failure sibling does too — the session the caller
        // already ended does not become a crash because a handshake
        // response nobody waits for was an error.
        return;
      }
      // Tier 2: without the handshake the session never existed.
      this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
      this.emitError(true, "harness", `the app-server rejected the ${callLabel(pending)} request: ${message}`);
      void this.finish("crash", 1);
      return;
    }
    if (typeof pending === "object" && pending.kind === "turn_start") {
      this.failOpenTurn(message, rawLine);
      return;
    }
    // A steer or interrupt that failed: the turn keeps running; the
    // caller hears about it without losing the session. A rejected
    // interrupt never happened, so its pending flags must not color the
    // turn's completion — the real finish stands. But only when the
    // rejection is this interrupt's own call: a stale rejection (its
    // turn completed first, a later turn's interrupt is already pending)
    // must not clear the next turn's state (review live11).
    if (pending === "interrupt" && id === this.interruptCallId) {
      this.interruptFromTimeout = false;
      this.interruptCallId = null;
    }
    // A rejected steer names the lines it carried and their turn: the
    // caller saw them acked and echoed, and the harness never got them
    // (review live23).
    const steered =
      typeof pending === "object" && pending.kind === "steer"
        ? ` (${inputSeqList(pending.inputSeqs)}${pending.turnId !== null ? `, turn ${pending.turnId}` : ""}; the text did not reach the turn)`
        : "";
    this.emitError(
      false,
      "harness",
      `the app-server rejected the ${callLabel(pending)} request${steered}: ${message}`
    );
  }

  private completeTurn(
    parse: Extract<CodexParse, { kind: "turn_completed" }>,
    rawLine: string
  ): void {
    const turnId = this.fsm.activeTurn;
    const error = this.fsm.transition({
      kind: "turn_completed",
      turnId: turnId ?? "none",
    });
    if (error !== null) {
      this.emitGrammarViolation(rawLine, error.message);
      void this.finish("crash", 1);
      return;
    }
    // The wire's status is the verdict (review live14): unlike the
    // claude family, where an interrupt surfaces as an error result the
    // driver must interpret (driver.ts pairs the raw error bit with its
    // own interrupt state), codex's turn/completed names "interrupted"
    // itself — so a "completed" that a caller interrupt or a
    // --turn-timeout raced is a completed turn with the full answer
    // delivered, never a recast (the recast labeled it interrupted and,
    // on the timeout path, reason turn-timeout). The wire's "failed"
    // keeps its own message the same way (review live11 — the override
    // used to recast it as interrupted and drop the message). The one
    // label the driver adds: a wire "interrupted" that the timeout's own
    // interrupt produced names its cause.
    const finish = parse.finish;
    const reason =
      finish === "interrupted" && this.interruptFromTimeout
        ? "turn-timeout"
        : parse.reason;
    this.interruptFromTimeout = false;
    this.interruptQueued = false;
    this.interruptQueuedSeq = null;
    this.interruptCallId = null;
    this.clearTurnTimer();
    this.closeHarnessTurn();
    // A turn the app-server ended by itself may still hold approvals
    // open: they belong to a turn that no longer exists, and a later
    // decision would be acked for a request the harness no longer holds
    // while the expiry timer writes a stray decline into whatever turn
    // runs next — the same supersede every other turn-closing path
    // applies (review live11).
    this.supersedeApprovals();
    const usage = this.turnUsage ?? emptyUsage();
    this.turnUsage = null;
    this.dropBufferedSteer();
    // Cost rides outside the token sums when a wire carries one; codex's
    // app-server reports none (cost_usd stays null), so this is the
    // shared rule rather than a codex behavior (usage.ts, review live8).
    this.cumulative = addTurnUsage(this.cumulative, usage);
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_completed", rawLine, {
        turn_id: turnId,
        finish,
        ...(reason !== null ? { reason } : {}),
        usage,
      })
    );
    if (this.registryRecorded && this.options.registryPath !== null) {
      // Best-effort stamp, and never a wait: the lock's retry sleep is a
      // synchronous Atomics.wait on the main thread, and this runs inside
      // harness-line handling on every turn — waiting behind another
      // codemux process's write would freeze stdout reads, caller events
      // and signal handlers for the lock's full budget (~10 s), so the
      // stamp takes a single-attempt lock: one sweep, fail fast (review
      // live13). A failed stamp costs pruning freshness, not correctness
      // (the owner-liveness guard carries the real safety), and the first
      // failure says so once on stderr — silently swallowing it was the
      // live13 defect.
      const outcome = touchSession(this.options.registryPath, this.threadId ?? "", {
        attempts: 1,
      });
      if (!outcome.ok && !this.touchWarned) {
        this.touchWarned = true;
        console.error(
          `codemux: cannot stamp the session registry for ${this.threadId} ` +
            `(${outcome.error}); activity tracking may lag`
        );
      }
    }
    this.drainTurnQueue();
  }

  /** Complete the open turn as failed without a harness notification:
   * the turn/start response itself refused the turn (§4.7). */
  private failOpenTurn(reason: string, rawLine: string): void {
    const turnId = this.fsm.activeTurn;
    const error = this.fsm.transition({
      kind: "turn_completed",
      turnId: turnId ?? "none",
    });
    if (error !== null) {
      this.emitGrammarViolation(rawLine, error.message);
      void this.finish("crash", 1);
      return;
    }
    this.interruptFromTimeout = false;
    this.interruptQueued = false;
    this.interruptQueuedSeq = null;
    this.interruptCallId = null;
    this.clearTurnTimer();
    this.closeHarnessTurn();
    this.dropBufferedSteer();
    this.supersedeApprovals();
    const usage = this.turnUsage ?? emptyUsage();
    this.turnUsage = null;
    // Usage that arrived before the refusal is real and was already
    // reported per notification; it folds into the session total as
    // completeTurn's does (review live22).
    this.cumulative = addTurnUsage(this.cumulative, usage);
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_completed", null, {
        turn_id: turnId,
        finish: "failed",
        reason,
        usage,
      })
    );
    this.drainTurnQueue();
  }

  /** Submit the next queued input, only from idle: the announce replay
   * can open a turn for a parked line and queue the next, so a caller
   * that finds a turn already open must leave the queue for that turn's
   * completion (review live16 — submitting from turn_active crashed). */
  private drainTurnQueue(): void {
    if (this.queuedInputs === 0 || this.finished || this.fsm.state !== "idle") return;
    const next = this.turnQueue.shift();
    if (next === undefined) return;
    this.queuedInputs -= 1;
    const turnId = this.submitTurn();
    if (turnId === null) return; // transition failure already ended us
    this.sendTurnStart(turnId, next.text);
  }

  /** Report and clear steer texts that can no longer reach a turn — the
   * turn they steered is gone (completed, failed its start, or the
   * session is ending). One place, so every drop path tells the caller
   * the same thing (review live10: failOpenTurn and the end path used to
   * clear the buffer silently, while completeTurn alone reported it). */
  private dropBufferedSteer(): void {
    if (this.steerBuffer.length === 0) return;
    this.emitError(
      false,
      "codemux",
      `steering input arrived too late for its turn and was dropped (${inputSeqList(
        this.steerBuffer.map((entry) => entry.inputSeq)
      )})`
    );
    this.steerBuffer.length = 0;
  }

  /** Assign the next codemux turn id and open it in the FSM. */
  private submitTurn(): string | null {
    this.turnCounter += 1;
    const turnId = `t${this.turnCounter}`;
    const error = this.fsm.transition({ kind: "turn_started", turnId });
    if (error !== null) {
      this.emitError(true, "harness", error.message);
      void this.finish("crash", 1);
      return null;
    }
    // The caller's proof the turn opened, emitted where the claude family
    // emits its own (startTurn): at submit, raw null — no harness line
    // exists for it yet. Riding the harness's turn/started notification
    // instead left a turn/start error or an end-path interruption
    // completing a turn the caller never saw open (§4.1, review live15).
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_started", null, {
        turn_id: turnId,
      })
    );
    this.turnTimeoutFired = false;
    this.armTurnTimer();
    return turnId;
  }

  /** `--turn-timeout` (§4.5): the first expiry interrupts the turn and
   * re-arms; a second expiry on the same turn means the interrupt did not
   * end it (rejected, lost, or ignored), so the cap ends the session
   * instead of letting the turn run uncapped (review live17). */
  private armTurnTimer(): void {
    // An end path clears every timer once; a timer armed after it began
    // would fire into the drain (review live22: a refused timeout
    // interrupt started the crash end, and the re-arm below then raised a
    // second, false "--turn-timeout" fatal).
    if (this.options.turnTimeoutMs === null || this.finished) return;
    this.clearTurnTimer();
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      if (this.finished || this.fsm.state !== "turn_active" || !this.capabilities.interrupt) {
        return;
      }
      if (this.turnTimeoutFired) {
        this.emitError(
          true,
          "codemux",
          "the turn did not end within --turn-timeout after its timeout interrupt; ending the session"
        );
        void this.finish("timeout", 1);
        return;
      }
      this.turnTimeoutFired = true;
      // §4.1: the turn timeout declines pending approvals too, then
      // interrupts the turn; the session continues. The timeout label
      // rides only an interrupt that was written or queued (review
      // live23).
      this.supersedeApprovals();
      if (this.finished) return;
      if (this.sendInterrupt()) this.interruptFromTimeout = true;
      this.armTurnTimer();
    }, this.options.turnTimeoutMs);
    this.turnTimer.unref?.();
  }

  private sendTurnStart(turnId: string, text: string): void {
    this.call({ kind: "turn_start", turnId }, (id) =>
      buildTurnStartRequest(
        id,
        this.threadId ?? "",
        text,
        this.policy,
        this.options.effort
      )
    );
  }

  /** `currentSeq` is the steer line being handled now, which its caller
   * rejects itself when the write is refused; every other line in a
   * refused batch was acked earlier and is named here (review live23). */
  private flushSteer(currentSeq: number | null = null): void {
    if (this.steerBuffer.length === 0 || this.harnessTurnId === null) return;
    const threadId = this.threadId ?? "";
    const expectedTurnId = this.harnessTurnId;
    // Batch greedily but never past the 17 MiB write cap (review live14):
    // every buffered text passed the pre-ack check alone, and joining
    // them can cross the cap — a frame writeToHarness would refuse as
    // oversize, ending the session after each steer in it was already
    // acked. `call` assigns `requestCounter + 1` as the id, so the probe
    // frame is byte-identical to the one that is then sent. Splitting is
    // the wire's common shape anyway: one request per steer once the
    // turn is open; batching only happens while turn/start was in
    // flight.
    while (this.steerBuffer.length > 0) {
      let count = 0;
      while (
        count < this.steerBuffer.length &&
        harnessLineDeliverable(
          buildSteerRequest(
            this.requestCounter + 1,
            threadId,
            expectedTurnId,
            this.steerBuffer.slice(0, count + 1).map((entry) => entry.text)
          )
        )
      ) {
        count += 1;
      }
      if (count === 0) {
        // The pre-ack margin guarantees a single text fits; zero can
        // only mean the buffer holds something that check should have
        // refused. Drop it with the notice rather than spin forever.
        this.dropBufferedSteer();
        return;
      }
      const entries = this.steerBuffer.splice(0, count);
      const texts = entries.map((entry) => entry.text);
      const sent = this.call(
        {
          kind: "steer",
          inputSeqs: entries.map((entry) => entry.inputSeq),
          turnId: this.fsm.activeTurn,
        },
        (id) => buildSteerRequest(id, threadId, expectedTurnId, texts)
      );
      // A refused write started the crash end; the rest cannot follow.
      if (sent === null) {
        const acked = [...entries, ...this.steerBuffer]
          .map((entry) => entry.inputSeq)
          .filter((seq) => seq !== currentSeq);
        this.steerBuffer.length = 0;
        if (acked.length > 0) {
          this.emitError(
            false,
            "codemux",
            `steering input could not be delivered to the harness (${inputSeqList(acked)})`
          );
        }
        return;
      }
    }
  }

  /** Whether the interrupt was written or will ride the turn/start
   * response; false when the write was refused. */
  private sendInterrupt(): boolean {
    if (this.harnessTurnId === null) {
      // The turn is open codemux-side but the harness has not named it
      // yet; the interrupt rides the turn/start response. With no
      // turn/start in flight there is no response to ride (a success
      // that named no turn, review live22): nothing was sent, and the
      // end path must not wait a grace window for an answer.
      if (!this.turnStartInFlight()) return false;
      this.interruptQueued = true;
      return true;
    }
    return this.deliverInterrupt();
  }

  private turnStartInFlight(): boolean {
    for (const pending of this.pendingCalls.values()) {
      if (typeof pending === "object" && pending.kind === "turn_start") return true;
    }
    return false;
  }

  private deliverInterrupt(): boolean {
    const threadId = this.threadId ?? "";
    const turnId = this.harnessTurnId ?? "";
    this.interruptCallId = this.call(
      "interrupt",
      (id) => buildInterruptRequest(id, threadId, turnId)
    );
    return this.interruptCallId !== null;
  }

  private expireApproval(requestId: string): void {
    if (this.finished || !this.fsm.isPending(requestId)) return;
    const approval = this.pendingApprovals.get(requestId);
    const method =
      approval === undefined
        ? "item/commandExecution/requestApproval"
        : approvalMethod(approval.kind);
    const available = approval === undefined ? undefined : approval.input["availableDecisions"];
    // The wire id keeps its type: numeric ids are answered numerically.
    this.writeToHarness(
      this.approvalDecline(approval === undefined ? requestId : approval.id, method, available ?? null)
    );
    this.resolvePending(requestId, "timeout");
  }

  private applyPermissionDecision(
    inputSeq: number,
    message: Extract<InputMessage, { type: "permission_decision" }>
  ): void {
    const approval = this.pendingApprovals.get(message.request_id);
    if (approval === undefined) {
      this.ack(inputSeq, false, "unknown_request");
      return;
    }
    if (message.updated_input !== undefined) {
      // Codex approvals carry no updated-input channel codemux has
      // verified (§4.1): the request stays pending for a plain decision.
      this.ack(inputSeq, false, "unsupported");
      return;
    }
    if (message.decision === "deny") {
      const delivered = this.writeToHarness(
        this.approvalDecline(
          approval.id,
          approvalMethod(approval.kind),
          approval.input["availableDecisions"]
        )
      );
      if (!delivered) {
        this.rejectUndelivered(inputSeq);
        return;
      }
      this.resolvePending(message.request_id, "deny");
      this.ack(inputSeq, true);
      return;
    }
    const verdict = codexApprovalCeiling(
      this.options.autonomy,
      approval.kind,
      approval.input,
      this.options.cwd
    );
    if (!verdict.allowable) {
      this.writeToHarness(
        this.approvalDecline(
          approval.id,
          approvalMethod(approval.kind),
          approval.input["availableDecisions"]
        )
      );
      this.resolvePending(message.request_id, "deny");
      this.ack(inputSeq, false, "autonomy_escalation");
      return;
    }
    if (!this.allowDeliverable(approval.kind, approval.input)) {
      // An approval whose availableDecisions omit "accept" — for example
      // ["acceptForSession","decline"]: the wire answer approvalAccept
      // builds would substitute decline (pickApprovalDecision's rule)
      // while the caller was told allow and the ack said accepted — a
      // success reported on a failure path (review live15). codemux never
      // answers acceptForSession (a per-request refusal is the pinned
      // rule, approvalDecline's comment), so allow is undeliverable: the
      // honest outcome is deny on the wire, deny in permission_resolved,
      // and a rejected ack naming what the caller asked for.
      this.writeToHarness(
        this.approvalDecline(
          approval.id,
          approvalMethod(approval.kind),
          approval.input["availableDecisions"]
        )
      );
      this.resolvePending(message.request_id, "deny");
      this.ack(inputSeq, false, "unsupported");
      this.emitError(
        false,
        "harness",
        "the approval offered no accept decision; the allow was answered deny"
      );
      return;
    }
    if (!this.writeToHarness(this.approvalAccept(approval.id, approval.kind, approval.input))) {
      this.rejectUndelivered(inputSeq);
      return;
    }
    this.resolvePending(message.request_id, "allow");
    this.ack(inputSeq, true);
  }

  /** A decision whose answer never reached the harness: the refused
   * write already started the crash end, which superseded the approval,
   * so the decision is rejected `shutting_down` rather than acked as
   * accepted (review live20). The ceiling and undeliverable-allow paths
   * reject the decision on their own reason either way. */
  private rejectUndelivered(inputSeq: number): void {
    this.ack(inputSeq, false, "shutting_down");
  }

  /** Whether an allow answer can actually reach the harness as an
   * accept: commandExecution approvals carry the wire's own
   * availableDecisions, and codemux refuses acceptForSession — the one
   * surviving spelling of accept in a list without plain "accept" — so
   * such a request advertises deny as its only option (review live15).
   * fileChange and permissions answers are pinned shapes with no
   * decision list, so allow is always deliverable there. */
  private allowDeliverable(
    kind: CodexApprovalKind,
    input: Record<string, unknown>
  ): boolean {
    if (kind !== "commandExecution") return true;
    return pickApprovalDecision(input["availableDecisions"], "accept") === "accept";
  }

  /** The decline answer for one approval request id, per method (§4.7):
   * never `acceptForSession`, always a per-request refusal. */
  private approvalDecline(
    id: number | string,
    method: string,
    available: unknown
  ): string {
    if (method === "item/fileChange/requestApproval") {
      return buildJsonRpcResponse(id, { decision: "decline" });
    }
    if (method === "item/permissions/requestApproval") {
      return buildJsonRpcResponse(id, { permissions: {}, scope: "turn" });
    }
    return buildJsonRpcResponse(id, {
      decision: pickApprovalDecision(available, "decline"),
    });
  }

  /** The allow answer, per method: the ceiling has already cleared it. */
  private approvalAccept(
    id: number | string,
    kind: CodexApprovalKind,
    input: Record<string, unknown>
  ): string {
    if (kind === "fileChange") {
      return buildJsonRpcResponse(id, { decision: "accept" });
    }
    if (kind === "permissions") {
      return buildJsonRpcResponse(id, {
        permissions: echoPermissions(input),
        scope: "turn",
      });
    }
    return buildJsonRpcResponse(id, {
      decision: pickApprovalDecision(input["availableDecisions"], "accept"),
    });
  }

  private resolvePending(
    requestId: string,
    resolution: "allow" | "deny" | "timeout" | "superseded"
  ): void {
    const timer = this.pendingTimers.get(requestId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.pendingTimers.delete(requestId);
    }
    this.pendingApprovals.delete(requestId);
    const error = this.fsm.removePending(requestId);
    if (error !== null) return; // Raced with another resolution path.
    this.emit(
      buildPermissionResolved(
        ++this.seq,
        this.sessionIdOrEmpty(),
        requestId,
        resolution
      )
    );
  }

  // --- end path ----------------------------------------------------------

  /** Answer every pending approval decline and emit `superseded` (§4.1):
   * turn completion, turn-start failure, interrupt, `--turn-timeout`, and
   * every end path close the permission channel first — a request whose
   * turn is closing must not keep a timer running against a session that
   * moved on. The pinned decline payload carries no reason field, so the
   * caller hears why from the interrupt/timeout/end events themselves. */
  private supersedeApprovals(): void {
    for (const requestId of this.fsm.supersedePending()) {
      const approval = this.pendingApprovals.get(requestId);
      this.writeToHarness(
        this.approvalDecline(
          approval === undefined ? requestId : approval.id,
          approval === undefined
            ? "item/commandExecution/requestApproval"
            : approvalMethod(approval.kind),
          approval === undefined ? null : approval.input["availableDecisions"]
        )
      );
      const timer = this.pendingTimers.get(requestId);
      if (timer !== undefined) clearTimeout(timer);
      this.pendingTimers.delete(requestId);
      this.pendingApprovals.delete(requestId);
      this.emit(
        buildPermissionResolved(
          ++this.seq,
          this.sessionIdOrEmpty(),
          requestId,
          "superseded"
        )
      );
    }
  }

  /** Every end path funnels here (§4.6): pending approvals are answered
   * deny (`superseded`) first, the active turn is interrupted so the
   * harness can persist, the tree is killed after the grace, harness
   * output is drained until the child settles, and `session_ended` is
   * the last event on the stream. */
  private async finish(reason: SessionEndReason, exitCode: number): Promise<void> {
    if (this.finished) {
      // Idempotent cleanup, honest verdict: a failure calling in during
      // the drain (a fatal harness line, a handler exception) arrives
      // after the initiating end already began — it raises the exit code
      // instead of restarting a cleanup that is running.
      this.endExitCode = Math.max(this.endExitCode, exitCode);
      return;
    }
    this.finished = true;
    this.endExitCode = exitCode;
    // The input contract (§4.1) reaches the buffers an end path forecloses
    // (review live10): lines parked in `preSessionLines` — the handshake
    // never answered, so replay can never run — are each rejected with the
    // same `shutting_down` the drain window gives a fresh line; user
    // inputs already acked and echoed but still queued in the FIFO can no
    // longer run, so the caller gets one non-fatal notice (their acks
    // cannot be retracted, and a second answer per line would break the
    // ack contract); steer texts buffered before the harness turn id was
    // named get the drop notice completeTurn emits for the same loss.
    while (this.preSessionLines.length > 0) {
      this.preSessionLines.shift();
      this.ack(this.fsm.nextInputSeq(), false, "shutting_down");
    }
    this.preSessionBytes = 0;
    if (this.queuedInputs > 0) {
      this.emitError(
        false,
        "codemux",
        "queued user input could not run before the session ended and was dropped"
      );
      this.queuedInputs = 0;
      this.turnQueue.length = 0;
    }
    this.dropBufferedSteer();
    // Read before the end-interrupt runs: whether a turn was open when
    // the end began decides whether an unanswered turn is synthesized
    // (below); the verdict's wording reads the turn state after the drain.
    const turnOpenAtFinish = this.fsm.state === "turn_active";
    this.supersedeApprovals();
    let interruptSent = false;
    if (
      this.fsm.state === "turn_active" &&
      this.capabilities.interrupt &&
      this.proc !== null
    ) {
      // The end path interrupts before the SIGTERM, and the interrupt
      // gets its own grace window (below), so the harness can answer and
      // persist its transcript cleanly. It
      // is a real correlated call, not an uncorrelated fire-and-forget:
      // the response (or its rejection) can arrive during the drain
      // below and the normal response handlers consume it — and the
      // interrupt is pending like any other, so a turn completing during
      // the drain is the interrupted completion, while a rejection
      // clears the flag and the turn's real completion stands (the
      // live4 rule). sendInterrupt, not an inline call: while a
      // turn/start response is still in flight (harnessTurnId null) the
      // interrupt buffers and rides that response, which lands inside
      // the drain — the old harnessTurnId guard skipped the interrupt
      // entirely in that window and the turn ran until the kill (review
      // live11).
      // A refused write (a harness that stopped reading, review live19)
      // leaves nothing to wait for, so the stop follows at once.
      interruptSent = this.sendInterrupt();
      if (!interruptSent && reason !== "crash") {
        // The claude driver's rule (review live25): an orderly end whose
        // interrupt the app-server would not take stops the turn by
        // signal, which is a failure, not a clean end. A crash end
        // already reported its own fatal.
        this.endExitCode = Math.max(this.endExitCode, 1);
        this.emitError(
          true,
          "codemux",
          "could not deliver the end-path interrupt to the codex process; the open turn was stopped by signal"
        );
      }
    }
    this.clearTimers();
    // The signal gate stays installed until cleanup completes: a second
    // SIGINT/SIGTERM during the grace window must hit the gate's
    // fire-once latch, not the default disposition, or codemux dies
    // mid-drain and the tree it was about to kill survives it.
    const proc = this.proc;
    let childCode: number | null = null;
    if (proc !== null) {
      if (interruptSent) {
        // The interrupt gets its own grace window before any signal
        // (review live17): the turn closes through its drained
        // completion, a failure arriving meanwhile raises the code, or
        // the child exits.
        const startCode = this.endExitCode;
        // A rejected interrupt clears its call id (applyResponseError),
        // so the wait also stops there instead of holding the full grace
        // (review live23; the claude driver's rule).
        await proc.awaitEndAnswer(
          () =>
            this.fsm.state !== "turn_active" ||
            this.endExitCode > startCode ||
            (!this.interruptQueued && this.interruptCallId === null)
        );
      }
      proc.requestStop();
      await proc.settled;
      childCode = (await proc.exited).code;
    }
    // A raw-newline fragment still buffered when the stream ended can never
    // complete: the output it held is reported as tier 3, never dropped
    // without a word (review live25).
    const fragment = this.parser.takeFragment();
    if (fragment !== null) {
      this.endExitCode = Math.max(this.endExitCode, 1);
      this.emitError(
        true,
        "harness",
        `unusable harness output (an unterminated JSON fragment at the end of the stream, ` +
          `${fragment.bytes} bytes): ${fragment.excerpt}`
      );
    }
    // Non-null exactly when the child's exit is itself a failure the
    // verdict below reports (review live9): nonzero, not the 143 coded
    // signal death, not a crash end (which emitted its own fatal). An
    // idle child counts too (review live17), and so does a child that
    // delivered its turn's completion first: no exit convention was ever
    // recorded for the app-server, so a delivered completion excuses
    // nothing (review live18 — it used to excuse every nonzero code).
    const drainFailureCode =
      childCode !== null &&
      childCode !== 0 &&
      childCode !== SESSION_SIGNAL_EXIT_CODE &&
      reason !== "crash"
        ? childCode
        : null;
    if (drainFailureCode !== null) {
      // The app-server exited nonzero — its turn still open, no turn
      // open at all (review live17), or after its completion (review
      // live18): a failure while persisting during the shutdown,
      // reported as one (review live9 — the end used to resolve with the
      // initiating success code whatever the child did). Exempt: a
      // signal death (code null, the normal kill path), 143 (a wrapper
      // answering the SIGTERM with an exit code — scode parity), and a
      // crash end (the crash path already emitted its own fatal; a
      // second one blaming the drain would be false, review live11).
      // The error event precedes `session_ended` on the stream — and
      // the synthesis below pairs the turn this verdict belongs to
      // (review live12: the fatal used to be the turn's only answer,
      // leaving its `turn_started` unpaired exactly when this fired).
      this.endExitCode = Math.max(this.endExitCode, 1);
      this.emitError(
        true,
        "harness",
        drainFailureMessage("codex", drainFailureCode, this.fsm.state === "turn_active")
      );
    }
    if (turnOpenAtFinish && this.fsm.state === "turn_active") {
      // The turn is still open and nothing else will ever answer it: the
      // crash path's fatal already told the failure story (a crash
      // mid-turn, review live11), the child exited without a completion
      // on a non-failure exit (a signal death or its coded spellings —
      // the harness ignored or never saw the interrupt), or the
      // drain-failure verdict above just fired (review live12 — the two
      // blocks used to be mutually exclusive, so the one exit class the
      // verdict reported was the one class the synthesis refused to
      // answer). §4.1's pairing holds only if codemux answers the
      // `turn_started` it emitted, so synthesize the completion: failed
      // for a crash or a drain failure (the reason mirrors the fatal
      // that reported it), interrupted otherwise; the usage the open
      // turn already reported, or all-null usage (never guessed zeros)
      // when none came, raw null (codemux-originated) — the agy
      // precedent (review live10). The known usage also folds into the
      // session total: dropping it under-reported `session_ended.usage`
      // for tokens the caller had already seen (review live22).
      const turnId = this.fsm.activeTurn;
      const usage = this.turnUsage ?? emptyUsage();
      this.turnUsage = null;
      this.cumulative = addTurnUsage(this.cumulative, usage);
      const error = this.fsm.transition({
        kind: "turn_completed",
        turnId: turnId ?? "none",
      });
      if (error !== null) {
        this.endExitCode = Math.max(this.endExitCode, 1);
        this.emitError(true, "codemux", error.message);
      } else {
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_completed", null, {
            turn_id: turnId,
            finish:
              reason === "crash" || drainFailureCode !== null || this.firstFatal !== null
                ? "failed"
                : "interrupted",
            reason:
              reason === "crash"
                ? crashSynthesisReason(this.firstFatal)
                : drainFailureCode !== null
                  ? drainFailureMessage("codex", drainFailureCode, true)
                  : this.firstFatal !== null
                    // A fatal raised during an orderly end's drain (an
                    // overlong line, an unknown response id) is a failure too
                    // (review live22).
                    ? crashSynthesisReason(this.firstFatal)
                    : `the session ended (${reason}) before the turn completed`,
            usage,
          })
        );
      }
    }
    // The child is dead and the pipes are drained: nothing more can
    // arrive, so the harness side closes for good. The FSM transitions
    // wait until here so a turn completing during the drain could still
    // leave `turn_active` through its own `turn_completed`.
    this.settled = true;
    this.fsm.transition({ kind: "shutdown_started" });
    this.fsm.transition({ kind: "ended" });
    // Resumable means the harness confirmed the session (the start was
    // recorded at its first identity-bearing frame) or, for a claimed
    // resume it never confirmed, that the end did not fail: a resume the
    // harness refused (a transcript Claude Code already cleaned up, a
    // thread codex cannot load) dies on the crash path or fails the
    // drain, and one that hung until a timeout proved nothing either;
    // reporting it resumable would send a retrying caller into the same
    // failure (review live21). A claimed resume that ended
    // cleanly before its first turn keeps the record the claim judged
    // (review live20).
    const resumable =
      this.capabilities.resume &&
      (this.registryRecorded ||
        (this.resumeClaimed && this.endExitCode === 0));
    // The per-session harness home's settlement (a codex override session's
    // CODEX_HOME, codex-provider.ts) runs here and only here: the child has
    // settled, so nothing writes the home anymore, and the resumable
    // verdict — what decides keep-vs-remove for a FRESH home — is final. A
    // resumed home is never removed at settlement (review D3,
    // correctness-2): its state predates this process, so an interrupted
    // resume must not delete the earlier turns with it; the sweep reclaims
    // it if no resume comes back. Best-effort by contract: a settlement
    // that cannot complete is reported by the home's own code, never
    // raised out of the end path. Its return is whether the state reached
    // where a resume finds it (review D2, correctness-2 2): a rename that
    // failed leaves the threads on in the run-shaped name a resume never
    // computes, so the report and the registry's promise must not claim
    // resumable — the caller is refused now instead of failing inside
    // codex on a thread-not-found later. The settlement runs BEFORE the
    // record release below: the release is what a --resume in another
    // process waits on, and a released record whose harness_home names a
    // keyed path that does not exist yet is refused "missing or untrusted"
    // in the window this ordering used to leave (review D7,
    // correctness-2 1).
    let settledHome = true;
    if (this.options.settleSessionHome !== undefined) {
      try {
        settledHome = this.options.settleSessionHome(this.threadId, resumable);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`codemux: session home settlement failed: ${detail}`);
        settledHome = false;
      }
    }
    const ownsRecord = this.registryRecorded || this.resumeClaimed;
    if (ownsRecord && this.options.registryPath !== null && this.threadId !== null) {
      // A lost stamp rides stderr (releaseSessionRecord, review live13).
      releaseSessionRecord(this.options.registryPath, this.threadId);
    }
    const sent = this.out.enqueue(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "session_ended", null, {
        reason,
        exit_code: childCode,
        usage: this.cumulative,
        resumable: resumable && settledHome,
      })
    );
    // Exit-code honesty: `session_ended` is the one event the caller
    // cannot afford to lose, so a delivery that failed — the sink
    // rejected or stalled on the flush, or the queue refused the entry —
    // cannot report success. `finish` is already past its re-entry
    // guard, so the failure callback's own end attempt only raises
    // `endExitCode`; the code carries the truth. The give-up also
    // abandons the queue, so a stalled sink cannot hold the process
    // open past the report.
    const delivered = sent ? await awaitFinalFlush(this.out) : false;
    // Only now, with the report delivered and the exit code decided, do
    // the signal handlers come off: from here to process exit there is
    // no cleanup left for a signal to interrupt.
    this.signals.dispose();
    this.resolveDone(delivered ? this.endExitCode : Math.max(this.endExitCode, 1));
  }

  // --- helpers -----------------------------------------------------------

  /** Forget the open harness turn, remembering its id as closed. */
  private closeHarnessTurn(): void {
    if (this.harnessTurnId !== null) {
      this.closedHarnessTurnIds.add(this.harnessTurnId);
      if (this.closedHarnessTurnIds.size > CLOSED_TURN_IDS_KEPT) {
        const oldest = this.closedHarnessTurnIds.values().next().value;
        if (oldest !== undefined) this.closedHarnessTurnIds.delete(oldest);
      }
    }
    this.harnessTurnId = null;
  }

  /** The caller-facing turn a translated notification belongs to: none
   * for a straggler of the turn that already closed, the open turn
   * otherwise (review live20 — stragglers were labeled with the next
   * turn's id). */
  private turnIdFor(harnessTurnId: string | null): string | null {
    if (harnessTurnId !== null && this.closedHarnessTurnIds.has(harnessTurnId)) return null;
    return this.fsm.activeTurn;
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
  private call(kind: PendingCall, build: (id: number) => string): number | null {
    this.requestCounter += 1;
    const id = this.requestCounter;
    if (!this.writeToHarness(build(id))) return null;
    this.pendingCalls.set(id, kind);
    return id;
  }

  private recordStart(): void {
    if (this.options.registryPath === null || this.threadId === null) return;
    const outcome = recordSessionStart(this.options.registryPath, {
      id: this.threadId,
      agent: "codex",
      cwd: this.options.cwd,
      hermetic: false,
      harness_home:
        this.options.harnessHomeFor !== undefined
          ? this.options.harnessHomeFor(this.threadId)
          : this.options.harnessHome,
      model: this.options.model ?? null,
      autonomy: this.options.autonomy,
      sandboxed: this.options.sandboxed,
      sandbox_trust: this.options.sandboxTrust,
      sandbox_no_net: this.options.sandboxNoNet,
      sandbox_scrub_env: this.options.sandboxScrubEnv,
      pass_env: [...this.options.passEnv],
      // The CLI refuses --enable-playwright-mcp outside the claude family.
      playwright_mcp: false,
      provider_base_url: this.options.providerBaseUrl,
    });
    if (!outcome.ok) {
      // An untracked live session must not run (§4.8): the registry is
      // what makes resume's guards answerable, so failing to record it
      // fails the session closed.
      this.emitError(
        true,
        "codemux",
        `cannot record the session in the registry: ${outcome.error}`
      );
      void this.finish("crash", 1);
      return;
    }
    this.registryRecorded = true;
  }

  /** Events before the thread exists carry an empty session id — an
   * honest window, not an impossible one: the starting-state shutdown
   * ack, the end path's `shutting_down` rejections of pre-session lines
   * the replay never reached (review live10), and the fatal error
   * events on the handshake-failure paths (an initialize or thread
   * request rejected, a thread response with no id), all fire while
   * `threadId` is still null. Everything else waits for the thread:
   * pre-session caller lines buffer, and harness translation does not
   * begin. (agy-driver.ts documents the same window for the same
   * reason.) */
  private sessionIdOrEmpty(): string {
    return this.threadId ?? "";
  }

  private emit(line: string): void {
    this.out.enqueue(line);
  }

  private ack(inputSeq: number, accepted: boolean, reason?: InputRejectionReason): void {
    this.emit(
      buildInputAck(++this.seq, this.sessionIdOrEmpty(), inputSeq, accepted, reason)
    );
  }

  /** Tier 2 (§4.2): a harness line that breaks the stream's grammar
   * still goes out raw, then the fatal names the violation (review
   * live21, the claude-family sibling). A null line is the
   * response-adoption path, codemux-originated, with nothing to mirror. */
  private emitGrammarViolation(rawLine: string | null, message: string): void {
    if (rawLine !== null) {
      this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
    }
    this.emitError(true, "harness", message);
  }

  private emitError(
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
      })
    );
  }

  private writeToHarness(line: string): boolean {
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

  private clearTurnTimer(): void {
    if (this.turnTimer !== null) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearTurnTimer();
    if (this.sessionTimer !== null) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    this.pendingTimers.clear();
  }
}

function approvalMethod(kind: CodexApprovalKind): string {
  switch (kind) {
    case "commandExecution":
      return "item/commandExecution/requestApproval";
    case "fileChange":
      return "item/fileChange/requestApproval";
    case "permissions":
      return "item/permissions/requestApproval";
  }
}

/** Echo the permission grant subset the request asked for (§4.7): the
 * turn-scoped answer restates what was requested, no more. */
function echoPermissions(input: Record<string, unknown>): Record<string, unknown> {
  const requested = input["permissions"];
  const echoed: Record<string, unknown> = {};
  if (typeof requested === "object" && requested !== null && !Array.isArray(requested)) {
    const record = requested as Record<string, unknown>;
    if ("network" in record) echoed["network"] = record["network"];
    if ("fileSystem" in record) echoed["fileSystem"] = record["fileSystem"];
  }
  return echoed;
}

/** "input_seq 4" or "input_seq 4, 5" for a notice naming caller lines. */
function inputSeqList(seqs: readonly number[]): string {
  return `input_seq ${seqs.join(", ")}`;
}

function callLabel(call: PendingCall): string {
  if (typeof call === "string") return call.replaceAll("_", "/");
  return call.kind;
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
