/**
 * The harness stdin write path for sessions (split from
 * src/session/process-outbound.ts so each file keeps its size budget):
 * framed line writes, raw chunk writes, the EOF half-close, and the
 * repeating decline carrier — all under the framing, size, and backlog
 * caps. SessionProcess composes one per child and delegates to it;
 * src/session/process.ts owns the lifecycle and re-exports these.
 */

import { firstBlockLeft, RepeatPacer, sinkWriteState } from "../process-stdin-repeat.js";

/** A caller input line over this is rejected before it reaches the wire. */
export const MAX_INPUT_LINE_BYTES = 17 * 1024 * 1024;
/** Bytes written to the harness's stdin that it has not yet read. Bun's
 * pipe sink buffers every write it cannot flush, without limit, so a
 * harness that stops reading would otherwise let the caller grow
 * codemux's memory without bound (review live19). */
export const MAX_HARNESS_BACKLOG_BYTES = 64 * 1024 * 1024;

export type WriteLineRejectReason = "oversize" | "framing" | "closed" | "backlog";

export interface WriteLineResult {
  ok: boolean;
  reason?: WriteLineRejectReason;
}

const UTF8 = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return UTF8.encode(text).byteLength;
}

/** What one submitted write left behind: `number` when the sink took the
 * whole chunk at once, or the pending drain when it applied backpressure.
 * Bun resolves every pending write's promise together, once the whole
 * buffer has drained. */
type DrainState = number | Promise<unknown>;

/**
 * The harness stdin write path: framed line writes, raw chunk writes, and
 * the EOF half-close, under the framing, size, and backlog caps.
 * SessionProcess composes one per child and delegates to it;
 * src/session/process.ts owns the lifecycle.
 */
export class SessionWriter {
  private readonly proc: ReturnType<typeof Bun.spawn>;

  private stdinEnded = false;
  /** Unflushed stdin bytes, and the generation of the newest write that
   * left any. Bun resolves every pending write's promise together, once
   * the whole buffer has drained, so a resolution clears the backlog
   * only when no newer write is still pending behind it. */
  private backlogBytes = 0;
  private backlogGeneration = 0;
  private writeFailed = false;
  private pending = new Set<Promise<unknown>>();

  constructor(proc: ReturnType<typeof Bun.spawn>, private readonly onFailure: (error: unknown, bytes: number) => void = () => {}) {
    this.proc = proc;
  }

  /** Prompt writes must settle before the process reports completion. */
  async settled(timeoutMs: number): Promise<void> {
    if (this.pending.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all([...this.pending]), new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          this.failed(new Error("stdin delivery did not settle after child exit"), this.backlogBytes);
          resolve();
        }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  private failed(error: unknown, bytes: number): void {
    if (this.writeFailed) return;
    this.writeFailed = true;
    this.onFailure(error, bytes);
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
    const submitted = this.submit(`${line}\n`, bytes);
    return submitted === null ? { ok: false, reason: "closed" } : { ok: true };
  }

  /**
   * Write one raw chunk to the harness's stdin with NO appended newline —
   * the primitive the harnesses that read stdin to EOF need: opencode takes
   * the whole non-TTY stdin as the one-shot message (`Bun.stdin.text()`), so
   * a multi-line prompt rides stdin exactly as written, and aider consumes
   * its canned "n\n" negatives the same way. Everything `writeLine` refuses
   * on framing grounds except the newline rule still applies: a NUL never
   * reaches the wire, the oversize and backlog caps are the same, and a
   * closed stdin is refused. The caller owns the framing — a chunk that is
   * not a whole number of the harness's input units is a caller bug.
   */
  writeRaw(text: string): WriteLineResult {
    return this.submitRaw(text).result;
  }

  /** writeRaw's checks and submit, keeping the write's drain state for
   * the repeating carrier, which must wait for it. */
  private submitRaw(text: string, required = true): { result: WriteLineResult; drain: DrainState | null } {
    const refused = (reason: WriteLineRejectReason) => ({
      result: { ok: false, reason } as WriteLineResult,
      drain: null,
    });
    if (this.stdinEnded) return refused("closed");
    if (text.includes("\0")) return refused("framing");
    const bytes = utf8ByteLength(text);
    if (bytes > MAX_INPUT_LINE_BYTES) return refused("oversize");
    if (this.backlogBytes + bytes > MAX_HARNESS_BACKLOG_BYTES) return refused("backlog");
    const drain = this.submit(text, bytes, required);
    return drain === null ? refused("closed") : { result: { ok: true }, drain };
  }

  /**
   * The repeating decline carrier (review round 153): feed `text` to the
   * child for its whole lifetime instead of one chunk plus the half-close.
   * Aider reads EOF as acceptance of its yes-default prompts, so while the
   * child is alive a read of its stdin must always return a decline and
   * never EOF. The first chunk is this call's synchronous result — the
   * caller reports its failure exactly as a failed `writeRaw` — and the
   * repeats after it never let a second write pile behind an undrained
   * one: a write the sink accepts at once has already left, and a write
   * under backpressure parks until it drains or the child exits, so a
   * child that never reads leaves one block pending in the sink, never a
   * growing pile. The repeats are paced (RepeatPacer), so the feeder
   * returns to the event loop between writes whatever the child does with
   * its stdin. stdin is never closed while the child can read it; a
   * repeat that fails (the read end is gone) or the child's exit ends the
   * feeder quietly and then releases the pipe. The child's exit, which
   * the process layer already reports, is the verdict.
   */
  repeatRawUntilExit(text: string, exited: Promise<unknown>): WriteLineResult {
    const first = this.submitRaw(text, false);
    if (!first.result.ok) return first.result;
    void this.repeatLoop(text, exited, first.drain);
    return first.result;
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
      if (typeof ended !== "number") ended.catch((error) => {
        if (this.pending.size > 0) this.failed(error, this.backlogBytes);
      });
    } catch {
      // Already closed underneath us; the outcome is the same.
    }
  }

