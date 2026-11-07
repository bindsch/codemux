import {
  createTerminationTarget,
  rememberDescendants,
  waitForDescendantsGrace,
  type TerminationTarget,
} from "../process-tree.js";
import { readProcessTable } from "../process-table.js";
import { signalProcess } from "../process-runner.js";
import { assertExecutablesUnchanged } from "../executable-security.js";
import { buildEvent } from "./protocol.js";
import { SessionWriter, type WriteLineResult } from "./process-outbound.js";
import { excerptOf, type SessionFatal } from "./process-fatal.js";

export {
  FATAL_EXCERPT_BYTES,
  codemuxFatalMessage,
  unusableFacts,
  type SessionFatal,
  type SessionFatalKind,
} from "./process-fatal.js";

/**
 * The streaming session process runner (design §4.6/§4.7): one harness
 * child, line-framed stdio in both directions, bounded event delivery to
 * the caller, and a tree-scoped end path on every exit route. This is a
 * peer of `runCapturedCommand`, not a caller of it: a session runs for
 * hours, keeps its stdin open, and hands every line to the protocol layer
 * as it arrives instead of capturing.
 *
 * The layer is deliberately dumb about content: lines are decoded
 * fatal-strict UTF-8 and delivered as strings. What a line means — the
 * three-tier unknown/malformed rule, envelopes, ceilings — is the protocol
 * layer's job (src/session/protocol.ts). What this layer owns is framing,
 * bounds, and making sure the harness tree is dead when the session ends.
 */

/** A harness stdout line over this is a tier-3 fatal (design §4.2). */
export const MAX_HARNESS_LINE_BYTES = 16 * 1024 * 1024;

/** Default grace for the harness to persist before the tree is killed. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
/** 128 + SIGTERM, the process runner's convention for a signaled stop. */
export const SESSION_SIGNAL_EXIT_CODE = 143;

const DESCENDANT_CAPTURE_MS = 5_000;
/** One more descendant sample this long after the stop signal (review
 * round 331, item 3): a harness handling SIGTERM often starts its cleanup
 * helper then — in its own process group — and exits before the next
 * tick. Asynchronous; never a synchronous read on the signal path. */
const DESCENDANT_SAMPLE_AFTER_STOP_MS = 300;
// After the end path's SIGKILL, how much longer to keep reading stdout
// before abandoning it: an orphan no signal can reach (reparented before
// any snapshot) may hold it open forever; settled must still resolve.
const PIPE_GIVE_UP_MS = 1_000;

export interface SessionChildOutcome {
  code: number | null;
  signal: string | null;
}

/** Exit classification never depends on who sent a signal or when. */
export function harnessFailed(outcome: SessionChildOutcome | null): boolean {
  return outcome !== null && (outcome.signal !== null || outcome.code !== 0);
}

export function shutdownRequested(reason: string): boolean {
  return reason === "stdin-close" || reason === "shutdown" || reason === "signal";
}

/** The shared closing event preserves the raw child outcome for every harness. */
export function buildSessionEnded(
  seq: number,
  sessionId: string,
  outcome: SessionChildOutcome | null,
  fields: Record<string, unknown>
): string {
  return buildEvent(seq, sessionId, "session_ended", null, {
    ...fields,
    harness_exit: outcome,
    reason: harnessFailed(outcome) ? "harness_failed" : fields.reason,
  });
}

export interface SessionProcessOptions {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  /** Every complete line the harness writes to stdout, newline stripped. */
  onLine: (line: string) => void;
  /** Tier-3 framing failure; fired at most once, and no line is delivered
   * after it. The caller ends the session; this layer keeps draining. */
  onFatal: (fatal: SessionFatal) => void;
  graceMs?: number;
  /** This spawn's own executable resolutions (spawn.ts), so the
   * pre-spawn re-stat pins them like the run path's: the required paths
   * refuse a recording gap, and each check compares the identity this
   * spawn's own resolution recorded (round 20, minor 6). */
  executableChecks?: {
    requiredPaths: readonly string[];
    checks: readonly import("../executable-security.js").ExecutableCheck[];
  };
}

