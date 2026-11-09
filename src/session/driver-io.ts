/**
 * The claude-family driver's shared state and wire plumbing: the options
 * record, the constructor, the process entry points (run, handleFatal),
 * and the emit/ack/write helpers every side of the driver speaks through.
 * src/session/driver.ts owns the lifecycle.
 */

import type { AutonomyLevel, ResultUsageBlock } from "../types.js";
import { providerHost, type SessionCallContext } from "../call-log.js";
import { emptyUsage } from "../result-envelope.js";
import { claudeSessionCapabilities, ClaudeStreamParser } from "./claude-session.js";
import { SessionFsm } from "./fsm.js";
import {
  BoundedOutboundQueue,
  codemuxFatalMessage,
  SESSION_SIGNAL_EXIT_CODE,
  type SessionFatal,
  type SessionProcess,
  type SessionSignalGate,
} from "./process.js";
import {
  buildEvent,
  buildInputAck,
  buildUnknownEvent,
  type InputRejectionReason,
} from "./protocol.js";
import type { SandboxTrust } from "./registry.js";
import { SessionStopEscalation } from "./stop-escalation.js";

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
  /** The caller's --sandbox-block paths, canonicalized; recorded and
   * compared on resume (registry/format.ts). */
  sandboxBlock?: readonly string[];
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
  /** Whether the session runs hermetic — plain `--hermetic` (the run
   * path's argv isolation, plus the session-keyed private config
   * directory) or the project-settings mode, which requires it.
   * Recorded and compared by the resume guard; the call ledger carries
   * it too. */
  hermetic?: boolean;
  /** Whether the session runs the project-settings isolation (a private
   * Claude config directory, `--setting-sources project,local`).
   * Recorded as `project_settings` and refused as a resume mismatch in
   * both directions (registry.ts). */
  projectSettings?: boolean;
  /** The session's private home, reported on `session_started` as
   * `private_home` (the directory the harness keeps its transcript in);
   * null when the agent's hermetic sessions keep no session-keyed
   * directory (opencode's transcript stays in its real data dir) and
   * for every non-hermetic session. */
  privateHome?: { dir: string } | null;
  /** True only for a hermetic session the CLI launched with `--final`:
   * the command removes the private home once the session ends,
   * transcript and trust record with it, so `session_ended` reports
   * `resumable: false` — a resume would open a fresh directory with no
   * transcript (review round 7, edges finding 1). Other agents never
   * set it. */
  final?: boolean;
  /** The `--final` directory removal, handed in by the CLI so the end
   * path can run it — both attempts — BEFORE the end stamp releases the
   * record: a resume that claimed the ended record in the old window had
   * its directory deleted under it, and a removal the record's verdict
   * did not follow left the record promising a deleted directory (review
   * round 15, major). The end stamp also marks the record non-resumable
   * in the same write, so the removal ordering is the second guard, not
   * the only one (review round 10, edges 4). */
  removeFinalProjectDir?: () => boolean;
  /** `deny` answers every permission_request with an immediate deny —
   * the headless mode for a session with no human on the input: the
   * request is still emitted, then answered and recorded as a
   * `permission_denied` event, never joining the pending set (a caller
   * decision for it receives `unknown_request`). The answer carries the
   * default denial text, like every deny this driver sends. Default
   * behavior unchanged. */
  permissionPolicy?: "default" | "deny";
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

export type Timer = ReturnType<typeof setTimeout>;

export abstract class ClaudeDriverIo {

  protected readonly fsm = new SessionFsm();
  protected readonly parser = new ClaudeStreamParser();
  protected readonly capabilities = claudeSessionCapabilities();
  protected readonly out: BoundedOutboundQueue;
  protected readonly pendingTimers = new Map<string, Timer>();

  protected proc: SessionProcess | null = null;
  protected readonly earlyLines: string[] = [];
  /** The second-signal escalation (src/session/stop-escalation.ts). */
  protected readonly stopEscalation = new SessionStopEscalation();
  protected readonly signals: SessionSignalGate;
  protected seq = 0;

  /** Starts unknown (all-null), not zero: a counter a turn never reports
   * must stay null rather than be guessed as 0 (§4.2). */
  protected cumulative: ResultUsageBlock = emptyUsage();

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
   * harness can finish persisting and say so — its final result,
   * messages, and usage arrive during it and must reach the caller
   * (review live5). `finished` alone is the end path's re-entry guard
   * and flips at its start. */
  protected settled = false;

  protected stdinClosed = false;

  /** The first fatal the session reported: the reason a crash end's
   * synthesized turn completion carries, so it names the failure that
   * ended the session rather than assuming the process died (review
   * live17 — an outbound overflow or a registry failure is a crash end
   * with the harness alive). */
  protected firstFatal: string | null = null;

  protected sessionTimer: Timer | null = null;

  /** The session's own start, for the closing ledger record's duration. */
  protected readonly sessionStartedAt = Date.now();
  /** The launch facts the call ledger records on every turn and at the
   * end (call-log.ts); the provider is the override's host or "default". */
  protected readonly callLedger: SessionCallContext;
  protected readonly done: Promise<number>;
  protected resolveDone!: (code: number) => void;

  constructor(protected readonly options: SessionDriverOptions) {
    this.done = new Promise<number>((resolve) => {
      this.resolveDone = resolve;
    });
    this.callLedger = {
      agent: options.agent,
      model: options.model ?? null,
      provider: providerHost(options.providerBaseUrl),
      autonomy: options.autonomy,
      hermetic: options.hermetic ?? false,
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
    this.signals = this.stopEscalation.install(
      () => void this.finish("signal", SESSION_SIGNAL_EXIT_CODE),
      () => [this.proc]
    );
  }

  /** Every end path's funnel (§4.6); the final class owns it
   * (src/session/driver.ts). */
  protected abstract finish(
    reason: SessionEndReason,
    exitCode: number
  ): Promise<void>;

  /** Forget and clear the open turn timer (src/session/driver-turns.ts). */
  protected abstract clearTurnTimer(): void;

  /** One line from the harness stdout
   * (src/session/driver.ts). */
  abstract handleHarnessLine(line: string): void;

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

  protected ack(
    inputSeq: number,
    accepted: boolean,
    reason?: InputRejectionReason,
    message?: string
  ): void {
    this.emit(
      buildInputAck(++this.seq, this.options.sessionId, inputSeq, accepted, reason, message)
    );
  }

  /** Tier 2 (§4.2): a harness line that breaks the stream's grammar
   * still goes out raw, then the fatal names the violation (review
   * live21 — the FSM-rejected lines were reported but not mirrored, so
   * a refused resume's result frame never reached the caller). */
  protected emitGrammarViolation(rawLine: string, message: string): void {
    this.emit(buildUnknownEvent(++this.seq, this.options.sessionId, rawLine));
    this.emitError(true, "harness", message);
  }

  protected emitError(fatal: boolean, source: "codemux" | "harness", message: string): void {
    if (fatal && this.firstFatal === null) this.firstFatal = message;
    this.emit(
      buildEvent(++this.seq, this.options.sessionId, "error", null, {
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

  /** Write one line; whether it was delivered. A refused write has
   * already started the crash end when this returns false. */
  protected writeToHarness(line: string): boolean {
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