  private async repeatLoop(
    text: string,
    exited: Promise<unknown>,
    first: DrainState | null
  ): Promise<void> {
    const bytes = utf8ByteLength(text);
    const pacer = new RepeatPacer(exited);
    // The first chunk counts toward the one-pending bound (review round
    // 154): no repeat is issued while it waits behind backpressure. After
    // it, the repeats are paced, never back to back (review round 153): a
    // child that drains stdin as fast as it is written keeps every write
    // synchronous, and a loop of synchronous writes never returns to the
    // event loop.
    let more = await firstBlockLeft(first, pacer);
    while (more && (await pacer.pause())) {
      const submitted = this.submit(text, bytes, false);
      // A refused repeat ends the feeder: the only refusals left here are
      // a closed stdin (someone half-closed it, or the child is gone) and
      // the backlog cap (one pending block cannot reach it, a block is
      // capped well under it, so this is a caller bug, and stopping is
      // the quiet failure).
      if (submitted === null) break;
      if (typeof submitted === "number") continue;
      // One block pending: wait for THIS write's drain or the exit,
      // whichever settles first. The wait consumes the drain's rejection,
      // so a finished child's EPIPE never surfaces anywhere.
      more = await pacer.drained(submitted);
    }
    // The child exited or its read end closed: nothing can read a further
    // decline, so release codemux's end of the pipe.
    this.endInput();
  }

  /** The shared submit under the caps, with the drain accounting the
   * backlog rule needs: a required write's asynchronous failure reaches
   * the process fatal channel. A resolution clears the backlog only when no
   * newer write is pending behind it. Returns null when the write could
   * not be submitted at all. */
  private submit(text: string, bytes: number, required = true): DrainState | null {
    if (this.writeFailed) return null;
    const stdin = this.proc.stdin as import("bun").FileSink | number | undefined;
    if (stdin === undefined || typeof stdin === "number") {
      return null;
    }
    try {
      const drained: unknown = stdin.write(text);
      const state = sinkWriteState(drained);
      // Bun answers a write to a sink it already closed (the child
      // exited) with a boolean: nothing was submitted.
      if (state === "closed") return null;
      if (state === "flushed") {
        this.backlogBytes = 0;
        return drained as number;
      }
      const pending = drained as Promise<unknown>;
      this.backlogBytes += bytes;
      const generation = ++this.backlogGeneration;
      const tracked = pending.then(
        () => {
          if (generation === this.backlogGeneration) this.backlogBytes = 0;
        },
        (error) => { if (required) this.failed(error, bytes); }
      );
      if (required) {
        this.pending.add(tracked);
        void tracked.then(() => this.pending.delete(tracked));
      }
      return pending;
    } catch {
      return null;
    }
  }
}