function indexOfByte(
  buffer: Uint8Array,
  needle: number,
  from: number,
  to: number
): number {
  for (let i = from; i < to; i++) {
    if (buffer[i] === needle) return i;
  }
  return -1;
}

/**
 * The session's child process: spawn, framed stdio, and the end path.
 *
 * End-path contract (design §4.6): the driver first gives the harness up
 * to the grace period to answer what it sent (`awaitEndAnswer`); then
 * `requestStop` sends one SIGTERM to the child alone — the harness gets a
 * second grace period to persist and to shut down its own children — and
 * SIGKILLs the whole tree when that grace runs out. Independently of how the child died, `settled` waits out any
 * remaining grace and then kills the tree unconditionally, so no end path
 * (clean exit, crash, EOF, signal, timeout) leaves a descendant behind.
 * Descendants are captured continuously while the session runs precisely
 * so that kill can reach processes a post-mortem walk could no longer
 * attribute: they are reparented the moment their parent dies.
 */
export class SessionProcess {
  private readonly target: TerminationTarget;
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private readonly writer: SessionWriter;
  private readonly graceMs: number;
  private readonly onLine: (line: string) => void;
  private readonly onFatal: (fatal: SessionFatal) => void;
  private giveUpReads: () => void = () => {};

  private fatal: SessionFatal | null = null;
  private stopArmed = false;
  /** `escalateStop` has run (round al33, edges major 3): the escalation
   * fires once however many paths reach it — the driver's aliasing and
   * repeated second signals among them. */
  private escalatedChild = false;
  private killDeadline = 0;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private captureTimer: ReturnType<typeof setInterval> | null = null;
  private stopSampleTimer: ReturnType<typeof setTimeout> | null = null;
  private childExited = false;

  /** Resolved when the child has exited, the grace has run its course, the
   * tree has been SIGKILLed, and stdout is drained or abandoned. */
  settled: Promise<void>;
  /** The child's exit outcome, available once the child exits. */
  exited: Promise<SessionChildOutcome>;

  constructor(options: SessionProcessOptions) {
    if (
      options.command.length === 0 ||
      options.command.some(
        (argument) => typeof argument !== "string" || argument.includes("\0")
      )
    ) {
      throw new Error("command must contain non-NUL string arguments");
    }
    this.graceMs = options.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.onLine = options.onLine;
    this.onFatal = options.onFatal;
    const useProcessGroup = process.platform !== "win32";
    assertExecutablesUnchanged(
      options.command,
      "session command",
      options.executableChecks?.requiredPaths,
      options.executableChecks?.checks
    );
    this.proc = Bun.spawn(options.command, {
      cwd: options.cwd,
      stdout: "pipe",
      // Passed through, as `run` passes it: the harness's own diagnostics
      // (an expired login, a refused model or resume id) reach the
      // operator on codemux's stderr as they happen. Never parsed (design
      // §4.6); the event stream on stdout is unaffected (review live17 —
      // the old pipe captured it and nothing ever read the capture).
      stderr: "inherit",
      stdin: "pipe",
      env: options.env,
      detached: useProcessGroup,
    });
    this.target = createTerminationTarget(this.proc, useProcessGroup);
    this.writer = new SessionWriter(this.proc);
    this.startCapture();
    const giveUp = new Promise<void>((resolve) => {
      this.giveUpReads = resolve;
    });
    // A read error is a fatal, never a rejection: nothing awaits this
    // promise until the child exits, so a rejection before then went
    // unhandled, ended codemux, and left the detached harness group
    // running with no end path to kill it (review live25).
    const stdoutDone = this.readStdoutLines(
      this.proc.stdout as ReadableStream<Uint8Array>,
      giveUp
    ).catch((error: unknown) => {
      this.reportFatal({ kind: "read-error", error, bytes: 0 });
    });
    this.exited = this.proc.exited.then(() => {
      this.childExited = true;
      return {
        code: this.proc.exitCode,
        signal: this.proc.signalCode as string | null,
      };
    });
    this.settled = this.runEndPath(stdoutDone);
  }

