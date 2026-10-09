/**
 * The aider session driver (design §4.7): turn-per-process with
 * codemux-owned state. Each caller input spawns one headless aider
 * process against the session's chat history file
 * (src/session/aider-session.ts), writes the canned negative responses,
 * and lets the process run to its exit; the state that carries across
 * turns is aider's own chat history — the transcript the next process
 * replays with --restore-chat-history before appending its exchange.
 *
 * aider's stdout is a human transcript, never a protocol: every line is
 * tier-1 unknown passthrough, raw preserved. The turn's verdict comes
 * from two codemux-side facts instead — the process's exit code, and the
 * chat history delta: the `#### ` section this exchange appended, with
 * the model's reply extracted from it (src/aider-history.ts). The
 * delta is read past a byte offset that advances with each turn, never
 * as the whole file — a session's history accumulates every exchange
 * for the session's whole life and outgrows any whole-file bound
 * (review D8, correctness 2). A history that cannot be read back
 * (symlink, truncation, an oversize turn) is an integrity failure: the
 * session's state is the file, so the session ends rather than
 * continue on state it cannot see.
 *
 * Identity is codemux-owned from the start: the session id is a minted
 * UUID, the record is written before anything spawns
 * (`recordBeforeSpawn`, the claude-family pattern), and session_started
 * is announced at run() start — no deferred identity, because nothing
 * about the id waits on the harness.
 */

import type { AutonomyLevel, ReasoningEffort, ResultUsageBlock } from "../types.js";
import {
  appendSessionCallRecord,
  appendSessionTurnCallRecord,
  providerHost,
  type SessionCallContext,
} from "../call-log.js";
import { emptyUsage } from "../result-envelope.js";
import { HEADLESS_NEGATIVE_RESPONSES, aiderPromptIsCommand } from "../adapters/aider.js";
import {
  aiderHistoryHeader,
  aiderHistorySizeBytes,
  aiderReplyAfterHeader,
  extractAiderReply,
  readAiderHistoryDelta,
} from "../aider-history.js";
import { MAX_ARGV_PROMPT_BYTES } from "../process-runner.js";
import {
  aiderSessionCapabilities,
  assertAiderHistoryForTurn,
  buildAiderSessionCommand,
  createAiderSessionHistory,
  removeAiderSessionHistory,
} from "./aider-session.js";
import { SessionFsm } from "./fsm.js";
import {
  awaitFinalFlush,
  BoundedOutboundQueue,
  callerStdinFailure,
  codemuxFatalMessage,
  crashSynthesisReason,
  drainFailureMessage,
  SESSION_SIGNAL_EXIT_CODE,
  installSessionSignalHandlers,
  type SessionChildOutcome,
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
  recordSessionStart,
  releaseSessionRecord,
  sessionHoldState,
  touchSession,
  type SandboxTrust,
} from "./registry.js";
import { addTurnUsage } from "./usage.js";
import type { SessionEndReason } from "./agy-driver.js";

export interface AiderDriverOptions {
  /** The codemux-minted session id (the registry key and the history
   * directory's name); aider has no native session id. */
  sessionId: string;
  /** True when this session resumes a recorded one (the id is
   * registry-vouched and the history file must already exist). */
  resume: boolean;
  autonomy: AutonomyLevel;
  /** The `--model` value (already `openai/`-prefixed under a provider
   * override — the CLI owns that mapping). Reported as-is. */
  model?: string;
  /** The `--weak-model` value; set only under a provider override. */
  weakModel?: string;
  effort?: ReasoningEffort;
  /** The per-session chat history file (aiderSessionHistoryPath). */
  historyPath: string;
  /** The validated working directory — also the registry's cwd record. */
  cwd: string;
  hermetic: boolean;
  sandboxed: boolean;
  sandboxTrust: SandboxTrust;
  sandboxNoNet: boolean;
  sandboxScrubEnv: boolean;
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
  /** Spawns one process per turn; a throw is reported as a codemux
   * failure, never an unhandled rejection. */
  spawnTurn: (argv: string[]) => Promise<SessionProcess>;
  sink?: (line: string) => Promise<void> | void;
}

type Timer = ReturnType<typeof setTimeout>;

