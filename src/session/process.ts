import {
  createTerminationTarget,
  rememberDescendants,
  waitForDescendantsGrace,
  type TerminationTarget,
} from "../process-tree.js";
import { readProcessTable } from "../process-table.js";
import { signalProcess } from "../process-runner.js";

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
/** A caller input line over this is rejected before it reaches the wire. */
export const MAX_INPUT_LINE_BYTES = 17 * 1024 * 1024;
/** Outbound queue bounds to the caller (design §4.2). */
export const MAX_PENDING_EVENTS = 1024;
export const MAX_PENDING_EVENT_BYTES = 64 * 1024 * 1024;
/** Bytes written to the harness's stdin that it has not yet read. Bun's
 * pipe sink buffers every write it cannot flush, without limit, so a
 * harness that stops reading would otherwise let the caller grow
 * codemux's memory without bound (review live19). */
export const MAX_HARNESS_BACKLOG_BYTES = 64 * 1024 * 1024;
/** Bounded excerpt a tier-3 fatal carries (design §4.2). */
export const FATAL_EXCERPT_BYTES = 4096;
/** Default grace for the harness to persist before the tree is killed. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
/** 128 + SIGTERM, the process runner's convention for a signaled stop. */
export const SESSION_SIGNAL_EXIT_CODE = 143;

const DESCENDANT_CAPTURE_MS = 5_000;
// After the end path's SIGKILL, how much longer to keep reading stdout
// before abandoning it: an orphan no signal can reach (reparented before
// any snapshot) may hold it open forever; settled must still resolve.
const PIPE_GIVE_UP_MS = 1_000;

export type SessionFatalKind = "line-overflow" | "invalid-utf8" | "handler" | "read-error";

export type SessionFatal =
  | {
      kind: "line-overflow" | "invalid-utf8";
      /** First 4 KiB of the offending bytes, lossily decoded for the report. */
      excerpt: string;
      /** Length of the discarded run in bytes. */
      bytes: number;
    }
  | {
      kind: "handler";
      /** The exception the line handler threw: a codemux defect, reported
       * as itself so the caller never mistakes it for harness output. */
      error: unknown;
      /** Length of the line being processed, for the report. */
      bytes: number;
    }
  | {
      kind: "read-error";
      /** The error reading the harness's stdout pipe raised: a codemux
       * I/O failure, not harness output (review live25). */
      error: unknown;
      bytes: number;
    };

/** The codemux-side message for the two fatal classes that carry an
 * error instead of harness bytes; every driver reports them the same. */
export function codemuxFatalMessage(fatal: Extract<SessionFatal, { error: unknown }>): string {
  const detail = fatal.error instanceof Error ? fatal.error.message : String(fatal.error);
  return fatal.kind === "handler"
    ? `internal error while processing a harness line: ${detail}`
    : `reading the harness's stdout failed: ${detail}`;
}

export interface SessionChildOutcome {
  code: number | null;
  signal: string | null;
}

export type WriteLineRejectReason = "oversize" | "framing" | "closed" | "backlog";

export interface WriteLineResult {
  ok: boolean;
  reason?: WriteLineRejectReason;
}

/** Whether `line` fits `writeLine`'s cap, so an input the protocol has
 * already accepted can actually reach the harness. The protocol's own
 * `text` bound (16 MiB) is smaller than the write cap (17 MiB) but NOT
 * sufficient: the harness frame adds a JSON wrapper, an author prefix,
 * and JSON-escaping of the text (quotes double), so a text near the
 * protocol cap can serialize past the write cap. Drivers check the frame
 * they are about to build with this before acking, and reject
 * `text_too_long` when it cannot be delivered. */
export function harnessLineDeliverable(line: string): boolean {
  return utf8ByteLength(line) <= MAX_INPUT_LINE_BYTES;
}

/** Conservative wrapper margin for `harnessTextDeliverable`: the bytes a
 * harness frame adds around the escaped text literal when the exact frame
 * is not yet known (codex assigns its JSON-RPC id and thread id at send
 * time). 1 KiB covers the recorded wrappers — method names, ids, and the
 * policy objects, writableRoots included — with room to spare; a text
 * within the margin of the cap is rejected as undeliverable rather than
 * accepted and dropped. */
const HARNESS_FRAME_MARGIN_BYTES = 1024;

/** Same deliverability question for a text whose exact frame cannot be
 * built yet: the JSON-escaped literal plus the wrapper margin must fit
 * the write cap. Deliberately conservative — it can only reject texts
 * whose escaped form is within the margin of the cap. */