  writeLine(line: string): WriteLineResult {
    return this.writer.writeLine(line);
  }

  writeRaw(text: string): WriteLineResult {
    return this.writer.writeRaw(text);
  }

  /** The repeating decline carrier (review round 153): the session-side
   * twin of the run path's `stdinRepeats` — one chunk is this call's
   * synchronous result, the repeats never let a second write pile behind
   * an undrained one, and stdin is never closed by the feeder itself. */
  repeatRawUntilExit(text: string): WriteLineResult {
    return this.writer.repeatRawUntilExit(text, this.exited);
  }

  endInput(): void {
    this.writer.endInput();
  }

  /**
   * The first half of a graceful end (design §4.6): before any signal,
   * give the harness up to the grace period to answer what the driver
   * just sent it — the end-interrupt, or for agy the stdin close — so the
   * open turn's own completion and usage reach the caller. Returns when
   * `answered()` holds, the child exits, or the grace runs out. Sending
   * SIGTERM in the same step as the interrupt killed a harness that dies
   * on SIGTERM before it could answer (review live17; the live16 check
   * saw claude do exactly that). `requestStop` then gives the harness a
   * second grace period to exit before the tree is killed.
   */
  async awaitEndAnswer(answered: () => boolean): Promise<void> {
    const deadline = performance.now() + this.graceMs;
    while (!answered() && !this.childExited && performance.now() < deadline) {
      await Bun.sleep(10);
    }
  }

  /** Signal the child to stop. Graceful once; later calls are no-ops. */
  requestStop(): void {
    if (this.stopArmed) return;
    this.stopArmed = true;
    // A child that already exited needs no signal, and its end path has
    // already run its tree kill and cleared its timers (review live18).
    if (this.childExited) return;
    // The driver first allows the protocol shutdown to finish. The capture
    // keeps sampling through the stop grace, and one extra asynchronous
    // sample (review round 331, item 3) remembers a helper the harness
    // starts while handling SIGTERM before it exits past the next tick. A
    // helper whose parent exits at once is reparented before any sample and
    // unattributable: the documented limit (docs/sessions.md, round 334).
    signalProcess(this.target, "SIGTERM", "process");
    this.stopSampleTimer = setTimeout(() => {
      this.stopSampleTimer = null;
      try {
        rememberDescendants(this.target, readProcessTable());
      } catch { /* one lost sample, not the session */ }
    }, DESCENDANT_SAMPLE_AFTER_STOP_MS);
    this.killDeadline = performance.now() + this.graceMs;
    this.killTimer = setTimeout(() => {
      signalProcess(this.target, "SIGKILL", "tree");
    }, this.graceMs);
  }

  /** A second SIGINT/SIGTERM while the first signal's shutdown still runs
   * (round al30, rule 2, edges major 3): SIGKILL the child's whole tree
   * NOW — no grace, no timer — so an operator who presses Ctrl-C again
   * while the session's hold (an abandoned spawn still settling past
   * `session_ended`) is running takes the tree down at once instead of
   * waiting out a stop that already outlived the session. The
   * escalation is latched: it runs once per child however many times it
   * is reached (round al33, edges major 3 — the driver holds one child
   * under several aliases, and a second signal re-fires them all). */
  escalateStop(): void {
    if (this.escalatedChild) return;
    this.escalatedChild = true;
    // The capture stays armed; the end path's finally stops it (round 331, item 3).
    signalProcess(this.target, "SIGKILL", "tree");
  }

