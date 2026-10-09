/**
 * The claude-family session driver (design §4.2, §4.6): the launcher-owned
 * context that turns one SessionProcess plus the caller's stdin into the
 * event stream. All per-run state lives here — the FSM, the parser, the
 * pending-permission timers, the output queue, the registry writes — never
 * on a singleton adapter. The driver never throws across the stream: every
 * failure is an event, an end path, or both.
 *
 * Turn model: claude print mode has no turn-started event of its own, so
 * codemux owns the boundary — a turn starts when an accepted input is
 * submitted from idle, ends at the harness's `result`. One input, one
 * result: a `user` line while a turn runs is rejected `busy`
 * (`user_during_turn: false`). The wire gives a mid-turn line no stable
 * turn — print mode folds it into the running turn when that turn makes
 * another model request (fixture zai-session-a.ndjson: one result answers
 * both) and answers it in a result of its own when it does not (review
 * live21, both recorded live) — so codemux cannot know which result
 * answers it and does not forward it.
 */

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { AutonomyLevel, ResultUsageBlock } from "../types.js";
import {
  appendSessionCallRecord,
  appendSessionTurnCallRecord,
  providerHost,
  type SessionCallContext,
} from "../call-log.js";
import { emptyUsage } from "../result-envelope.js";
import { claudeCeiling } from "./ceiling.js";
import {
  buildControlErrorResponse,
  buildControlResponse,
  buildHarnessUserMessage,
  buildInterruptRequest,
  claudeSessionCapabilities,
  ClaudeStreamParser,
  type ClaudeParse,
} from "./claude-session.js";
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
  buildPermissionResolved,
  buildUnknownEvent,
  buildUserMessage,
  parseInputLine,
  type InputMessage,
  type InputRejectionReason,
} from "./protocol.js";
import {
  discardUnconfirmedRecord,
  releaseSessionRecord,
  recordSessionStart,
  touchSession,
  type SandboxTrust,
  type UpdateOutcome,
} from "./registry.js";

export interface SessionDriverOptions {
  agent: "claude" | "zai";
  /** The id codemux asked the harness for (`--session-id`) or resumed. */
  sessionId: string;
  autonomy: AutonomyLevel;
  model?: string;
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
  /** Whether the sandbox-scoped Playwright MCP is on; recorded for the
   * resume guard (review live16). */
  playwrightMcp: boolean;
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
  /** Injectable event sink; defaults to codemux stdout, one line each. */
  sink?: (line: string) => Promise<void> | void;
}

export type SessionEndReason =
  | "shutdown"
  | "stdin-close"
  | "signal"
  | "timeout"
  | "crash";

import { addTurnUsage } from "./usage.js";

type Timer = ReturnType<typeof setTimeout>;