export function harnessTextDeliverable(text: string): boolean {
  return (
    utf8ByteLength(JSON.stringify(text)) + HARNESS_FRAME_MARGIN_BYTES <=
    MAX_INPUT_LINE_BYTES
  );
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
}

const UTF8 = new TextEncoder();
const LOSSY_DECODER = new TextDecoder("utf-8");

function utf8ByteLength(text: string): number {
  return UTF8.encode(text).byteLength;
}

function excerptOf(bytes: Uint8Array): string {
  return LOSSY_DECODER.decode(bytes.subarray(0, FATAL_EXCERPT_BYTES));
}

/** The bounded facts a tier-3 report carries (§4.2) for a decoded line
 * a session parser cannot use: the first 4 KiB of its UTF-8 bytes and
 * its full byte length. One unit for every layer (review live23: the
 * parsers cut 4096 characters, up to 16 KiB of multibyte text). */
export function unusableFacts(line: string): { excerpt: string; bytes: number } {
  const bytes = UTF8.encode(line);
  return { excerpt: excerptOf(bytes), bytes: bytes.byteLength };
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
  private readonly graceMs: number;
  private readonly onLine: (line: string) => void;
  private readonly onFatal: (fatal: SessionFatal) => void;
  private giveUpReads: () => void = () => {};

  private fatal: SessionFatal | null = null;
  private stopArmed = false;
  private killDeadline = 0;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private captureTimer: ReturnType<typeof setInterval> | null = null;
  private stdinEnded = false;
  /** Unflushed stdin bytes, and the generation of the newest write that
   * left any. Bun resolves every pending write's promise together, once
   * the whole buffer has drained, so a resolution clears the backlog
   * only when no newer write is still pending behind it. */
  private backlogBytes = 0;
  private backlogGeneration = 0;
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

  get fatalFraming(): SessionFatal | null {
    return this.fatal;
  }

  /**
   * Write one line to the harness's stdin. The newline is appended here;
   * a line that itself contains one (or a NUL) is a framing bug in the
   * caller and is refused, never mangled onto the wire. An oversize line
   * is refused without touching the stream, so the next write is intact.
   * So is a line that would push the unread stdin backlog past
   * MAX_HARNESS_BACKLOG_BYTES: every driver treats a refused write as a
   * codemux fatal, so a harness that stops reading ends the session
   * instead of growing codemux's memory (review live19).
   */
  writeLine(line: string): WriteLineResult {
    if (this.stdinEnded) return { ok: false, reason: "closed" };
    if (line.includes("\0") || line.includes("\n") || line.includes("\r")) {
      return { ok: false, reason: "framing" };
    }
    const bytes = utf8ByteLength(line) + 1;
    if (bytes - 1 > MAX_INPUT_LINE_BYTES) {
      return { ok: false, reason: "oversize" };
    }
    if (this.backlogBytes + bytes > MAX_HARNESS_BACKLOG_BYTES) {
      return { ok: false, reason: "backlog" };
    }
    const stdin = this.proc.stdin as import("bun").FileSink | number | undefined;
    if (stdin === undefined || typeof stdin === "number") {
      return { ok: false, reason: "closed" };
    }
    try {
      const drained = stdin.write(`${line}\n`);
      // A full sink (a line larger than the pipe) hands the remainder to
      // an async drain, and a child that dies mid-drain rejects that
      // promise with EPIPE — after the submit already succeeded. The
      // child's exit is what reports the death, so the rejection is
      // absorbed here instead of surfacing as an unhandled one that kills
      // codemux (review live14).
      if (typeof drained === "number") {
        this.backlogBytes = 0;
      } else {
        this.backlogBytes += bytes;
        const generation = ++this.backlogGeneration;
        drained.then(
          () => {
            if (generation === this.backlogGeneration) this.backlogBytes = 0;
          },
          () => {}
        );
      }
    } catch {
      return { ok: false, reason: "closed" };
    }
    return { ok: true };
  }

  /** Half-close the harness's stdin (the EOF half of a graceful end). */
  endInput(): void {
    if (this.stdinEnded) return;
    this.stdinEnded = true;
    const stdin = this.proc.stdin as import("bun").FileSink | number | undefined;
    if (stdin === undefined || typeof stdin === "number") return;
    try {
      const ended = stdin.end();
      // The trailing drain of a full sink rejects the same way write's
      // does; already closed underneath us is the same outcome.
      if (typeof ended !== "number") ended.catch(() => {});
    } catch {
      // Already closed underneath us; the outcome is the same.
    }
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
    this.stopCapture();
    // A child that already exited needs no signal, and its end path has
    // already run its tree kill and cleared timers: arming the SIGKILL
    // timer now would hold the event loop for the grace and then signal a
    // reaped process group (review live18).
    if (this.childExited) return;
    // SIGTERM to the child alone: the harness keeps the grace period to
    // persist the session and shut down its own children. The tree-scoped
    // SIGKILL below (and the unconditional one in the end path) covers
    // whatever ignores it.
    signalProcess(this.target, "SIGTERM", "process");
    this.killDeadline = performance.now() + this.graceMs;
    this.killTimer = setTimeout(
      () => signalProcess(this.target, "SIGKILL", "tree"),
      this.graceMs
    );
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
        // is already an overflow — waiting for its newline would mean
        // buffering without bound. Discard (bounded memory) whether or not
        // a fatal was already reported; report only the first.
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
    // JSON validity.
    if (lineBytes.byteLength === 0) return;
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
    this.onFatal(fatal);
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
    if (this.captureTimer !== null) {
      clearInterval(this.captureTimer);
      this.captureTimer = null;
    }
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

export interface OutboundOverflow {
  events: number;
  bytes: number;
}

/** Why event delivery stopped (§4.2): the caller stopped reading (a bound
 * tripped) or the sink itself failed (a closed pipe). Both are fatal to
 * the session; the class only picks the diagnostic — a silent one leaves
 * a harness running with nowhere to send events. */
export type OutboundFailure =
  | ({ kind: "overflow" } & OutboundOverflow)
  | { kind: "sink"; error: unknown };

/**
 * The bounded queue of event lines to the caller (design §4.2): 1024
 * events / 64 MiB pending, and a caller that stops reading breaches a bound
 * and ends the session instead of growing codemux without limit. Entries
 * are handed to `sink` one at a time in order; a bound is checked against
 * what is still queued, so a fast sink keeps the queue empty and a stopped
 * one trips it deterministically. A sink that rejects is just as fatal and
 * just as reported: `onFailure` fires for both classes, exactly once each
 * — both classes latch, so a stream of further enqueues after the first
 * failure cannot re-fire the callback.
 */
export class BoundedOutboundQueue {
  private readonly sink: (line: string) => Promise<void> | void;
  private readonly onFailure: (failure: OutboundFailure) => void;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private entries: string[] = [];
  private pendingBytes = 0;
  private flushing = false;
  private sinkError: unknown = null;
  private overflowed = false;
  private abandoned = false;

  constructor(
    sink: (line: string) => Promise<void> | void,
    onFailure: (failure: OutboundFailure) => void,
    bounds?: { events?: number; bytes?: number }
  ) {
    this.sink = sink;
    this.onFailure = onFailure;
    this.maxEvents = bounds?.events ?? MAX_PENDING_EVENTS;
    this.maxBytes = bounds?.bytes ?? MAX_PENDING_EVENT_BYTES;
  }

  /** Queue one line. Returns false when a bound is breached (the failure
   * callback has already fired, once), after the sink has failed, or
   * after the queue was abandoned — either way the caller treats the
   * queue as a fatal end. */
  enqueue(line: string): boolean {
    if (this.sinkError !== null || this.abandoned) return false;
    const bytes = utf8ByteLength(line) + 1;
    if (
      this.entries.length >= this.maxEvents ||
      this.pendingBytes + bytes > this.maxBytes
    ) {
      // The overflow class keeps the queued entries (a drain may still
      // reach the caller); the sink class, below, clears them. The
      // callback fires on the first breach only: harness lines keep
      // arriving after it, and re-firing a diagnostic per line is noise.
      if (!this.overflowed) {
        this.overflowed = true;
        this.onFailure({
          kind: "overflow",
          events: this.entries.length + 1,
          bytes: this.pendingBytes + bytes,
        });
      }
      return false;
    }
    this.entries.push(line);
    this.pendingBytes += bytes;
    if (!this.flushing) void this.flushLoop();
    return true;
  }

  /** Resolves when every queued line has been handed to the sink; rejects
   * with the sink's error if the sink failed. Resolves immediately once
   * the queue is abandoned — the caller already declared the remaining
   * entries undelivered, so waiting longer serves no one. */
  async flush(): Promise<void> {
    while ((this.entries.length > 0 || this.flushing) && !this.abandoned) {
      // The flush loop clears `flushing` only after the queue is empty, so
      // polling here cannot miss a refill that happened mid-flush.
      await Bun.sleep(1);
    }
    if (this.sinkError !== null) throw this.sinkError;
  }

  /** Abandon delivery (the final-flush give-up): the entries are dropped
   * and `flush` stops waiting, so a sink that never settles cannot hold
   * the process open after the caller already reported the final event
   * as undelivered. An already-latched sink failure stays latched. */
  abandon(): void {
    if (this.abandoned) return;
    this.abandoned = true;
    this.entries = [];
    this.pendingBytes = 0;
  }

  get pending(): OutboundOverflow {
    return { events: this.entries.length, bytes: this.pendingBytes };
  }

  /** Latch the sink failure and report it exactly once: delivery is dead,
   * so the entries are dropped and the driver hears why. */
  private fail(error: unknown): void {
    if (this.sinkError !== null) return;
    this.sinkError = error;
    this.entries = [];
    this.pendingBytes = 0;
    this.onFailure({ kind: "sink", error });
  }

  private async flushLoop(): Promise<void> {
    this.flushing = true;
    try {
      while (this.entries.length > 0) {
        const line = this.entries[0] as string;
        // An entry stays counted until the sink completes its write: a
        // stopped reader is exactly a sink that never resolves, so pending
        // grows until a bound trips. Only then is it dropped.
        try {
          await this.sink(line);
        } catch (error) {
          this.fail(error);
          return;
        }
        this.entries.shift();
        this.pendingBytes -= utf8ByteLength(line) + 1;
      }
    } finally {
      this.flushing = false;
    }
  }
}

/**
 * Wait for the queue's final flush with a bounded give-up (§4.6): true
 * only when every queued line — `session_ended` included — actually
 * reached the sink. On timeout the queue is abandoned, which is what
 * lets `finish` both report the final event as undelivered (exit-code
 * honesty) and still resolve: without the abandon, the flush poll loop
 * would wait on a sink that never settles and hold the process open
 * after it already gave up (found by review live3). A sink failure
 * during the flush is false, not a rejection riding the end path.
 */
export async function awaitFinalFlush(
  queue: BoundedOutboundQueue,
  giveUpMs: number = 1_000
): Promise<boolean> {
  // The rejection handler is attached before the race so a failure that
  // lands after the give-up won is still consumed, never an unhandled
  // rejection during the end path.
  const flushed = queue.flush().then(
    () => true,
    () => false
  );
  let timer: ReturnType<typeof setTimeout> | null = null;
  const gaveUp = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), giveUpMs);
  });
  try {
    const delivered = await Promise.race([flushed, gaveUp]);
    if (!delivered) queue.abandon();
    return delivered;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * The session's signal wiring (design §4.6): the first SIGINT/SIGTERM/
 * SIGHUP starts the shutdown path; it runs to completion before codemux
 * exits 143 — never `process.exit` inside the handler. Later signals are
 * absorbed while the first one runs.
 */
export interface SessionSignalGate {
  trigger(signal: NodeJS.Signals): void;
  dispose(): void;
}

export function installSessionSignalHandlers(
  onFirst: (signal: NodeJS.Signals) => void
): SessionSignalGate {
  let fired = false;
  const handler = (signal: NodeJS.Signals): void => {
    if (fired) return;
    fired = true;
    onFirst(signal);
  };
  const forward = (signal: NodeJS.Signals) => () => handler(signal);
  const onSigint = forward("SIGINT");
  const onSigterm = forward("SIGTERM");
  const onSighup = forward("SIGHUP");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);
  return {
    trigger: handler,
    dispose(): void {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      process.off("SIGHUP", onSighup);
    },
  };
}

/** The fatal a caller-stdin read error reports (review live17): the end
 * path is the stdin-close one, but a failed read is not a clean close. */
export function callerStdinFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `reading the caller's stdin failed (${detail}); ending the session`;
}

/** The fatal for a child that exits nonzero during the end path with no
 * completion delivered (§4.6, review live9). An idle child counts too:
 * a harness that fails while persisting is a failure whether or not a
 * turn was open (review live17). */
export function drainFailureMessage(
  agent: string,
  code: number,
  turnOpen: boolean
): string {
  return turnOpen
    ? `the ${agent} process exited with code ${code} during the shutdown drain before completing its open turn`
    : `the ${agent} process exited with code ${code} during the shutdown drain`;
}

/** The reason a crash end's synthesized turn completion carries: the
 * fatal that ended the session, which is not always the harness dying
 * (an outbound overflow, a registry failure, a caller-stdin error;
 * review live17). */
export function crashSynthesisReason(firstFatal: string | null): string {
  return firstFatal === null
    ? "the session ended on a failure before the turn completed"
    : `the session ended on a failure before the turn completed: ${firstFatal}`;
}