  /**
   * Read stdout as newline-framed lines. Fatal-strict UTF-8 per complete
   * line; a line over the cap (or an unterminated run that passes it) is a
   * tier-3 fatal whose bytes are discarded up to the next newline — the
   * framer resynchronizes rather than folding the rest of the stream into
   * the overflow — and nothing is delivered after a fatal: the session is
   * ending, but draining continues so a blocked child cannot stall the end
   * path. A final line without its newline is still a line; dropping it
   * would violate "never dropped" for the one shape a crashing harness may
   * legally emit.
   */
  private async readStdoutLines(
    stream: ReadableStream<Uint8Array>,
    giveUp: Promise<void>
  ): Promise<void> {
    const reader = stream.getReader();
    let buffer = new Uint8Array(64 * 1024);
    let length = 0;
    let searchFrom = 0;
    let resyncing = false;
    let abandoned = false;
    giveUp.then(
      () => {
        abandoned = true;
        reader.cancel().catch(() => {});
      },
      () => {}
    );
    try {
      while (!abandoned) {
        const { done, value } = await reader.read();
        if (done) break;
        if (length + value.byteLength > buffer.byteLength) {
          const grown = new Uint8Array(
            Math.max(buffer.byteLength * 2, length + value.byteLength)
          );
          grown.set(buffer.subarray(0, length));
          buffer = grown;
        }
        buffer.set(value, length);
        length += value.byteLength;
        for (
          let newline = indexOfByte(buffer, 10, searchFrom, length);
          newline !== -1;
          newline = indexOfByte(buffer, 10, searchFrom, length)
        ) {
          if (resyncing) {
            // Discard the tail of the overflowed run; framing resynced.
            resyncing = false;
          } else {
            this.deliver(buffer.subarray(0, newline));
          }
          const remainder = length - (newline + 1);
          buffer.copyWithin(0, newline + 1, length);
          length = remainder;
          searchFrom = 0;
        }
        // The last scan covered [searchFrom, length) and found no newline;
        // the next chunk's scan starts where this one stopped. Restarting
        // from byte 0 rescanned the whole buffer on every chunk — for a
        // line near the cap arriving in ~64 KiB pipe chunks that is a
        // quadratic scan (review live15).
        searchFrom = length;
        // No newline in what is buffered: an unterminated run past the cap
        // is already an overflow — waiting for its newline would buffer
        // without bound. Discard (bounded memory) reporting only the first,
        // with the bytes seen at this crossing; the resynced tail is uncounted.
        if (length > MAX_HARNESS_LINE_BYTES) {
          if (!resyncing) {
            this.reportFatal({
              kind: "line-overflow",
              excerpt: excerptOf(buffer.subarray(0, length)),
              bytes: length,
            });
            resyncing = true;
          }
          length = 0;
          searchFrom = 0;
        }
      }
      if (!resyncing && !abandoned && length > 0) {
        this.deliver(buffer.subarray(0, length));
      }
    } finally {
      reader.releaseLock();
    }
  }