export class ClaudeSessionDriver {
  private readonly fsm = new SessionFsm();
  private readonly parser = new ClaudeStreamParser();
  private readonly capabilities = claudeSessionCapabilities();
  private readonly out: BoundedOutboundQueue;
  private readonly pendingTimers = new Map<string, Timer>();
  /** The request facts the ceiling judges; membership lives in the FSM. */
  private readonly pendingRequests = new Map<
    string,
    { tool: string; input: Record<string, unknown> }
  >();
  /** Derived file-change candidates waiting on their tool's result
   * (§4.3): stashed when the tool_use frame arrives — before the
   * permission round-trip — and emitted as `file_change` only when the
   * matching tool_result reports success. A denied or failed call
   * changed nothing, so its candidate is dropped silently; entries left
   * behind at session end (a tool that never reported) stay unreported
   * the same way — an unknown outcome is not a change (review live10). */
  private readonly pendingFileChanges = new Map<
    string,
    { path: string; action: "add" | "edit"; rawLine: string }
  >();
  private proc: SessionProcess | null = null;
  private readonly earlyLines: string[] = [];
  private readonly signals: SessionSignalGate;
  private seq = 0;
  private turnCounter = 0;
  // Interrupt request ids live in their own namespace: turns are named
  // t1, t2, … for the caller, and an interrupt must never shift that
  // numbering.
  private interruptCounter = 0;
  /** A `user` line accepted and forwarded before the init frame: its turn
   * opens codemux-side when that frame arrives. While it is set the
   * session counts as mid-turn, so a second line is rejected `busy`
   * rather than handed to a harness that may fold both into one result
   * (review live21). */
  private openerPending = false;
  /** The pending opener was already forwarded when the end began: the
   * harness may still run it inside the drain, where no turn can open
   * for it (review live16). */
  private forwardedAtEnd = false;
  private interruptPending = false;
  /** The request id of the outstanding interrupt, caller or end path: a
   * refusal clears the pending interrupt only when it answers this id
   * (review live23: the end path's `interrupt-end-N` never matched a
   * comparison rebuilt from the caller spelling). */
  private interruptId: string | null = null;
  private interruptFromTimeout = false;
  /** Starts unknown (all-null), not zero: a counter a turn never reports
   * must stay null rather than be guessed as 0 (§4.2). */
  private cumulative: ResultUsageBlock = emptyUsage();
  private registryRecorded = false;
  /** The CLI claimed this session's record for a resume before the spawn
   * (`adoptResumeClaim`). The claim makes this process the record's
   * owner before the init frame, which arrives only after the caller's
   * first input, so every end path must release it and report the
   * session resumable even when no turn ever ran (review live20). */
  private resumeClaimed = false;
  /** The session's record was written before the spawn
   * (`recordBeforeSpawn`), fresh and resumed alike. The init frame
   * arrives only after the caller's first input reached the harness, so
   * recording there let a turn run in a session the registry could not
   * track (review live22). The init frame then only confirms the
   * session; it writes nothing. */
  private recordedBeforeSpawn = false;
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
   * harness can finish persisting and say so — its final result,
   * messages, and usage arrive during it and must reach the caller
   * (review live5). `finished` alone is the end path's re-entry guard
   * and flips at its start. */
  private settled = false;
  /** An INTERRUPTED completion delivered inside the drain. Only this
   * exempts a nonzero child exit, and only exit code 1: claude-family
   * exits 1 after an interrupted turn by convention (step-0 probe 4).
   * Any other nonzero exit, or exit 1 with no interrupted turn answered,
   * is a failure while persisting (review live18 — every nonzero exit
   * after any drained completion used to read as success). */
  private drainedInterrupted = false;
  /** An `interrupt` the caller sent while the forwarded first input's
   * turn could not open yet (the FSM still `starting`, waiting for the
   * init frame). It is delivered the moment that turn opens, so the ack
   * the caller got is honored (review live18 — it was a no-op and the
   * turn ran to completion). */
  private interruptBeforeInit = false;
  /** The input_seq of the caller interrupt held for the init frame, so a
   * delivery the harness refuses then names the line it acked (review
   * live23). */
  private interruptBeforeInitSeq: number | null = null;
  private stdinClosed = false;
  /** The first fatal the session reported: the reason a crash end's
   * synthesized turn completion carries, so it names the failure that
   * ended the session rather than assuming the process died (review
   * live17 — an outbound overflow or a registry failure is a crash end
   * with the harness alive). */
  private firstFatal: string | null = null;
  /** Whether the open turn's `--turn-timeout` already fired its
   * interrupt; a second expiry on the same turn ends the session. */
  private turnTimeoutFired = false;
  private turnTimer: Timer | null = null;
  private sessionTimer: Timer | null = null;
  /** The wall clock each open turn started at, keyed by turn id: the
   * ledger's session_turn records carry each turn's own duration. */
  private readonly turnStartedAt = new Map<string, number>();
  /** The session's own start, for the closing ledger record's duration. */
  private readonly sessionStartedAt = Date.now();
  /** The launch facts the call ledger records on every turn and at the
   * end (call-log.ts); the provider is the override's host or "default". */
  private readonly callLedger: SessionCallContext;
  private readonly done: Promise<number>;
  private resolveDone!: (code: number) => void;

