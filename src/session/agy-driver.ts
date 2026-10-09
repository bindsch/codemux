/**
 * The agy session driver (design §4.7, plan step 8): the launcher-owned
 * context that turns one SessionProcess plus the caller's stdin into the
 * event stream. All per-run state lives here — the FSM, the parser
 * context, the output queue, the registry writes — never on a singleton
 * adapter. The driver never throws across the stream: every failure is
 * an event, an end path, or both.
 *
 * Turn model: one caller input line is one harness turn. The capability
 * matrix is honestly narrow (src/session/agy-session.ts): no steer, no
 * interrupt, no permissions, no mid-turn input — the input parser
 * rejects each of those with a named reason before anything reaches the
 * harness, so the driver carries no queue, no buffer, and no approval
 * machinery. Turn ids are codemux-local (t1, t2, …) assigned at submit,
 * and `turn_started` is emitted at submit, ahead of the `user_message`
 * that names it and of the write, because writing the line is what opens
 * an agy turn (the claude and codex order; review live17). The stdin
 * close is the only end carrier (`finish`).
 *
 * Identity model: a fresh agy session has no init frame — the first
 * fact that names the conversation is the first result envelope. The FSM
 * therefore leaves `starting` silently on the first user input (nothing
 * else can ever be submitted), while the caller-facing
 * `session_started` event and the registry record wait for that first
 * usable conversation id; events before it carry an empty session_id. A
 * resumed session (`--conversation`, registry-vouched) adopts its id at
 * spawn instead. A first result that names NO conversation id (the
 * auth-failure fixture) completes the open turn as failed and then ends
 * the session: an untracked live session must not run (§4.8).
 */

import { randomUUID } from "node:crypto";
import type { AutonomyLevel, ReasoningEffort, ResultUsageBlock } from "../types.js";
import {
  appendSessionCallRecord,
  appendSessionTurnCallRecord,
  providerHost,
  type SessionCallContext,
} from "../call-log.js";
import { emptyUsage } from "../result-envelope.js";
import {
  agySessionCapabilities,
  buildAgyUserMessage,
  parseAgySessionLine,
  type AgyParse,
} from "./agy-session.js";
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
  installSessionSignalHandlers,
  type SessionFatal,
  type SessionProcess,
  type SessionSignalGate,
} from "./process.js";
import {
  applyAuthorPrefix,
  buildEvent,
  buildInputAck,
  buildUnknownEvent,
  buildUserMessage,
  parseInputLine,
  type InputRejectionReason,
} from "./protocol.js";
import {
  releaseSessionRecord,
  recordSessionStart,
  touchSession,
  type SandboxTrust,
} from "./registry.js";
import { addTurnUsage } from "./usage.js";

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
  | "crash";

type Timer = ReturnType<typeof setTimeout>;

export class AgySessionDriver {
  private readonly fsm = new SessionFsm();
  private readonly capabilities = agySessionCapabilities();
  private readonly out: BoundedOutboundQueue;
  private readonly signals: SessionSignalGate;
  private proc: SessionProcess | null = null;
  private readonly earlyLines: string[] = [];
  private seq = 0;
  private turnCounter = 0;
  /** The conversation id: harness-issued, adopted from the first result
   * envelope that names it (a fresh session), or the registry-vouched
   * resume id adopted at spawn. Null until one of those lands. */
  private conversationId: string | null;
  /** Codemux's own id for this session, minted at construction: what the
   * call ledger records while no result frame has named the conversation
   * (and ever after, if none ever does), so id-less sessions never share
   * a key (review ul6). */
  private readonly codemuxSessionId = randomUUID();
  /** Starts unknown (all-null), not zero: a counter a turn never reports
   * must stay null rather than be guessed as 0 (§4.2). */
  private cumulative: ResultUsageBlock = emptyUsage();
  private registryRecorded = false;
  /** The CLI claimed the record for a resume before the spawn
   * (`adoptResumeClaim`): every end path releases the claim, and one
   * that ended cleanly before the session start still reports the
   * session resumable (review live20). */
  private resumeClaimed = false;
  /** A result named this conversation: the harness confirmed it. A
   * resumed session records at spawn, from the registry-vouched id, so
   * the record alone does not prove agy can load the conversation
   * (review live21). */
  private harnessConfirmed = false;
  /** Whether a failed turn-path registry stamp already warned: the touch
   * is best-effort and never waits (review live13), so sustained
   * contention would otherwise repeat the same stderr line every turn. */
  private touchWarned = false;
  private finished = false;
  /** The end path's exit code, updatable while cleanup drains: a failure
   * arriving inside the grace window (a tier-3 fatal, a handler exception,
   * a registry failure) must still cost success — `finish` stays
   * idempotent, the verdict does not freeze until the child settles
   * (review live7). Monotone: only a higher code ever wins. */
  private endExitCode = 0;
  /** True only once the end path has settled the child: harness lines
   * keep flowing (and keep being parsed and emitted) through the whole
   * shutdown drain, because the grace window exists precisely so the
   * harness can finish persisting and say so — a final result envelope
   * arriving during it must reach the caller, not vanish because
   * `finish` began (review live5). `finished` alone is the end path's
   * re-entry guard and flips at its start. */
  private settled = false;
  private stdinClosed = false;
  /** The first fatal the session reported, carried by a crash end's
   * synthesized turn completion (review live17). */
  private firstFatal: string | null = null;
  private sessionTimer: Timer | null = null;
  /** The wall clock each open turn started at, keyed by turn id: the
   * ledger's session_turn records carry each turn's own duration. */
  private readonly turnStartedAt = new Map<string, number>();
  /** The session's own start, for the closing ledger record's duration. */
  private readonly sessionStartedAt = Date.now();
  /** The launch facts the call ledger records on every turn and at the
   * end (call-log.ts); agy refuses overrides, so the provider is always
   * "default". */
  private readonly callLedger: SessionCallContext;
  private readonly done: Promise<number>;
  private resolveDone!: (code: number) => void;