  private deliver(lineBytes: Uint8Array): void {
    // A blank line is framing whitespace (a separator a harness may emit
    // between frames), not an event: not delivered, and never judged for
    // JSON validity. The blank line of a CRLF wire is one carriage
    // return: a harness that ends every line with \r\n sends \r\n
    // between frames, and the framer takes \n as its terminator, so a
    // lone \r is that same separator and is dropped with it (review
    // round 147 — delivered as a line, it reached the parsers and ended
    // the session as unusable output). Any other line that ends in \r
    // keeps it: JSON.parse accepts trailing whitespace, so a CRLF JSON
    // line already parses, and no reader of the raw line needs it
    // stripped. A line of spaces is not a separator under this rule:
    // delivered and judged as before.
    if (lineBytes.byteLength === 0) return;
    if (lineBytes.byteLength === 1 && lineBytes[0] === 0x0d) return;
    if (this.fatal !== null) return;
    if (lineBytes.byteLength > MAX_HARNESS_LINE_BYTES) {
      this.reportFatal({
        kind: "line-overflow",
        excerpt: excerptOf(lineBytes),
        bytes: lineBytes.byteLength,
      });
      return;
    }
    let line: string;
    try {
      // Per-line decode, no stream mode: a line is a complete byte
      // sequence, so a multibyte character split across pipe chunks is
      // never mistaken for invalid UTF-8.
      line = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes);
    } catch {
      this.reportFatal({
        kind: "invalid-utf8",
        excerpt: excerptOf(lineBytes),
        bytes: lineBytes.byteLength,
      });
      return;
    }
    try {
      this.onLine(line);
    } catch (error) {
      // A handler exception is a codemux defect, not harness output, so
      // it is reported as its own fatal class — recasting it as invalid
      // UTF-8 would blame a line that may be perfectly valid (found live
      // on 2026-10-05, when a registry EPERM thrown through the handler
      // surfaced as "invalid-utf8" for a clean init frame). Riding the
      // fatal channel keeps the end path — and its tree kill — running.
      this.reportFatal({ kind: "handler", error, bytes: lineBytes.byteLength });
    }
  }

  private reportFatal(fatal: SessionFatal): void {
    if (this.fatal !== null) return;
    this.fatal = fatal;
    try {
      this.onFatal(fatal);
    } catch (error) {
      // The fatal handler itself failed: a codemux defect, and the driver
      // can no longer end the session for this fatal. The throw must not
      // leave this method. From the read-error path it rejected the
      // stdout promise nothing awaits until the child exits, so codemux
      // ended on an unhandled rejection and left the detached harness
      // group running (review round 149); from the framer it stopped the
      // drain. The tree is killed here instead, so the end path runs as
      // for any dead child and the driver sees the exit.
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`codemux: internal error while reporting a session failure: ${detail}\n`);
      if (!this.childExited) this.escalateStop();
    }
  }

  private startCapture(): void {
    // Continuous descendant capture: a process orphaned mid-session (its
    // parent exited hours before the session ends) is invisible to any
    // walk taken at stop time. Remembering the tree as it forms is what
    // lets the end path's SIGKILL reach it.
    this.captureTimer = setInterval(() => {
      try {
        rememberDescendants(this.target, readProcessTable());
      } catch {
        // A transient read failure loses one sample, not the session.
      }
    }, DESCENDANT_CAPTURE_MS);
  }

  private stopCapture(): void {
    if (this.captureTimer !== null) { clearInterval(this.captureTimer); this.captureTimer = null; }
    if (this.stopSampleTimer !== null) { clearTimeout(this.stopSampleTimer); this.stopSampleTimer = null; }
  }

  private async runEndPath(stdoutDone: Promise<void>): Promise<void> {
    try {
      await this.exited;
      // Grace that was never armed has already run out; the wait returns
      // at once and the SIGKILL below is immediate, as on a clean exit.
      await waitForDescendantsGrace(this.target, this.killDeadline);
      signalProcess(this.target, "SIGKILL", "tree");
      // The tree is dead; give whatever still holds stdout a moment to
      // close it, then abandon the reader so settled always resolves.
      const giveUpTimer = setTimeout(() => this.giveUpReads(), PIPE_GIVE_UP_MS);
      await stdoutDone;
      clearTimeout(giveUpTimer);
    } finally {
      this.stopCapture();
      if (this.killTimer !== null) clearTimeout(this.killTimer);
    }
  }
}

export { awaitFinalFlush, BoundedOutboundQueue, SessionWriter, TERMINAL_LANE_CAPACITY } from "./process-outbound.js";
export { harnessLineDeliverable, harnessTextDeliverable } from "./process-outbound.js";
export { MAX_HARNESS_BACKLOG_BYTES, MAX_INPUT_LINE_BYTES } from "./process-outbound.js";
export { MAX_PENDING_EVENT_BYTES, MAX_PENDING_EVENTS } from "./process-outbound.js";
export type { OutboundFailure, OutboundOverflow } from "./process-outbound.js";
export type { WriteLineRejectReason, WriteLineResult } from "./process-outbound.js";
export { callerStdinFailure, crashSynthesisReason } from "./process-signals.js";
export { drainFailureMessage, installSessionSignalHandlers } from "./process-signals.js";
export type { SessionSignalGate } from "./process-signals.js";