  constructor(private readonly options: SessionDriverOptions) {
    this.done = new Promise<number>((resolve) => {
      this.resolveDone = resolve;
    });
    this.callLedger = {
      agent: options.agent,
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
   * now on, whether or not the harness ever reaches its init frame. */
  adoptResumeClaim(): void {
    this.resumeClaimed = true;
  }

  /** The start record, written by the CLI before the spawn: codemux
   * chose the session id (`--session-id`) or the registry vouched for
   * the resumed one, so nothing about the record waits on the harness.
   * On a resume it follows the claim and updates the claimed record in
   * place with the flags the resume runs under. Returns the failure
   * message, or null once this process owns the record (review live22). */
  recordBeforeSpawn(): string | null {
    const outcome = this.writeStartRecord();
    if (outcome === null) return null;
    if (!outcome.ok) return outcome.error;
    this.recordedBeforeSpawn = true;
    return null;
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
        `the ${this.options.agent} process exited unexpectedly ` +
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
    return this.done;
  }

  /** One line from the harness stdout. Never throws. Lines are parsed and
   * emitted until the end path settles (`settled`): the shutdown grace
   * window is exactly the interval in which the harness's last output —
   * the interrupted turn's result, its usage — is still arriving, and
   * dropping it there would report a session that ended mid-sentence. */
  handleHarnessLine(line: string): void {
    if (this.proc === null) {
      this.earlyLines.push(line);
      return;
    }
    if (this.settled) return;
    const wasEnding = this.finished;
    const parses = this.parser.feed(line, {
      expectedSessionId: this.options.sessionId,
    });
    for (const parse of parses) {
      this.applyParse(parse, line);
      // A parse that started the end path ends this line's application;
      // parses that arrive while an already-running end path drains still
      // apply, all the way to settlement.
      if (this.settled || (!wasEnding && this.finished)) return;
    }
  }

  /** A fatal from the process layer: tier-3 harness output (non-UTF-8,
   * line overflow) or a handler exception, which is codemux's own defect
   * and is reported as such, never as unusable harness output. */
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
      // `settled`) the answer is the `shutting_down` rejection, the same
      // reason the protocol layer's gate specifies (review live9: the
      // gate was unreachable dead code while this guard dropped lines
      // unacknowledged). Once `settled`, `session_ended` is already on
      // the stream and nothing may follow it, so later lines are dropped.
      if (!this.settled) this.ack(this.fsm.nextInputSeq(), false, "shutting_down");
      return;
    }
    const inputSeq = this.fsm.nextInputSeq();
    const parsed = parseInputLine(line, {
      capabilities: this.capabilities,
      hasActiveTurn: this.fsm.state === "turn_active" || this.openerPending,
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
        // `steer` never reaches this arm (the claude-family capability is
        // false, rejected `unsupported` above), and neither does a `user`
        // line while a turn runs (`user_during_turn: false`, rejected
        // `busy`): every line here opens a turn, now or at init.
        const harnessText = applyAuthorPrefix(
          message.text,
          message.author,
          this.options.authorPrefix
        );
        const harnessLine = buildHarnessUserMessage(harnessText);
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
        const turnId = this.fsm.state === "idle" ? this.startTurn() : null;
        if (turnId === null) this.openerPending = true;
        this.emit(
          buildUserMessage(
            ++this.seq,
            this.options.sessionId,
            inputSeq,
            message.text,
            message.author,
            turnId
          )
        );
        this.writeToHarness(harnessLine);
        return;
      }
      case "interrupt": {
        if (this.fsm.state === "starting" && this.openerPending) {
          // A `user` line was already forwarded, so the harness runs that
          // turn as soon as it starts; the turn opens codemux-side with the
          // init frame, and the interrupt rides that moment.
          this.ack(inputSeq, true);
          this.interruptBeforeInit = true;
          this.interruptBeforeInitSeq = inputSeq;
          return;
        }
        // No active turn: an acknowledged no-op (§4.1).
        if (this.fsm.state !== "turn_active") {
          this.ack(inputSeq, true);
          return;
        }
        // §4.1: a pending request is answered deny on interrupt, before
        // the turn closes (permission_resolved: "superseded") — it must
        // not keep a timer running against a turn that is ending.
        this.supersedePendingDeny("codemux: denied: the turn was interrupted");
        // Written before the ack: a refused write started the crash end,
        // and an accepted ack would report an interrupt the harness never
        // got (review live23, the codex sibling's finding). A refused
        // deny above already started that end, whose own interrupt must
        // stay the pending one, so nothing more is written.
        if (!this.finished) this.sendInterrupt();
        if (this.finished) {
          this.rejectUndelivered(inputSeq);
          return;
        }
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
   * reported and costs success (review live17 — it used to exit 0). */
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

  private applyParse(parse: ClaudeParse, rawLine: string): void {
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
        this.emit(buildUnknownEvent(++this.seq, this.options.sessionId, rawLine));
        this.emitError(true, "harness", parse.message);
        void this.finish("crash", 1);
        return;
      case "init": {
        const error = this.fsm.transition({ kind: "session_started" });
        if (error !== null) {
          this.emitGrammarViolation(rawLine, error.message);
          void this.finish("crash", 1);
          return;
        }
        this.recordStart();
        // The announcement follows the record's verdict: a required
        // record that failed must not announce — §4.8's fail-closed rule,
        // nothing is vouchable (and `settled` alone would let the drained
        // init of a registry-failed start announce) — while a record that
        // succeeded announces even while an end path drains, so the
        // registry and the caller agree the session existed. A null
        // registryPath records nothing and always announces.
        if (
          this.settled ||
          (this.options.registryPath !== null && !this.registryRecorded)
        ) {
          return;
        }
        this.emit(
          buildEvent(++this.seq, this.options.sessionId, "session_started", null, {
            agent: this.options.agent,
            model: this.options.model ?? null,
            autonomy: this.options.autonomy,
            cwd: this.options.cwd,
            sandboxed: this.options.sandboxed,
            sandbox_trust: this.options.sandboxTrust,
            capabilities: this.capabilities,
            protocol: "codemux-live-session/1",
          })
        );
        // Input accepted before the init frame arrived was forwarded but
        // only counted; opening the session must also open that turn, or
        // the first result meets an idle FSM and ends the session
        // fatally. This is the pre-init-arrival path (the CLI spawns the
        // harness and immediately relays caller stdin).
        if (this.openerPending && !this.finished) {
          this.openerPending = false;
          const opened = this.startTurn();
          if (opened !== null && this.interruptBeforeInit) {
            this.interruptBeforeInit = false;
            if (!this.sendInterrupt()) {
              this.emitError(
                false,
                "codemux",
                `the interrupt accepted before the session started (input_seq ${this.interruptBeforeInitSeq}) could not be delivered`
              );
            }
          }
        }
        return;
      }
      case "assistant_delta":
        this.emit(
          buildEvent(++this.seq, this.options.sessionId, "assistant_delta", rawLine, {
            delta: parse.text,
            turn_id: this.fsm.activeTurn,
          })
        );
        return;
      case "assistant_text":
        this.emit(
          buildEvent(++this.seq, this.options.sessionId, "assistant_message", rawLine, {
            text: parse.text,
            turn_id: this.fsm.activeTurn,
          })
        );
        return;
      case "tool_call":
        this.emit(
          buildEvent(++this.seq, this.options.sessionId, "tool_call", rawLine, {
            call_id: parse.callId,
            name: parse.name,
            input: parse.input,
          })
        );
        return;
      case "tool_result": {
        this.emit(
          buildEvent(++this.seq, this.options.sessionId, "tool_result", rawLine, {
            call_id: parse.callId,
            output: parse.output,
            is_error: parse.isError,
          })
        );
        // The derived change confirms here, not at the tool_use frame:
        // only a successful result proves the write happened (review
        // live10 — the frame arrives before the permission round-trip,
        // so emitting there reported changes that were then denied).
        const candidate = this.pendingFileChanges.get(parse.callId);
        if (candidate !== undefined) {
          this.pendingFileChanges.delete(parse.callId);
          if (!parse.isError) {
            this.emit(
              buildEvent(
                ++this.seq,
                this.options.sessionId,
                "file_change",
                candidate.rawLine,
                {
                  path: candidate.path,
                  action: candidate.action,
                  derived: true,
                }
              )
            );
          }
        }
        return;
      }
      case "file_change":
        // Stash, not emit: the tool_use frame only names a candidate.
        // The Write add/edit split reads the workspace now — before the
        // tool runs — because after a successful write the file always
        // exists; the frame order preserves correctness, each call
        // arriving after the previous tool's result. The existsSync
        // resolves a relative target against the SESSION cwd — the same
        // literal join the ceiling uses — not codemux's own working
        // directory, which the harness never runs in (review live15).
        this.pendingFileChanges.set(parse.callId, {
          path: parse.path,
          action: this.writeAction(parse),
          rawLine,
        });
        return;
      case "permission_request": {
        const error = this.fsm.addPending(parse.requestId);
        if (error !== null) {
          this.emitGrammarViolation(rawLine, error.message);
          void this.finish("crash", 1);
          return;
        }
        this.pendingRequests.set(parse.requestId, {
          tool: parse.tool,
          input: parse.input,
        });
        this.emit(
          buildEvent(
            ++this.seq,
            this.options.sessionId,
            "permission_request",
            rawLine,
            {
              request_id: parse.requestId,
              tool: parse.tool,
              input: parse.input,
              options: ["allow", "deny"],
            }
          )
        );
        if (this.finished) {
          // A request landing inside the shutdown drain can never be
          // decided: caller input is already refused once an end request
          // began, and the expiry timer is cleared with every other on
          // the end path — it could only fire at a session that is gone.
          // Deny it at once with the same supersede treatment `finish`
          // gave the requests it found pending (review live8), so the
          // harness never waits on a permission the ending session
          // cannot grant.
          this.supersedePendingDeny("codemux: denied: the session is ending");
          return;
        }
        const timer = setTimeout(
          () => this.expirePermission(parse.requestId),
          this.options.permissionTimeoutMs
        );
        timer.unref?.();
        this.pendingTimers.set(parse.requestId, timer);
        return;
      }
      case "unparseable_permission": {
        // A can_use_tool whose payload cannot be read (§4.1's opaque
        // rule): answered deny keyed by request_id so the harness never
        // hangs, the raw frame passes through, and a non-fatal error
        // tells the caller what was denied. Never fatal on shape alone.
        // The raw line goes out before the answer: a refused write ends
        // the session, and its fatal must follow the line, with no
        // "answered" notice after it (review live23).
        this.emit(buildUnknownEvent(++this.seq, this.options.sessionId, rawLine));
        const denied = this.writeToHarness(
          buildControlResponse(
            parse.requestId,
            "deny",
            undefined,
            "codemux: denied: the permission request could not be parsed"
          )
        );
        if (!denied) return;
        this.emitError(
          false,
          "harness",
          "a can_use_tool request could not be parsed; answered deny"
        );
        return;
      }
      case "unsupported_control_request": {
        // A control request codemux does not implement: answered with the
        // control protocol's error response when its id can be echoed, so
        // the harness never waits on it, then passed through raw with a
        // non-fatal error (review live18; codex answers its unknown server
        // requests with -32601 the same way). Never fatal on shape alone.
        // Raw line first, then the answer (review live23, as above).
        this.emit(buildUnknownEvent(++this.seq, this.options.sessionId, rawLine));
        if (
          parse.requestId !== null &&
          !this.writeToHarness(
            buildControlErrorResponse(
              parse.requestId,
              `codemux does not implement the ${parse.subtype} control request`
            )
          )
        ) {
          return;
        }
        this.emitError(
          false,
          "harness",
          parse.requestId !== null
            ? `the harness sent a control request codemux does not implement (${parse.subtype}); it was answered with an error`
            : `the harness sent a control request with no usable request id (${parse.subtype}); it could not be answered`
        );
        return;
      }
      case "turn_completed":
        this.completeTurn(parse, rawLine);
        return;
      case "control_error":
        this.emit(buildUnknownEvent(++this.seq, this.options.sessionId, rawLine));
        if (
          this.interruptPending &&
          parse.requestId === this.interruptId
        ) {
          // The harness refused the interrupt: it never happened, so it
          // must not label the turn's own error result interrupted (or
          // turn-timeout), excuse a drain exit, or hold the end path's
          // grace window open (review live22; the codex driver's
          // rejected-interrupt rule).
          this.interruptPending = false;
          this.interruptFromTimeout = false;
          this.emitError(false, "harness", `the harness rejected the interrupt: ${parse.error}`);
        }
        return;
      case "unknown":
        this.emit(buildUnknownEvent(++this.seq, this.options.sessionId, rawLine));
        return;
    }
  }

  private completeTurn(
    parse: Extract<ClaudeParse, { kind: "turn_completed" }>,
    rawLine: string
  ): void {
    if (this.finished && this.fsm.state !== "turn_active" && this.forwardedAtEnd) {
      // The harness ran the forwarded pre-init input inside the drain
      // (see finish): its result answers no turn the caller saw open, so
      // it is mirrored, never fatal and never silently dropped.
      this.forwardedAtEnd = false;
      // Its usage is real and the caller sees it raw, so it folds into
      // the session total (review live22).
      this.cumulative = addTurnUsage(this.cumulative, parse.usage);
      this.emit(buildUnknownEvent(++this.seq, this.options.sessionId, rawLine));
      return;
    }
    if (this.fsm.state === "starting") {
      // A result with no init frame before it: the harness answered the
      // forwarded first line without starting a session. A refused
      // `--resume` (a transcript that no longer exists) ends this way,
      // then exits 1 (review live21, recorded live). The line was
      // answered, so the end path's "may still run it" notice would be
      // false; the result goes out raw, its `errors` naming the reason.
      this.openerPending = false;
      this.cumulative = addTurnUsage(this.cumulative, parse.usage);
      this.emitGrammarViolation(
        rawLine,
        `the ${this.options.agent} process sent a result before its init frame, so no session started ` +
          "(a refused --resume ends this way; the result's errors and codemux's stderr carry the reason)"
      );
      void this.finish("crash", 1);
      return;
    }
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
    // Interrupt labeling is decided here, not in the parser: an
    // interrupted turn arrives as an ERROR result by convention (step-0
    // probe 4), so an error result with an interrupt outstanding is the
    // interrupt striking — interrupted. A CLEAN result with an interrupt
    // outstanding means the interrupt missed: the result was already in
    // flight when the interrupt was written, so the turn ends honestly
    // (review live12). The missed interrupt is spent with it: the harness
    // reads it idle and drops it, because no later turn can be waiting
    // harness-side — a mid-turn `user` line is rejected `busy`, so the
    // next turn's line is written only after this result. (Review live12
    // kept it pending for one more turn, and live20 narrowed that roll to
    // the interrupted shape; both modeled a forwarded mid-turn line the
    // harness had queued, which review live21 removed.)
    const struck = parse.isError && this.interruptPending;
    const finish = struck ? "interrupted" : parse.isError ? "failed" : "end";
    const reason = struck && this.interruptFromTimeout ? "turn-timeout" : parse.reason;
    this.interruptPending = false;
    this.interruptFromTimeout = false;
    this.clearTurnTimer();
    // A turn the harness ended by itself may still hold permission
    // requests open: they belong to a turn that no longer exists, and a
    // later decision would be acked for a request the harness no longer
    // holds while the expiry timer writes a stray deny into whatever
    // turn runs next — the same supersede every other turn-closing path
    // applies (review live11, the codex sibling's finding).
    this.supersedePendingDeny("codemux: denied: the turn completed before the decision");
    if (this.finished) {
      // This completion landed inside the shutdown drain: the harness
      // answered the end-interrupt (or delivered its own final result)
      // before dying. Only an interrupted one carries the exit-1
      // convention (review live9, narrowed in live18).
      if (finish === "interrupted") this.drainedInterrupted = true;
    }
    // Cost rides outside the token sums: the result's `total_cost_usd`
    // is the harness's own session-lifetime figure (each turn's already
    // includes the earlier ones), so the cumulative adopts it rather
    // than adding it (usage.ts, review live8).
    this.cumulative = addTurnUsage(this.cumulative, parse.usage);
    // The per-turn event carries no cost (review live10): the only cost
    // figure the wire reports (`total_cost_usd`) is session-lifetime —
    // each turn's already includes the earlier ones — so mirroring it
    // next to per-turn token counts invited callers to sum overlapping
    // figures. The cumulative fold above keeps the real figure for
    // `session_ended.usage.cost_usd`, where the wire's own number
    // belongs.
    this.emit(
      buildEvent(++this.seq, this.options.sessionId, "turn_completed", rawLine, {
        turn_id: turnId,
        finish,
        ...(reason !== null ? { reason } : {}),
        usage: { ...parse.usage, cost_usd: null },
      })
    );
    // The ledger's turn record mirrors the event the caller just saw; the
    // session's closing record carries the cumulative cost this turn's
    // fold adopted, so the per-turn line stays cost-free like the event.
    appendSessionTurnCallRecord(
      this.callLedger,
      this.options.sessionId,
      turnId ?? "none",
      this.turnStartedAt.get(turnId ?? "") ?? Date.now(),
      finish,
      { ...parse.usage, cost_usd: null }
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
      const outcome = touchSession(this.options.registryPath, this.options.sessionId, {
        attempts: 1,
      });
      if (!outcome.ok && !this.touchWarned) {
        this.touchWarned = true;
        console.error(
          `codemux: cannot stamp the session registry for ${this.options.sessionId} ` +
            `(${outcome.error}); activity tracking may lag`
        );
      }
    }
  }

  private startTurn(): string | null {
    this.turnCounter += 1;
    const turnId = `t${this.turnCounter}`;
    const error = this.fsm.transition({ kind: "turn_started", turnId });
    if (error !== null) {
      this.emitError(true, "harness", error.message);
      void this.finish("crash", 1);
      return null;
    }
    this.emit(
      buildEvent(++this.seq, this.options.sessionId, "turn_started", null, {
        turn_id: turnId,
      })
    );
    this.turnStartedAt.set(turnId, Date.now());
    this.turnTimeoutFired = false;
    this.armTurnTimer();
    return turnId;
  }

  /** `--turn-timeout` (§4.5): the first expiry interrupts the turn and
   * re-arms; a second expiry on the same turn means the interrupt did not
   * end it (refused, lost, or ignored), so the cap ends the session
   * instead of letting the turn run uncapped (review live17 — the timer
   * fired once and never re-armed). */
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
      // §4.1: the turn timeout denies pending requests too, then
      // interrupts the turn; the session continues. The timeout label
      // rides only an interrupt that was written (review live23).
      this.supersedePendingDeny("codemux: denied: the turn timed out");
      if (this.finished) return;
      if (this.sendInterrupt()) this.interruptFromTimeout = true;
      this.armTurnTimer();
    }, this.options.turnTimeoutMs);
    this.turnTimer.unref?.();
  }

  /** A refused write marks nothing pending (review live23): the crash
   * end it started must not read a drained error result as interrupted. */
  private sendInterrupt(): boolean {
    this.interruptCounter += 1;
    const interruptId = `interrupt-${this.interruptCounter}`;
    if (!this.writeToHarness(buildInterruptRequest(interruptId))) return false;
    this.interruptId = interruptId;
    this.interruptPending = true;
    return true;
  }

  private expirePermission(requestId: string): void {
    if (this.finished || !this.fsm.isPending(requestId)) return;
    this.writeToHarness(
      buildControlResponse(
        requestId,
        "deny",
        undefined,
        "codemux: denied: the permission timeout elapsed with no decision"
      )
    );
    this.resolvePending(requestId, "timeout");
  }

  /** The add/edit split for a derived file-change candidate (§4.3): a
   * Write over an existing target is an edit, over a missing one an add
   * — read at stash time, before the tool runs. The target resolves
   * against the session cwd the harness runs in (the ceiling's literal
   * join: absolute kept, relative prefixed), because a relative
   * `file_path` is relative to THAT directory, never to codemux's own
   * process cwd (review live15). Edit and NotebookEdit only ever
   * modify, so they are edits regardless. */
  private writeAction(parse: Extract<ClaudeParse, { kind: "file_change" }>): "add" | "edit" {
    if (!parse.write) return "edit";
    const target = isAbsolute(parse.path)
      ? parse.path
      : `${this.options.cwd}/${parse.path}`;
    return existsSync(target) ? "edit" : "add";
  }

  private applyPermissionDecision(
    inputSeq: number,
    message: Extract<InputMessage, { type: "permission_decision" }>
  ): void {
    const request = this.pendingRequests.get(message.request_id);
    if (request === undefined) {
      this.ack(inputSeq, false, "unknown_request");
      return;
    }
    if (message.decision === "allow") {
      // The ceiling judges the action that will actually run: the
      // substituted arguments when the answer carries them (§4.1). The
      // same object is what the allow sends: the harness runs the tool
      // with the answer's `updatedInput`, so a plain allow carries the
      // request's own input (review live18).
      const effective = message.updated_input ?? request.input;
      const verdict = claudeCeiling(
        this.options.autonomy,
        request.tool,
        effective,
        this.options.cwd
      );
      if (!verdict.allowable) {
        this.writeToHarness(
          buildControlResponse(
            message.request_id,
            "deny",
            undefined,
            `codemux: denied by the autonomy ceiling: ${verdict.reason}`
          )
        );
        this.resolvePending(message.request_id, "deny");
        this.ack(inputSeq, false, "autonomy_escalation");
        return;
      }
      const answer = buildControlResponse(message.request_id, "allow", effective);
      if (!harnessLineDeliverable(answer)) {
        // An `updated_input` too large for the harness write cap cannot be
        // delivered; acking it would report an answer the write then
        // refuses, crashing the session (review live18). The request stays
        // pending, so the caller can answer again within the bound.
        this.ack(inputSeq, false, "text_too_long");
        return;
      }
      if (!this.writeToHarness(answer)) {
        this.rejectUndelivered(inputSeq);
        return;
      }
      this.resolvePending(message.request_id, "allow");
      this.ack(inputSeq, true);
      return;
    }
    if (!this.writeToHarness(buildControlResponse(message.request_id, "deny"))) {
      this.rejectUndelivered(inputSeq);
      return;
    }
    this.resolvePending(message.request_id, "deny");
    this.ack(inputSeq, true);
  }

  /** A decision whose answer never reached the harness: the refused
   * write already started the crash end, which superseded the request,
   * so the decision is rejected `shutting_down` rather than acked as
   * accepted (review live20). */
  private rejectUndelivered(inputSeq: number): void {
    this.ack(inputSeq, false, "shutting_down");
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
    this.pendingRequests.delete(requestId);
    const error = this.fsm.removePending(requestId);
    if (error !== null) return; // Raced with another resolution path.
    this.emit(
      buildPermissionResolved(
        ++this.seq,
        this.options.sessionId,
        requestId,
        resolution
      )
    );
  }

  // --- end path ----------------------------------------------------------

  /** Answer every pending request deny and emit `superseded` (§4.1): turn
   * completion, interrupt, `--turn-timeout`, and every end path close the
   * permission channel first — a request whose turn is closing must not
   * keep a timer running against a session that moved on. */
  private supersedePendingDeny(message: string): void {
    for (const requestId of this.fsm.supersedePending()) {
      this.writeToHarness(buildControlResponse(requestId, "deny", undefined, message));
      const timer = this.pendingTimers.get(requestId);
      if (timer !== undefined) clearTimeout(timer);
      this.pendingTimers.delete(requestId);
      this.pendingRequests.delete(requestId);
      this.emit(
        buildPermissionResolved(
          ++this.seq,
          this.options.sessionId,
          requestId,
          "superseded"
        )
      );
    }
  }

  /** Every end path funnels here (§4.6): pending requests are answered
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
    this.interruptBeforeInit = false;
    // A `user` line accepted before the init frame was acked, echoed, and
    // already forwarded, so an end path cannot drop it — the harness may
    // still run it inside the grace window (review live16; the live10
    // notice said "dropped", which was false here). No turn can open
    // during the drain, so such a result is mirrored as `unknown`
    // (completeTurn) rather than read as a grammar violation. The ack
    // cannot be retracted and a second answer per line would break the
    // ack contract, so the caller gets one non-fatal notice instead.
    if (this.openerPending) {
      this.emitError(
        false,
        "codemux",
        `user input accepted before the session started was already forwarded to the ${this.options.agent} process and has no turn; ` +
          "the harness may still run it while shutting down, and any result it produces is mirrored as unknown"
      );
      this.forwardedAtEnd = true;
      this.openerPending = false;
    }
    // Read before the end-interrupt runs: whether a turn was open when
    // the end began decides whether an unanswered turn is synthesized
    // (below); the verdict's wording reads the turn state after the drain.
    const turnOpenAtFinish = this.fsm.state === "turn_active";
    this.supersedePendingDeny("codemux: denied: the session is ending");
    let interruptWritten = false;
    if (
      this.fsm.state === "turn_active" &&
      this.capabilities.interrupt &&
      this.proc !== null
    ) {
      // The end path interrupts before the SIGTERM so the harness can
      // answer and persist its transcript cleanly. The interrupt is
      // pending like any other: a result arriving during the drain below
      // is the interrupted turn's own completion, not a failed one. A
      // refused write (a harness that stopped reading, review live19)
      // marks nothing pending and goes straight to the stop.
      const interruptId = `interrupt-end-${++this.interruptCounter}`;
      const written = this.proc.writeLine(buildInterruptRequest(interruptId));
      interruptWritten = written.ok;
      if (interruptWritten) {
        this.interruptPending = true;
        this.interruptId = interruptId;
      } else if (reason !== "crash") {
        // An orderly end whose interrupt the harness would not take (it
        // stopped reading stdin) is a failure: the turn is stopped by the
        // signal, not interrupted, so it cannot end 0 (review live25). A
        // crash end already reported its own fatal.
        this.endExitCode = Math.max(this.endExitCode, 1);
        this.emitError(
          true,
          "codemux",
          `could not deliver the end-path interrupt to the ${this.options.agent} process ` +
            `(${written.reason ?? "unknown"}); the open turn was stopped by signal`
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
      if (interruptWritten) {
        // The interrupt gets its own grace window before any signal
        // (review live17): the turn closes through its drained result, a
        // failure arriving meanwhile raises the code, or the child exits.
        const startCode = this.endExitCode;
        await proc.awaitEndAnswer(
          () =>
            this.fsm.state !== "turn_active" ||
            this.endExitCode > startCode ||
            !this.interruptPending
        );
      }
      proc.requestStop();
      await proc.settled;
      childCode = (await proc.exited).code;
    }
    // Non-null exactly when the child's exit is itself a failure the
    // verdict below reports (review live9): nonzero, not the 143 coded
    // signal death, not a crash end (which emitted its own fatal), and not
    // the exit-1 convention after an interrupted turn the drain answered
    // (review live18: the exemption covered every nonzero code after any
    // drained completion).
    const drainFailureCode =
      childCode !== null &&
      childCode !== 0 &&
      childCode !== SESSION_SIGNAL_EXIT_CODE &&
      reason !== "crash" &&
      !(childCode === 1 && this.drainedInterrupted)
        ? childCode
        : null;
    if (drainFailureCode !== null) {
      // The child exited nonzero — its turn still open, no turn open at
      // all (review live17: an idle failure used to exit 0), or after a
      // drained completion that does not carry the convention (review
      // live18): a failure while persisting during the shutdown,
      // reported as one (review live9 — the end used to resolve with the
      // initiating success code whatever the child did). Exempt: exit 1
      // after an interrupted turn the drain answered (claude-family's
      // convention, step-0 probe 4), a signal death (code null, the
      // normal kill path for a harness that ignored the interrupt), 143
      // (a wrapper answering the SIGTERM with an exit code — scode
      // parity), and a crash end (the crash path already emitted its
      // own fatal; a second one blaming the drain would be false,
      // review live11). The error event precedes `session_ended` on the
      // stream, so the caller sees the failure and the end that
      // carried it — and the synthesis below pairs the turn this
      // verdict belongs to (review live12: the fatal used to be the
      // turn's only answer, leaving its `turn_started` unpaired exactly
      // when this fired).
      this.endExitCode = Math.max(this.endExitCode, 1);
      this.emitError(
        true,
        "harness",
        drainFailureMessage(
          this.options.agent,
          drainFailureCode,
          this.fsm.state === "turn_active"
        )
      );
    }
    if (turnOpenAtFinish && this.fsm.state === "turn_active") {
      // The turn is still open and nothing else will ever answer it: the
      // crash path's fatal already told the failure story (a crash
      // mid-turn, review live11 — the agy precedent from live10), the
      // child exited without a result on a non-failure exit (a signal
      // death or its coded spellings), or the drain-failure verdict
      // above just fired (review live12 — the two blocks used to be
      // mutually exclusive, so the one exit class the verdict reported
      // was the one class the synthesis refused to answer). §4.1's
      // pairing — every `turn_started` answered — holds only if codemux
      // synthesizes the completion: failed for a crash or a drain
      // failure (the reason mirrors the fatal that reported it),
      // interrupted otherwise; all-null usage (never guessed zeros),
      // raw null (codemux-originated).
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
          buildEvent(++this.seq, this.options.sessionId, "turn_completed", null, {
            turn_id: turnId,
            finish: synthFinish,
            reason:
              reason === "crash"
                ? crashSynthesisReason(this.firstFatal)
                : drainFailureCode !== null
                  ? drainFailureMessage(this.options.agent, drainFailureCode, true)
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
        // it gets its ledger line like any other (all-null usage: nothing
        // reported a turn the harness never answered).
        appendSessionTurnCallRecord(
          this.callLedger,
          this.options.sessionId,
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
    // wait until here so a turn completing during the drain could still
    // leave `turn_active` through its own `turn_completed`.
    this.settled = true;
    this.fsm.transition({ kind: "shutdown_started" });
    this.fsm.transition({ kind: "ended" });
    const ownsRecord =
      this.registryRecorded || this.resumeClaimed || this.recordedBeforeSpawn;
    if (ownsRecord && this.options.registryPath !== null) {
      if (this.recordedBeforeSpawn && !this.registryRecorded && !this.resumeClaimed) {
        // A fresh record the harness never confirmed names no transcript.
        discardUnconfirmedRecord(this.options.registryPath, this.options.sessionId);
      } else {
        // A lost stamp rides stderr (releaseSessionRecord, review live13).
        releaseSessionRecord(this.options.registryPath, this.options.sessionId);
      }
    }
    // Resumable means the harness confirmed the session (the start was
    // recorded at its first identity-bearing frame) or, for a claimed
    // resume it never confirmed, that the end did not fail: a resume the
    // harness refused (a transcript Claude Code already cleaned up, a
    // thread codex cannot load) dies on the crash path or fails the
    // drain, and one that hung until a timeout proved nothing either;
    // reporting it resumable would send a retrying caller into the same
    // failure (review live21). A claimed resume that ended
    // cleanly before its init frame keeps the record the claim judged,
    // and the end stamp above released the claim (review live20).
    const resumable =
      this.capabilities.resume &&
      (this.registryRecorded ||
        (this.resumeClaimed && this.endExitCode === 0));
    const sent = this.out.enqueue(
      buildEvent(++this.seq, this.options.sessionId, "session_ended", null, {
        reason,
        exit_code: childCode,
        usage: this.cumulative,
        resumable,
      })
    );
    // The closing ledger line: the same cumulative usage and end verdict
    // the caller just received.
    appendSessionCallRecord(
      this.callLedger,
      this.options.sessionId,
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
    if (this.recordedBeforeSpawn) {
      // The record exists and this process owns it; the init frame is
      // the harness's confirmation, and no write waits on the lock here.
      this.registryRecorded = true;
      return;
    }
    const outcome = this.writeStartRecord();
    if (outcome === null) return;
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

  /** The start record's one write; null when no registry is configured. */
  private writeStartRecord(): UpdateOutcome | null {
    if (this.options.registryPath === null) return null;
    return recordSessionStart(this.options.registryPath, {
      id: this.options.sessionId,
      agent: this.options.agent,
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
      playwright_mcp: this.options.playwrightMcp,
      provider_base_url: this.options.providerBaseUrl,
    });
  }

  private emit(line: string): void {
    this.out.enqueue(line);
  }

  private ack(inputSeq: number, accepted: boolean, reason?: InputRejectionReason): void {
    this.emit(
      buildInputAck(++this.seq, this.options.sessionId, inputSeq, accepted, reason)
    );
  }

  /** Tier 2 (§4.2): a harness line that breaks the stream's grammar
   * still goes out raw, then the fatal names the violation (review
   * live21 — the FSM-rejected lines were reported but not mirrored, so
   * a refused resume's result frame never reached the caller). */
  private emitGrammarViolation(rawLine: string, message: string): void {
    this.emit(buildUnknownEvent(++this.seq, this.options.sessionId, rawLine));
    this.emitError(true, "harness", message);
  }

  private emitError(fatal: boolean, source: "codemux" | "harness", message: string): void {
    if (fatal && this.firstFatal === null) this.firstFatal = message;
    this.emit(
      buildEvent(++this.seq, this.options.sessionId, "error", null, {
        fatal,
        source,
        message,
      })
    );
  }

  /** Write one line; whether it was delivered. A refused write has
   * already started the crash end when this returns false. */
  private writeToHarness(line: string): boolean {
    const proc = this.proc;
    if (proc === null) return false;
    const result = proc.writeLine(line);
    if (!result.ok) {
      // A line that cannot reach the harness after its ack is a codemux
      // failure, not a diagnostic: the turn or permission it belongs to
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