  constructor(private readonly options: AgyDriverOptions) {
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

  /** One line from the harness stdout. Never throws. Lines are parsed and
   * emitted until the end path settles (`settled`): the shutdown grace
   * window is exactly the interval in which a final result envelope may
   * still be arriving, and dropping it there would report a session that
   * ended mid-sentence. */
  handleHarnessLine(line: string): void {
    if (this.proc === null) {
      this.earlyLines.push(line);
      return;
    }
    if (this.settled) return;
    this.applyParse(
      parseAgySessionLine(line, { knownConversationId: this.conversationId }),
      line
    );
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

  /** One framed line from the caller's stdin. Never throws. The
   * capability matrix has already narrowed the reachable cases: steer,
   * interrupt, and permission_decision are parser rejections
   * (`unsupported`), and a user line mid-turn is a `busy` rejection, so
   * only `user` and `shutdown` ever reach the switch. */
  handleCallerLine(line: string): void {
    if (line.trim() === "") return;
    if (this.finished) {
      // The input contract (§4.1): every line is answered, an end path
      // included — during the drain window (`finished` and not yet
      // `settled`) the answer is the `shutting_down` rejection (review
      // live9). Once `settled`, `session_ended` is already on the stream
      // and nothing may follow it, so later lines are dropped.
      if (!this.settled) this.ack(this.fsm.nextInputSeq(), false, "shutting_down");
      return;
    }
    const inputSeq = this.fsm.nextInputSeq();
    const parsed = parseInputLine(line, {
      capabilities: this.capabilities,
      hasActiveTurn: this.fsm.state === "turn_active",
      // permissions are false, so nothing is ever pending; the capability
      // gate rejects any decision line `unsupported` before the pending
      // check can see the empty set (unknown_request is unreachable here).
      pendingRequestIds: new Set<string>(),
      shuttingDown:
        this.stdinClosed ||
        this.fsm.state === "shutting_down" ||
        this.fsm.state === "ended",
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
        const harnessLine = buildAgyUserMessage(harnessText);
        // Deliverability is checked on the exact frame BEFORE the ack: the
        // frame's JSON-escaping can push a text that passed the protocol's
        // 16 MiB bound past the harness write cap, and an accepted line
        // that cannot reach the harness would hang its turn open with the
        // caller told it went through.
        if (!harnessLineDeliverable(harnessLine)) {
          this.ack(inputSeq, false, "text_too_long");
          return;
        }
        this.ack(inputSeq, true);
        if (this.fsm.state === "starting") {
          // The silent warm-up: the FSM must be idle before a turn can
          // open, but a fresh agy session has no init frame to answer —
          // the session_started event and the registry record wait for
          // the first result to name the conversation (see the class
          // comment). Nothing but a user line or shutdown can arrive in
          // `starting`, so the transition is safe here.
          const error = this.fsm.transition({ kind: "session_started" });
          if (error !== null) {
            this.emitError(true, "harness", error.message);
            void this.finish("crash", 1);
            return;
          }
        }
        // submitTurn announces `turn_started` (codemux-originated:
        // writing the line IS opening the turn), so the order matches the
        // claude and codex drivers — turn_started, then the user_message
        // that names it (review live17) — and both precede the write: a
        // refused write ends the session through the crash path, and its
        // fatal must follow the turn it failed (review live16).
        const turnId = this.submitTurn();
        if (turnId === null) return; // transition failure already ended us
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
        this.writeToHarness(harnessLine);
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

  private applyParse(parse: AgyParse, rawLine: string): void {
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
      case "unknown":
        this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
        return;
      case "result":
        this.applyResult(parse, rawLine);
        return;
    }
  }

  private applyResult(
    parse: Extract<AgyParse, { kind: "result" }>,
    rawLine: string
  ): void {
    if (this.fsm.state !== "turn_active") {
      // One line is one turn, so a result with no open turn breaks the
      // stream's grammar — tier 2, raw preserved.
      this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
      this.emitError(true, "harness", "a result arrived with no open turn");
      void this.finish("crash", 1);
      return;
    }
    if (parse.conversationId !== null) this.harnessConfirmed = true;
    if (parse.conversationId !== null && this.conversationId === null) {
      // The first identity-bearing fact of a fresh session: adopt it,
      // record, and only now tell the caller the session exists. The
      // guard is `settled`, not `finished`: even when the end path is
      // already draining, this result still completes its own turn.
      this.conversationId = parse.conversationId;
      this.announceSessionStarted();
      if (this.settled) return;
    }
    const turnId = this.fsm.activeTurn;
    if (parse.responseText !== null) {
      this.emit(
        buildEvent(++this.seq, this.sessionIdOrEmpty(), "assistant_message", rawLine, {
          text: parse.responseText,
          turn_id: turnId,
        })
      );
    }
    // No standalone `usage` event: `usage_stream` is honestly false —
    // usage rides only the per-turn `turn_completed` (and the session
    // cumulative on `session_ended`), the same contract claude/zai ship.
    const error = this.fsm.transition({
      kind: "turn_completed",
      turnId: turnId ?? "none",
    });
    if (error !== null) {
      this.emitError(true, "harness", error.message);
      void this.finish("crash", 1);
      return;
    }
    // The shared fold (usage.ts): agy's envelope carries no cost, so
    // this is the uniform rule, not an agy behavior (review live8).
    this.cumulative = addTurnUsage(this.cumulative, parse.usage);
    const reason =
      parse.errorText !== null
        ? `status "${parse.status}": ${parse.errorText}`
        : `status "${parse.status}"`;
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_completed", rawLine, {
        turn_id: turnId,
        finish: parse.isError ? "failed" : "end",
        ...(parse.isError ? { reason } : {}),
        usage: parse.usage,
      })
    );
    // The ledger's turn record mirrors the event the caller just saw
    // (call-log.ts); agy's usage carries no cost, so this is the event's
    // own block verbatim.
    appendSessionTurnCallRecord(
      this.callLedger,
      this.ledgerSessionId(),
      turnId ?? "none",
      this.turnStartedAt.get(turnId ?? "") ?? Date.now(),
      parse.isError ? "failed" : "end",
      parse.usage
    );
    this.turnStartedAt.delete(turnId ?? "");
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
      const outcome = touchSession(this.options.registryPath, this.conversationId ?? "", {
        attempts: 1,
      });
      if (!outcome.ok && !this.touchWarned) {
        this.touchWarned = true;
        console.error(
          `codemux: cannot stamp the session registry for ${this.conversationId} ` +
            `(${outcome.error}); activity tracking may lag`
        );
      }
    }
    if (parse.conversationId === null && this.conversationId === null) {
      // The auth-failure shape the fixture pinned: a first result that
      // names no conversation leaves the session untrackable, and an
      // untracked live session must not run (§4.8). The turn's events
      // went out above; now the session ends.
      this.emitError(
        true,
        "harness",
        "the first result named no conversation id, " +
          "so the session cannot be recorded in the registry"
      );
      void this.finish("crash", 1);
    }
  }

