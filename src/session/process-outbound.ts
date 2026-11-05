/**
 * The session outbound path: the SessionWriter the SessionProcess
 * composes for every harness stdin write, the input deliverability caps,
 * and the bounded event queue to the caller. src/session/process.ts owns
 * the lifecycle and re-exports these.
 */

/** The queue's "no sink failure yet" state. `null` cannot carry it: a sink
 * that rejects with `null` is a real failure — JavaScript allows any
 * rejection value — and an equality check against `null` would read that
 * rejection as successful delivery (review round 64, finding 9). */
const NO_SINK_ERROR = Symbol("no sink error");

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

const UTF8 = new TextEncoder();

function utf8ByteLength(text: string): number {
  return UTF8.encode(text).byteLength;
}

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

  constructor(proc: ReturnType<typeof Bun.spawn>) {
    this.proc = proc;
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
    if (this.stdinEnded) return { ok: false, reason: "closed" };
    if (text.includes("\0")) {
      return { ok: false, reason: "framing" };
    }
    const bytes = utf8ByteLength(text);
    if (bytes > MAX_INPUT_LINE_BYTES) {
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
      const drained = stdin.write(text);
      // The same drain accounting as writeLine (review live14): an async
      // drain's EPIPE on a dying child is absorbed, and a resolution clears
      // the backlog only when no newer write is pending behind it.
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

/** The terminal lane's fixed reserved capacity (round al31, narrowed by
 * round al32 to the session's end events alone, split by round al35 into
 * two classes): terminal entries skip the event and byte bounds but never
 * the lane, so a stalled sink cannot grow the queue without limit through
 * terminal entries either. Each queued line is itself bounded by the line
 * cap that produced it, so the lane's memory is at most this constant
 * times that cap — a small fixed reservation, not an unbounded one. One
 * slot of the lane is `session_ended`'s alone: fatal-class entries are
 * capped at one short of this capacity, so a flood of fatals can never
 * fill the lane and starve the end event of its slot (round al35, edges
 * major 4). */
export const TERMINAL_LANE_CAPACITY = 8;

/**
 * The bounded queue of event lines to the caller (design §4.2): 1024
 * events / 64 MiB pending, and a caller that stops reading breaches a bound
 * and ends the session instead of growing codemux without limit. Entries
 * are handed to `sink` one at a time in order; a bound is checked against
 * what is still queued, so a fast sink keeps the queue empty and a stopped
 * one trips it deterministically. An overflow is sticky: once a bound has
 * breached, ordinary events are refused for the rest of the session (a
 * later drain cannot un-gap the stream the caller was told had a gap);
 * only the terminal classes the end path needs still queue. A sink that
 * rejects is just as fatal and
 * just as reported: `onFailure` fires for both classes, exactly once each
 * — both classes latch, so a stream of further enqueues after the first
 * failure cannot re-fire the callback.
 *
 * The terminal lane is reserved for the events that end the session's
 * contract — `session_ended`, fatals, and final turn emissions. Live
 * `turn_completed` events and the
 * input acks (`input_accepted`, `input_rejected`) are ordinary entries
 * subject to both bounds, so a stalled sink fed repeated input drops them
 * once a bound trips, exactly as it drops any other event. A terminal
 * entry uses the ordinary capacity FIRST and falls back to the lane only
 * when the ordinary bounds are full, so eight pending `turn_completed`
 * events — ordinary entries, all eight — can never take the slot the end
 * event needs, whatever their number. Within the lane the two terminal
 * classes split the capacity: final turn emissions share the fatal class.
 * A fatal-class
 * entry may occupy at most TERMINAL_LANE_CAPACITY - 1 slots, so the last
 * slot is `session_ended`'s alone and a crash end that owes the caller a
 * flood of fatal-class events — each its own queued line — cannot fill
 * the lane and starve the end event of the very slot the lane exists to
 * keep; before the split both classes shared one undifferentiated count,
 * so eight queued fatals refused the `session_ended` behind them. The
 * lane keeps the end reachable when the ordinary bounds are exhausted —
 * 1,024 queued events and then stdin close still delivers exactly one
 * `session_ended` — while capping the memory the lane itself can hold at
 * TERMINAL_LANE_CAPACITY entries (a crash end can owe the caller more
 * than one fatal-class event before `session_ended`, so the reservation
 * is one lane, not one slot; their bytes are not counted against the
 * ordinary byte bound; see the constant's note). Ordering is preserved: a
 * terminal entry sits in the same list as the rest and the flush loop
 * hands them to the sink in arrival order; only the bound checks and the
 * `pending` accounting pass them by.
 */
export class BoundedOutboundQueue {
  private readonly sink: (line: string) => Promise<void> | void;
  private readonly onFailure: (failure: OutboundFailure) => void;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private entries: { line: string; bytes: number; lane: "end" | "fatal" | null }[] =
    [];
  /** Lane entries of BOTH classes (an end or fatal entry each add one);
   * `queuedFatal` below counts the fatal share of those. */
  private queuedTerminal = 0;
  private queuedFatal = 0;
  private pendingBytes = 0;
  private flushing = false;
  private sinkError: unknown = NO_SINK_ERROR;
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
   * callback has already fired, once), after the sink has failed, after
   * the queue was abandoned, or after an overflow already ended the
   * session and the entry is ordinary — either way the caller treats the
   * queue as a fatal end. An overflow is sticky: once a bound has
   * breached, ordinary entries are refused for the session's remainder
   * even after a drain frees capacity, so the stream never resumes a
   * normal-looking continuation after the gap it acknowledged; only the
   * terminal classes the overflow path needs (fatals and the end event)
   * still queue. Ordinary entries are refused at the event or
   * byte bound. A terminal entry — `session_ended` (`terminal: true`) or
   * a fatal that ends the session (`terminal: "fatal"`) — takes the
   * ordinary capacity first and is refused only when the ordinary bounds
   * are full AND its lane class is full too: the end event at
   * TERMINAL_LANE_CAPACITY lane entries, a fatal at one short of that,
   * so the lane's last slot is `session_ended`'s alone and a flood of
   * fatals cannot starve the end event (round al35, edges major 4). A
   * live `turn_completed` is ordinary; a final synthesized completion
   * uses the fatal class, preserving the end event's last slot. */
  enqueue(line: string, options?: { terminal?: boolean | "fatal" }): boolean {
    if (this.sinkError !== NO_SINK_ERROR || this.abandoned) return false;
    // An overflow is sticky (review round 100): the failure callback told
    // the caller the stream has a gap, so a drain that frees capacity must
    // not resume ordinary delivery and present a normal-looking
    // continuation after an acknowledged loss. Only the terminal classes
    // the overflow path itself needs — the fatal notices and the end
    // event — can still queue; `terminal: false` is ordinary too.
    const laneClass: "end" | "fatal" | null =
      options?.terminal === true
        ? "end"
        : options?.terminal === "fatal"
          ? "fatal"
          : null;
    if (this.overflowed && laneClass === null) return false;
    const bytes = utf8ByteLength(line) + 1;
    const ordinary = this.entries.length - this.queuedTerminal;
    const ordinaryFull =
      ordinary >= this.maxEvents || this.pendingBytes + bytes > this.maxBytes;
    // A fatal cannot take the lane's last slot — that one is the end
    // event's — so the fatal cap is one short of the lane's and seven
    // queued fatals still leave room for exactly one `session_ended`
    // behind them (round al35, edges major 4).
    const laneFull =
      laneClass === "fatal"
        ? this.queuedFatal >= TERMINAL_LANE_CAPACITY - 1
        : this.queuedTerminal >= TERMINAL_LANE_CAPACITY;
    const breach = laneClass === null ? ordinaryFull : ordinaryFull && laneFull;
    if (breach) {
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
    // Ordinary capacity first; the lane only when those bounds are full
    // — the entry's class records which accounting it joined, and the
    // flush loop returns it on delivery.
    const viaLane = laneClass !== null && ordinaryFull;
    this.entries.push({ line, bytes, lane: viaLane ? laneClass : null });
    if (viaLane) {
      this.queuedTerminal++;
      if (laneClass === "fatal") this.queuedFatal++;
    } else {
      this.pendingBytes += bytes;
    }
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
    if (this.sinkError !== NO_SINK_ERROR) throw this.sinkError;
  }

  /** Abandon delivery (the final-flush give-up): the entries are dropped
   * and `flush` stops waiting, so a sink that never settles cannot hold
   * the process open after the caller already reported the final event
   * as undelivered. An already-latched sink failure stays latched. */
  abandon(): void {
    if (this.abandoned) return;
    this.abandoned = true;
    this.entries = [];
    this.queuedTerminal = 0;
    this.queuedFatal = 0;
    this.pendingBytes = 0;
  }

  get pending(): OutboundOverflow {
    return { events: this.entries.length, bytes: this.pendingBytes };
  }

  /** Latch the sink failure and report it exactly once: delivery is dead,
   * so the entries are dropped and the driver hears why. */
  private fail(error: unknown): void {
    if (this.sinkError !== NO_SINK_ERROR) return;
    this.sinkError = error;
    this.entries = [];
    this.queuedTerminal = 0;
    this.queuedFatal = 0;
    this.pendingBytes = 0;
    this.onFailure({ kind: "sink", error });
  }

  private async flushLoop(): Promise<void> {
    this.flushing = true;
    try {
      while (this.entries.length > 0) {
        const entry = this.entries[0] as {
          line: string;
          bytes: number;
          lane: "end" | "fatal" | null;
        };
        // An entry stays counted until the sink completes its write: a
        // stopped reader is exactly a sink that never resolves, so pending
        // grows until a bound trips. Only then is it dropped. Lane
        // entries never count against the byte bound, so they subtract
        // nothing here — only the lane's own tallies, which their shift
        // returns (both the shared lane count and the fatal share).
        try {
          await this.sink(entry.line);
        } catch (error) {
          this.fail(error);
          return;
        }
        this.entries.shift();
        if (entry.lane === null) {
          this.pendingBytes -= entry.bytes;
        } else {
          this.queuedTerminal--;
          if (entry.lane === "fatal") this.queuedFatal--;
        }
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