export class AiderSessionDriver {
  private readonly fsm = new SessionFsm();
  private readonly capabilities = aiderSessionCapabilities();
  private readonly out: BoundedOutboundQueue;
  private readonly signals: SessionSignalGate;
  private turnProc: SessionProcess | null = null;
  /** The in-flight turn spawn: set synchronously before spawnTurn is
   * called, cleared once it lands. The end path awaits it (see finish)
   * so a child that lands after the session ended is stopped and its
   * tree settled BEFORE done resolves — the CLI's cleanup runs the
   * moment done does, and an aider process must never run past it
   * (review D5, correctness 2). */
  private turnSpawn: Promise<SessionProcess> | null = null;
  private seq = 0;
  private turnCounter = 0;
  /** How many bytes of the history file earlier turns have consumed;
   * each turn's exchange is the slice past it. A byte offset, not a
   * string length: the session history outgrows any whole-file read, so
   * the driver reads only the bounded delta past this offset (review
   * D8, correctness 2). */
  private consumedBytes = 0;
  /** The open turn's prompt as sent: aider's history block for this
   * exchange is built from exactly these bytes (aiderHistoryHeader), so
   * the reply is anchored past it — a multi-line prompt's continuation
   * lines sit inside the header's own section and must not leak into the
   * reply. */
  private turnPrompt: string | null = null;
  private cumulative: ResultUsageBlock = emptyUsage();
  private registryRecorded = false;
  /** The CLI claimed the record for a resume before anything spawned
   * (`adoptResumeClaim`): every end path releases the claim. */
  private resumeClaimed = false;
  private touchWarned = false;
  private finished = false;
  /** The reason of the end path that owns cleanup (set with finished,
   * never overwritten): startTurn's finished-arm reads it to tell a
   * graceful end — which will run its late-landed child (review D11) —
   * from a signal, timeout, or crash end, which kills it on arrival. */
  private endReason: SessionEndReason | null = null;
  /** The end path's exit code, updatable while cleanup drains (review
   * live7). Monotone: only a higher code ever wins. */
  private endExitCode = 0;
  private settled = false;
  private stdinClosed = false;
  private firstFatal: string | null = null;
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