  /** The deferred session_started (see the class comment): the FSM has
   * already left `starting`; this is the caller-facing announcement and
   * the registry record. Codemux-originated, so raw is null — the
   * claude-family driver's precedent for the same synthesis. */
  private announceSessionStarted(): void {
    this.recordStart();
    // The announcement follows the record's verdict: a required record
    // that failed must not announce — §4.8's fail-closed rule, nothing
    // is vouchable — while a record that succeeded announces even while
    // an end path drains (a first result naming the conversation arrived
    // inside the grace window). A null registryPath records nothing and
    // always announces.
    if (
      this.settled ||
      (this.options.registryPath !== null && !this.registryRecorded)
    ) {
      return;
    }
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "session_started", null, {
        agent: "agy",
        model: this.options.model ?? null,
        autonomy: this.options.autonomy,
        cwd: this.options.cwd,
        sandboxed: this.options.sandboxed,
        sandbox_trust: this.options.sandboxTrust,
        capabilities: this.capabilities,
        protocol: "codemux-live-session/1",
      })
    );
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
    this.emit(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_started", null, {
        turn_id: turnId,
      })
    );
    this.turnStartedAt.set(turnId, Date.now());
    return turnId;
  }

  // --- end path ----------------------------------------------------------

  /** Every end path funnels here (§4.6): no approvals or interrupts
   * exist on this harness, so the end carrier is the stdin close — the
   * input loop ends after the line it is running — and the harness gets
   * the grace to deliver that turn's result and exit before the stop
   * signal; then the tree is killed after a second grace, the pipe
   * drains until the child settles, and `session_ended` is the last
   * event on the stream. */
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
    // Read before the stop runs: whether a turn was open when the end
    // began decides whether an unanswered turn is synthesized (below);
    // the verdict's wording reads the turn state after the drain.
    const turnOpenAtFinish = this.fsm.state === "turn_active";
    this.clearTimers();
    // The signal gate stays installed until cleanup completes: a second
    // SIGINT/SIGTERM during the grace window must hit the gate's
    // fire-once latch, not the default disposition, or codemux dies
    // mid-drain and the tree it was about to kill survives it.
    const proc = this.proc;
    let childCode: number | null = null;
    if (proc !== null) {
      // agy has no interrupt; the stdin close is its only end carrier.
      // The input loop finishes the line it is running and exits, so the
      // wait is for the exit itself (or a failure raising the code),
      // bounded by the grace, before any signal (review live17 — SIGTERM
      // used to go out at once and the harness never saw EOF, so an open
      // turn was always the synthesized `interrupted` with null usage).
      proc.endInput();
      const startCode = this.endExitCode;
      await proc.awaitEndAnswer(() => this.endExitCode > startCode);
      proc.requestStop();
      await proc.settled;
      childCode = (await proc.exited).code;
    }
    // Non-null exactly when the child's exit is itself a failure the
    // verdict below reports (review live9): nonzero, not the 143 coded
    // signal death, not a crash end (which emitted its own fatal). A
    // delivered result excuses nothing: no exit convention was ever
    // recorded for agy (review live18 — it used to excuse every code).
    const drainFailureCode =
      childCode !== null &&
      childCode !== 0 &&
      childCode !== SESSION_SIGNAL_EXIT_CODE &&
      reason !== "crash"
        ? childCode
        : null;
    if (drainFailureCode !== null) {
      // The agy process exited nonzero — its turn still open, no turn
      // open at all (review live17), or after its result (review
      // live18): a failure while persisting during the shutdown,
      // reported as one (review live9). Exempt: a signal death (code null, or
      // 143 — a wrapper answering the SIGTERM with an exit code), and a
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
        drainFailureMessage("agy", drainFailureCode, this.fsm.state === "turn_active")
      );
    }
    if (turnOpenAtFinish && this.fsm.state === "turn_active") {
      // Review live10: agy has no interrupt carrier, so an end path with a
      // turn open leaves that turn's `turn_started` unanswered — every
      // other driver closes the pairing (claude and codex through the
      // end-interrupt's drained result). Synthesize the completion the
      // harness cannot: codemux-originated (raw null), the usage it
      // never reported all-null. Interrupted on the non-failure exits
      // (a signal death or its coded spellings, the session-end story);
      // failed on a crash end, whose fatal already reported the exit —
      // the crash used to skip the synthesis entirely, leaving the
      // `turn_started` unpaired (review live11) — and on a drain-failure
      // exit, whose verdict above just reported it the same way: the
      // two blocks used to be mutually exclusive, so the one exit class
      // the verdict reported was the one class the synthesis refused to
      // answer (review live12). The FSM is still `turn_active` here by
      // construction (a drained completion would have left it), so the
      // transition is legal; its failure is a codemux defect and costs
      // success.
      const turnId = this.fsm.activeTurn;
      const error = this.fsm.transition({
        kind: "turn_completed",
        turnId: turnId ?? "none",
      });
      if (error !== null) {
        this.endExitCode = Math.max(this.endExitCode, 1);
        this.emitError(true, "codemux", error.message);
      } else {
        const synthFinish =
          reason === "crash" || drainFailureCode !== null || this.firstFatal !== null
            ? "failed"
            : "interrupted";
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_completed", null, {
            turn_id: turnId,
            finish: synthFinish,
            reason:
              reason === "crash"
                ? crashSynthesisReason(this.firstFatal)
                : drainFailureCode !== null
                  ? drainFailureMessage("agy", drainFailureCode, true)
                  : this.firstFatal !== null
                    // A fatal raised during an orderly end's drain (an
                    // overlong line, an unknown response id) is a failure too
                    // (review live22).
                    ? crashSynthesisReason(this.firstFatal)
                    : `the session ended (${reason}) before the turn completed`,
            usage: emptyUsage(),
          })
        );
        // The synthesized completion is a turn the caller saw complete, so
        // it gets its ledger line like any other (all-null usage: the
        // harness never reported one).
        appendSessionTurnCallRecord(
          this.callLedger,
          this.ledgerSessionId(),
          turnId ?? "none",
          this.turnStartedAt.get(turnId ?? "") ?? Date.now(),
          synthFinish,
          emptyUsage()
        );
        this.turnStartedAt.delete(turnId ?? "");
      }
    }
    // The child is dead and the pipes are drained: nothing more can
    // arrive, so the harness side closes for good. The FSM transitions
    // wait until here so a result completing the open turn during the
    // drain could still leave `turn_active` through its own
    // `turn_completed`.
    this.settled = true;
    this.fsm.transition({ kind: "shutdown_started" });
    this.fsm.transition({ kind: "ended" });
    const ownsRecord = this.registryRecorded || this.resumeClaimed;
    if (
      ownsRecord &&
      this.options.registryPath !== null &&
      this.conversationId !== null
    ) {
      // A lost stamp rides stderr (releaseSessionRecord, review live13).
      releaseSessionRecord(this.options.registryPath, this.conversationId);
    }
    // Resumable means a result named this conversation, or, for a
    // recorded or claimed session agy never confirmed, that the end did
    // not fail (exit 0): a resume agy refused dies on the crash path or
    // fails the drain, and reporting it resumable would send a retrying
    // caller into the same failure (review live21). The record alone is no proof
    // here — a resumed session records at spawn. A resume that ended
    // cleanly before its first turn keeps the record the claim judged
    // (review live20). Either way the registry must hold the record:
    // a confirmed session whose start could not be recorded is one
    // `--resume` cannot find (exit 66), so it is not resumable — the
    // claude driver's rule (review live22).
    const resumable =
      this.capabilities.resume &&
      ownsRecord &&
      (this.harnessConfirmed || this.endExitCode === 0);
    const sent = this.out.enqueue(
      buildEvent(++this.seq, this.sessionIdOrEmpty(), "session_ended", null, {
        reason,
        exit_code: childCode,
        usage: this.cumulative,
        resumable,
      })
    );
    // The closing ledger line: the same cumulative usage and end verdict
    // the caller just received (call-log.ts).
    appendSessionCallRecord(
      this.callLedger,
      this.ledgerSessionId(),
      this.sessionStartedAt,
      reason,
      childCode,
      this.cumulative
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

  private recordStart(): void {
    if (this.options.registryPath === null || this.conversationId === null) return;
    const outcome = recordSessionStart(this.options.registryPath, {
      id: this.conversationId,
      agent: "agy",
      cwd: this.options.cwd,
      hermetic: false,
      harness_home: this.options.harnessHome,
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

  /** Events before the first identity-bearing fact carry an empty
   * session id — the alternative would be buffering the first user line
   * forever, since its result is what names the conversation. */
  private sessionIdOrEmpty(): string {
    return this.conversationId ?? "";
  }

  /** The id the call ledger keys this session's records by: the harness's
   * own conversation id once a result frame has named one (the registry
   * key, stable across a resume), else the codemux-minted id every session
   * owns from construction — never "", which merged every id-less session
   * under one key in `calls --sum` (review ul6). */
  private ledgerSessionId(): string {
    return this.conversationId || this.codemuxSessionId;
  }

  private emit(line: string): void {
    this.out.enqueue(line);
  }

  private ack(inputSeq: number, accepted: boolean, reason?: InputRejectionReason): void {
    this.emit(
      buildInputAck(++this.seq, this.sessionIdOrEmpty(), inputSeq, accepted, reason)
    );
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

  private writeToHarness(line: string): void {
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

  private clearTimers(): void {
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