  constructor(private readonly options: AiderDriverOptions) {
    this.done = new Promise<number>((resolve) => {
      this.resolveDone = resolve;
    });
    this.callLedger = {
      agent: "aider",
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
        // rides stderr because the final events may not fit.
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

  /**
   * The pre-spawn step (the claude-family pattern): create the fresh
   * session's history file and write the start record — codemux owns the
   * identity, so nothing about either waits on the harness. On a resume
   * this follows the claim and updates the claimed record in place with
   * the flags the resume runs under; the history file is never touched
   * (creating it would wipe the conversation). Returns the failure
   * message, or null once this session's state is in place.
   */
  recordBeforeSpawn(): string | null {
    if (!this.options.resume) {
      try {
        // The sweep's liveness skip is registry-backed: a session another
        // codemux process holds open is never aged out, however old its
        // directory mtime sits (review D2, security 2).
        const registryPath = this.options.registryPath;
        createAiderSessionHistory(
          this.options.historyPath,
          registryPath === null
            ? undefined
            : (id) => sessionHoldState(registryPath, id)
        );
      } catch (error) {
        return `cannot create the session history file: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    return this.writeStartRecord();
  }

  /** Remove a fresh session's history directory when its start record
   * failed (the CLI exits right after): nothing would point at the
   * directory, so it would sit orphaned until the 28-day sweep (review
   * D2, correctness-2 3). No-op on a resume — the history file is the
   * resumed conversation, never a fresh one to remove — and best-effort:
   * the registry failure the caller already holds is the one to report,
   * so a removal failure only warns on stderr. */
  removeFreshHistory(): void {
    if (this.options.resume) return;
    try {
      removeAiderSessionHistory(this.options.historyPath);
    } catch (error) {
      console.error(
        `codemux: could not remove the unrecorded session history directory ` +
          `(${this.options.historyPath}): ${
            error instanceof Error ? error.message : String(error)
          }`
      );
    }
  }

  /** The CLI's resume claim succeeded: this process owns the record from
   * now on, whether or not the session start is ever reached. */
  adoptResumeClaim(): void {
    this.resumeClaimed = true;
  }

  /** The main wait: resolves with codemux's exit code when the session
   * has fully ended. The history file is verified and sized once here —
   * the resume verification (an unreadable history fails the session
   * before any turn runs) and the consumed-byte baseline in one step,
   * with none of the transcript's content read: a session history grows
   * without bound, so codemux reads only each turn's bounded delta
   * (review D8, correctness 2). */
  async run(): Promise<number> {
    if (this.finished) return this.done;
    if (this.options.sessionTimeoutMs !== null) {
      this.sessionTimer = setTimeout(
        () => void this.finish("timeout", 1),
        this.options.sessionTimeoutMs
      );
      this.sessionTimer.unref?.();
    }
    const historySize = aiderHistorySizeBytes(this.options.historyPath);
    if (historySize === null) {
      this.emitError(
        true,
        "codemux",
        `the session history file cannot be read (${this.options.historyPath}); ` +
          (this.options.resume
            ? "the resumed conversation is not recoverable"
            : "the session cannot continue")
      );
      void this.finish("crash", 1);
      return this.done;
    }
    this.consumedBytes = historySize;
    if (this.fsm.state === "starting") {
      // Codemux owns the identity: the session exists now, not at some
      // harness fact. (A user line that arrived first warmed the FSM up
      // without the announcement — this branch is the one place it is
      // emitted.)
      const error = this.fsm.transition({ kind: "session_started" });
      if (error !== null) {
        this.emitError(true, "codemux", error.message);
        void this.finish("crash", 1);
        return this.done;
      }
      this.announceSessionStarted();
    }
    return this.done;
  }

  /** One line from the open turn process's stdout. Never parsed —
   * aider's stdout is a human transcript, so every line is tier-1
   * unknown passthrough, raw preserved (§4.2). */
  handleHarnessLine(line: string): void {
    if (this.settled) return;
    this.emit(buildUnknownEvent(++this.seq, this.options.sessionId, line));
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

  /** One framed line from the caller's stdin. Never throws. The honest
   * capability matrix has already narrowed the reachable cases to
   * `user` and `shutdown`. */
  handleCallerLine(line: string): void {
    if (line.trim() === "") return;
    if (this.finished) {
      // The input contract (§4.1): during the drain window every line is
      // answered `shutting_down`; once settled, nothing may follow
      // session_ended (review live9).
      if (!this.settled) this.ack(this.fsm.nextInputSeq(), false, "shutting_down");
      return;
    }
    const inputSeq = this.fsm.nextInputSeq();
    const parsed = parseInputLine(line, {
      capabilities: this.capabilities,
      hasActiveTurn: this.fsm.state === "turn_active",
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
        // The prompt rides argv (`--message=`), so the run path's argv
        // bound is the per-turn cap — checked BEFORE the ack, the same
        // deliverability rule every driver applies to what it is about to
        // send (an accepted line that cannot reach the harness would hang
        // its turn open).
        if (Buffer.byteLength(harnessText, "utf8") > MAX_ARGV_PROMPT_BYTES) {
          this.ack(inputSeq, false, "text_too_long");
          return;
        }
        // Aider would run a text whose first non-whitespace character is
        // `/` or `!` as one of its own commands — /run (the `!` alias)
        // executes the shell immediately, ungated by --dry-run — so the
        // line is refused `unsupported` before the ack rather than
        // delivered: the recorded autonomy must bound what caller text
        // can do (review D10, security; the run path's twin is
        // AiderAdapter.validateRunRequest). Judged on harnessText: the
        // text about to ride argv is what aider dispatches, and an author
        // prefix (`[author] …`) sits ahead of it and neutralizes the
        // dispatch — the line is model prompt text then, never a command.
        if (aiderPromptIsCommand(harnessText)) {
          this.ack(inputSeq, false, "unsupported");
          return;
        }
        this.ack(inputSeq, true);
        if (this.fsm.state === "starting") {
          // An input that arrived before run() warmed the FSM up (run()
          // announces; this branch only transitions).
          const error = this.fsm.transition({ kind: "session_started" });
          if (error !== null) {
            this.emitError(true, "codemux", error.message);
            void this.finish("crash", 1);
            return;
          }
        }
        const turnId = this.submitTurn();
        if (turnId === null) return; // transition failure already ended us
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
        void this.startTurn(harnessText);
        return;
      }
      case "shutdown": {
        this.ack(inputSeq, true);
        void this.finish("shutdown", 0);
        return;
      }
    }
  }

  /** The caller closed stdin: the graceful end, exit 0. A read error is
   * not a close (review live17). */
  handleCallerEnd(error?: unknown): void {
    this.stdinClosed = true;
    if (this.settled) {
      if (error !== undefined) console.error(`codemux: ${callerStdinFailure(error)}`);
      return;
    }
    if (this.finished) {
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

  // --- turns ---------------------------------------------------------------

  /** Spawn the turn's process and prime its stdin: the canned negatives
   * (aider treats EOF as acceptance, so a spawn that never answers must
   * answer no), then the half-close. The process's exit ends the turn. */
  private async startTurn(text: string): Promise<void> {
    // The history file is the session's whole state, and the sandboxed
    // child can write `~/.aider`: re-verify the ownership chain and the
    // file itself (regular, ours, 0600) before EVERY spawn. The
    // creation-time check and the post-turn O_NOFOLLOW read leave the
    // between-turns window where a planted symlink would be followed by
    // this turn's own aider process (review D7, security). A trip fails
    // the TURN, not the session: the caller saw why, and may end the
    // session deliberately.
    try {
      assertAiderHistoryForTurn(this.options.historyPath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const turnId = this.fsm.activeTurn;
      if (turnId !== null) {
        this.emitError(
          false,
          "codemux",
          `the session's chat history failed its pre-turn check: ${detail}`
        );
        this.finishTurn(
          turnId,
          "failed",
          `the chat history file cannot be trusted for this turn (${detail})`
        );
      }
      return;
    }
    this.turnPrompt = text;
    const argv = buildAiderSessionCommand({
      autonomy: this.options.autonomy,
      model: this.options.model,
      weakModel: this.options.weakModel,
      effort: this.options.effort,
      historyPath: this.options.historyPath,
      prompt: text,
    });
    let proc: SessionProcess;
    let spawn: Promise<SessionProcess> | null = null;
    try {
      spawn = this.options.spawnTurn(argv);
      this.turnSpawn = spawn;
      proc = await spawn;
    } catch (error) {
      if (this.finished) return; // the end path owns the verdict
      this.emitError(
        true,
        "codemux",
        "could not spawn the aider turn process " +
          `(${error instanceof Error ? error.message : String(error)})`
      );
      void this.finish("crash", 1);
      return;
    } finally {
      if (spawn !== null && this.turnSpawn === spawn) this.turnSpawn = null;
    }
    // An end that finished the driver while the spawn ran: the child
    // that arrived after the end must be stopped at once (review live4).
    // The end path, which awaited this same spawn, has normally already
    // stopped and settled it by now; requestStop is idempotent, so this
    // stays as the belt-and-suspenders arm. A GRACEFUL end (stdin-close,
    // shutdown) is the exception (review D11, correctness 2 1): it owes
    // this turn its run, primes the late child's stdin itself (see
    // finish), and this arm must not kill what that path is about to
    // run.
    if (this.finished) {
      if (this.endReason === "stdin-close" || this.endReason === "shutdown") {
        return;
      }
      proc.requestStop();
      void proc.settled;
      return;
    }
    this.turnProc = proc;
    proc.exited.then((outcome) => {
      void this.onTurnExited(proc, outcome);
    });
    const written = proc.writeRaw(HEADLESS_NEGATIVE_RESPONSES);
    if (!written.ok) {
      if (!this.finished) {
        this.emitError(
          true,
          "codemux",
          `could not deliver the negative responses to the aider process (${written.reason ?? "unknown"})`
        );
        void this.finish("crash", 1);
      }
      proc.requestStop();
      return;
    }
    proc.endInput();
  }

  /** The turn process exited: after its tree settles, its outcome
   * completes the turn — unless the end path's synthesis won the race or
   * a signal death inside an end path belongs to that end's story. */
  private async onTurnExited(
    proc: SessionProcess,
    outcome: SessionChildOutcome
  ): Promise<void> {
    await proc.settled;
    if (this.settled) return;
    if (this.turnProc !== proc) return; // superseded — defensive
    this.completeTurn(outcome);
  }

  /** Turn-per-process verdict: the process's exit code is the turn's
   * finish; the history file's delta is its substance — the `#### `
   * exchange this turn appended, the model's reply extracted from it. A
   * history that cannot be read back (or shrank) is an integrity
   * failure: the file IS the session's state, so the session ends
   * rather than continue blind. */
  private completeTurn(outcome: SessionChildOutcome): void {
    if (this.fsm.state !== "turn_active") return; // the synthesis answered it
    const signaled = outcome.code === null || outcome.signal !== null;
    if (this.finished && (signaled || outcome.code === SESSION_SIGNAL_EXIT_CODE)) {
      // A death the end path itself caused (the drain's SIGTERM, or the
      // 143 a wrapper re-exits it as): the synthesis pairs the turn with
      // the end's own story.
      return;
    }
    this.turnProc = null;
    const turnId = this.fsm.activeTurn;
    if (turnId === null) return;
    const read = readAiderHistoryDelta(this.options.historyPath, this.consumedBytes);
    if (read === null) {
      this.finishTurn(turnId, "failed", "the chat history file is unreadable or truncated");
      this.emitError(
        true,
        "codemux",
        `the session's chat history cannot be read back (${this.options.historyPath}); ` +
          "the session state is unreliable, so the session cannot continue"
      );
      void this.finish("crash", 1);
      return;
    }
    const delta = read.text;
    this.consumedBytes = read.sizeBytes;
    const exitDetail =
      outcome.code !== null
        ? `code ${outcome.code}`
        : `signal ${outcome.signal ?? "unknown"}`;
    if (outcome.code !== 0) {
      this.finishTurn(turnId, "failed", `the aider process exited with ${exitDetail}`);
      return;
    }
    if (!delta.includes("#### ")) {
      // Exit 0 but no exchange recorded: the turn produced nothing the
      // session can vouch for. The session continues — the next turn's
      // process may succeed.
      this.finishTurn(turnId, "failed", "the chat history records no exchange for this turn");
      return;
    }
    // The reply is anchored past THIS turn's header block, built exactly
    // as aider writes it (aiderHistoryHeader: `#### ` before every prompt
    // line, joined on two-space lines — io.user_input at the pinned
    // 0.86.2). The delta's first occurrence is the user block: only the
    // per-process banner precedes it, and the delta holds no earlier
    // exchange. The header is searched, not required at the start,
    // because that banner sits ahead of it; the `#### ` search is the
    // fallback for a harness that writes the prompt back altered — the
    // only path where a multi-line prompt's continuation lines can leak
    // (review D1, blocker).
    const header =
      this.turnPrompt !== null ? aiderHistoryHeader(this.turnPrompt) : null;
    const at = header !== null ? delta.indexOf(header) : -1;
    const reply =
      header !== null && at !== -1
        ? aiderReplyAfterHeader(delta.slice(at + header.length))
        : extractAiderReply(delta);
    this.turnPrompt = null;
    if (reply !== "") {
      this.emit(
        buildEvent(++this.seq, this.options.sessionId, "assistant_message", null, {
          text: reply,
          turn_id: turnId,
        })
      );
    }
    this.finishTurn(turnId, "end", undefined);
  }

  /** The turn's pairing completion: FSM transition, the uniform usage
   * fold (aider reports nothing machine-readable, so the usage is
   * honestly all-null), the event, and the activity stamp. */
  private finishTurn(
    turnId: string,
    finish: "end" | "failed",
    reason?: string
  ): void {
    const error = this.fsm.transition({ kind: "turn_completed", turnId });
    if (error !== null) {
      this.emitError(true, "codemux", error.message);
      void this.finish("crash", 1);
      return;
    }
    const usage = emptyUsage();
    this.cumulative = addTurnUsage(this.cumulative, usage);
    this.emit(
      buildEvent(++this.seq, this.options.sessionId, "turn_completed", null, {
        turn_id: turnId,
        finish,
        ...(reason !== undefined ? { reason } : {}),
        usage,
      })
    );
    // The ledger's turn record mirrors the event the caller just saw
    // (call-log.ts); aider reports no usage, so the block is all-null —
    // the honest null, not a guessed zero.
    appendSessionTurnCallRecord(
      this.callLedger,
      this.options.sessionId,
      turnId,
      this.turnStartedAt.get(turnId) ?? Date.now(),
      finish,
      usage
    );
    this.turnStartedAt.delete(turnId);
    this.stampActivity();
  }

  // --- end path ------------------------------------------------------------

  /** Every end path funnels here (§4.6). The open turn's process gets
   * the grace to finish on its own first — its exit appends the
   * exchange and the reply is the drained output the caller is owed —
   * then the stop signal and the tree-scoped kill; an idle session has
   * no child at all. A turn still SPAWNING gets the same grace when the
   * end is graceful (stdin-close, shutdown): its late-landing child is
   * primed with the canned negatives and run through the same drain
   * (review D11, correctness 2 1); a signal, timeout, or crash end
   * kills the late child on arrival (review D5, correctness 2). */
  private async finish(reason: SessionEndReason, exitCode: number): Promise<void> {
    if (this.finished) {
      // Idempotent cleanup, honest verdict (review live7).
      this.endExitCode = Math.max(this.endExitCode, exitCode);
      return;
    }
    this.finished = true;
    this.endReason = reason;
    this.endExitCode = exitCode;
    const turnOpenAtFinish = this.fsm.state === "turn_active";
    this.clearTimers();
    const proc = this.turnProc;
    const spawn = this.turnSpawn;
    let childCode: number | null = null;
    // The turn's process to drain, once landed: the one already running,
    // or — on a graceful end — the one that lands while this path waits.
    let drain: SessionProcess | null = proc;
    if (drain === null && spawn !== null) {
      // A turn whose spawn was still in flight when the end path began
      // (an end between the turn's start and its child landing). The
      // CLI's cleanup runs the moment done resolves, so the late child
      // must be stopped and its tree settled BEFORE that (review D5,
      // correctness 2 — the opencode twin of this branch names the
      // provider-config deletion; aider's child holds nothing codemux
      // deletes, but the ordering rule is one). A graceful end meets
      // that by RUNNING the turn inside this path instead (review D11,
      // correctness 2 1): the child landed before its negatives were
      // written, so prime its stdin (startTurn's finished-arm leaves
      // the child untouched for exactly this) and give it the landed
      // path's drain below — the turn finishes and settles before done
      // resolves, or the drain's grace expiry stops it. A signal,
      // timeout, or crash end keeps the D5 rule: stop on arrival; the
      // exit is codemux's own kill, not a turn verdict, and
      // session_ended reports exit_code null, exactly as an idle session
      // does.
      let late: SessionProcess | null = null;
      try {
        late = await spawn;
      } catch {
        late = null; // the spawn's own failure — no child to stop
      }
      if (late !== null) {
        if (
          (reason === "stdin-close" || reason === "shutdown") &&
          this.fsm.state === "turn_active"
        ) {
          const child = late;
          this.turnProc = child;
          child.exited.then((outcome) => {
            void this.onTurnExited(child, outcome);
          });
          const written = child.writeRaw(HEADLESS_NEGATIVE_RESPONSES);
          if (written.ok) {
            child.endInput();
            drain = child;
          } else {
            // The child cannot take the negatives (it died on arrival):
            // the turn never ran, so report the delivery failure and
            // fall back to the kill — the synthesis answers the turn
            // failed. finish is already in flight; the crash call only
            // raises the verdict's exit code.
            this.turnProc = null;
            this.emitError(
              true,
              "codemux",
              "could not deliver the negative responses to the aider process " +
                `(${written.reason ?? "unknown"})`
            );
            void this.finish("crash", 1);
          }
        }
        if (drain === null) {
          late.requestStop();
          await late.settled;
        }
      }
    }
    if (drain !== null) {
      // The turn process's stdin is already at EOF (the negatives write
      // half-closed it), so there is no end carrier to send: the wait is
      // for the turn's own completion (the FSM leaving turn_active
      // through completeTurn), a raised verdict, or the child's exit —
      // then the stop signal, then the settle.
      const startCode = this.endExitCode;
      await drain.awaitEndAnswer(
        () => this.fsm.state !== "turn_active" || this.endExitCode > startCode
      );
      drain.requestStop();
      await drain.settled;
      childCode = (await drain.exited).code;
      this.turnProc = null;
    }
    // Non-null exactly when the child's exit is itself a failure the
    // verdict reports (review live9): nonzero, not the 143 coded signal
    // death, not a crash end (which emitted its own fatal).
    const drainFailureCode =
      childCode !== null &&
      childCode !== 0 &&
      childCode !== SESSION_SIGNAL_EXIT_CODE &&
      reason !== "crash"
        ? childCode
        : null;
    if (drainFailureCode !== null) {
      this.endExitCode = Math.max(this.endExitCode, 1);
      this.emitError(
        true,
        "harness",
        drainFailureMessage("aider", drainFailureCode, this.fsm.state === "turn_active")
      );
    }
    // Captured before the block below: the transition inside it moves
    // the FSM, and this is also the not-resumable verdict's input (an
    // open turn answered by synthesis left the history half-written).
    const openTurnInterrupted =
      turnOpenAtFinish && this.fsm.state === "turn_active";
    if (openTurnInterrupted) {
      // The open turn's `turn_started` must be answered (review live10/
      // live12): synthesize the completion the harness cannot, with the
      // usage aider never reports all-null rather than guessed zeros.
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
                  ? drainFailureMessage("aider", drainFailureCode, true)
                  : this.firstFatal !== null
                    ? crashSynthesisReason(this.firstFatal)
                    : `the session ended (${reason}) before the turn completed`,
            usage: emptyUsage(),
          })
        );
        // The synthesized completion is a turn the caller saw complete, so
        // it gets its ledger line like any other (all-null usage, the same
        // honesty the event carries).
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
    this.settled = true;
    this.fsm.transition({ kind: "shutdown_started" });
    this.fsm.transition({ kind: "ended" });
    const ownsRecord = this.registryRecorded || this.resumeClaimed;
    if (ownsRecord && this.options.registryPath !== null) {
      releaseSessionRecord(this.options.registryPath, this.options.sessionId);
    }
    // Resumable requires an orderly end: the history file is the
    // resumable state, and a session that ended on a failure may have
    // left it mid-exchange (a resume would replay a half-written turn).
    // An open turn answered by synthesis is exactly that mid-exchange
    // state — aider writes the `#### ` user block when the turn starts
    // and the reply only at its end, so a killed turn leaves an
    // unanswered prompt that `--restore-chat-history` would replay —
    // even though the kill itself is the normal end path (exit 143 is
    // not a drain failure, so endExitCode can be 0 here; review D10,
    // correctness-2 1).
    const resumable =
      this.capabilities.resume &&
      ownsRecord &&
      this.endExitCode === 0 &&
      !openTurnInterrupted;
    const sent = this.out.enqueue(
      buildEvent(++this.seq, this.options.sessionId, "session_ended", null, {
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
      this.options.sessionId,
      this.sessionStartedAt,
      reason,
      childCode,
      this.cumulative
    );
    const delivered = sent ? await awaitFinalFlush(this.out) : false;
    this.signals.dispose();
    this.resolveDone(delivered ? this.endExitCode : Math.max(this.endExitCode, 1));
  }

  // --- helpers ---------------------------------------------------------------

  /** The start record (§4.8): the claude-family writeStartRecord shape.
   * Returns the failure message, or null once recorded (or when registry
   * writes are disabled). */
  private writeStartRecord(): string | null {
    if (this.options.registryPath === null) return null;
    const outcome = recordSessionStart(this.options.registryPath, {
      id: this.options.sessionId,
      agent: "aider",
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
    if (!outcome.ok) return outcome.error;
    this.registryRecorded = true;
    return null;
  }

  /** Codemux-originated (raw null): the identity is the minted UUID, not
   * a harness fact. */
  private announceSessionStarted(): void {
    if (
      this.settled ||
      (this.options.registryPath !== null && !this.registryRecorded)
    ) {
      return;
    }
    this.emit(
      buildEvent(++this.seq, this.options.sessionId, "session_started", null, {
        agent: "aider",
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
      this.emitError(true, "codemux", error.message);
      void this.finish("crash", 1);
      return null;
    }
    this.emit(
      buildEvent(++this.seq, this.options.sessionId, "turn_started", null, {
        turn_id: turnId,
      })
    );
    this.turnStartedAt.set(turnId, Date.now());
    return turnId;
  }

  /** The turn path's best-effort activity stamp: single-attempt lock,
   * never a wait (review live13). */
  private stampActivity(): void {
    if (!this.registryRecorded || this.options.registryPath === null) return;
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

  private emit(line: string): void {
    this.out.enqueue(line);
  }

  private ack(inputSeq: number, accepted: boolean, reason?: InputRejectionReason): void {
    this.emit(
      buildInputAck(++this.seq, this.options.sessionId, inputSeq, accepted, reason)
    );
  }

  private emitError(
    fatal: boolean,
    source: "codemux" | "harness",
    message: string
  ): void {
    if (fatal && this.firstFatal === null) this.firstFatal = message;
    this.emit(
      buildEvent(++this.seq, this.options.sessionId, "error", null, {
        fatal,
        source,
        message,
      })
    );
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
