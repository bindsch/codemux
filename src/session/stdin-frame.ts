// The caller-stdin framer for `codemux session` (design §4.5) and the
// SessionDriver surface it hands lines to. src/session/cli.ts owns the
// command and attaches the framer to the driver it builds.
import { MAX_INPUT_LINE_BYTES } from "./process.js";
import type { SessionFatal, SessionProcess } from "./process.js";

/** The caller-stdin surface every driver exposes; frameCallerStdin is
 * driver-agnostic by design (§4.5). `handleCallerEnd` takes the read
 * error when the stream failed rather than ended. */
export interface SessionDriver {
  /** Attaches the long-lived session child. Turn-per-process agents
   * (opencode, aider, kimi) have none — they spawn per caller input
   * through their spawnTurn closure instead. */
  attach?(proc: SessionProcess): void;
  /** The CLI calls this immediately before its spawn and answers it with
   * attach() (a child) or spawnAbandoned() (a throw): an end path that
   * begins inside that window — a signal during the spawn's async
   * preflight — holds its completion until the answer settles, so the
   * resume record, the session_ended event, and run() never report the
   * session ended while the child is still being born (review round
   * 64). Long-lived-child drivers implement it; turn-per-process agents
   * have no child to track. */
  spawnPending?(): void;
  /** The CLI's spawn ended without a child: an end path waiting on the
   * pending spawn proceeds with none. */
  spawnAbandoned?(): void;
  /** True once an end path has begun (a signal or a timeout during the
   * spawn's preflight among them): the CLI's spawn-throw catch hands the
   * ending to that path instead of releasing the record itself and
   * rethrowing past it (round 20, minor 8; round 65 for every
   * long-lived-child driver). */
  endPathStarted?(): boolean;
  /** The spawn-throw catch's exit once endPathStarted() is true: awaits
   * the end path's verdict and leaves through the session's exit code. */
  finishAfterSpawnThrow?(error: unknown): Promise<void>;
  run(): Promise<number>;
  handleHarnessLine(line: string): void;
  handleFatal(fatal: SessionFatal): void;
  handleCallerLine(line: string): void;
  handleCallerEnd(error?: unknown): void;
  /** The resume claim succeeded: the driver now owns the record and
   * releases it on every end path (review live20). */
  adoptResumeClaim(): void;
  dispose(): void;
}

/** The notice every driver's finishAfterSpawnThrow prints: the spawn
 * failure is still reported, and the ending is the end path's. */
export function reportSpawnThrow(error: unknown): void {
  console.error(
    `codemux: the session child could not be spawned (${
      error instanceof Error ? error.message : String(error)
    }); ending through the session's already-begun end path`
  );
}

/** The stdin-shaped surface frameCallerStdin attaches to — injectable so
 * tests can drive the framing without the process's own stdin. */
export interface FramedInput {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  once(event: "end", listener: () => void): unknown;
  once(event: "error", listener: (error: unknown) => void): unknown;
  removeListener(event: "data", listener: (chunk: Buffer) => void): unknown;
  removeListener(event: "end", listener: () => void): unknown;
  removeListener(event: "error", listener: (error: unknown) => void): unknown;
}

/** Frame the caller's stdin into lines for the driver. Blank lines are
 * framing whitespace; a line that is not valid UTF-8 is rejected as
 * malformed; a line over the input cap is rejected as malformed
 * input rather than buffered without limit — exactly once per physical
 * line, with the remainder discarded through the line's terminating
 * newline (it is part of the rejected line, not a new command).
 *
 * The buffer is a grow-on-demand array with a scan cursor, the same
 * shape as the harness-side framer (process.ts): rescanning from byte 0
 * and recopying the whole buffer on every chunk made a line near the cap
 * arriving in pipe-sized chunks quadratic (review live15, the framer
 * sibling). */
export function frameCallerStdin(
  driver: Pick<SessionDriver, "handleCallerLine" | "handleCallerEnd">,
  input: FramedInput = process.stdin
): () => void {
  let buffer = Buffer.alloc(64 * 1024);
  let length = 0;
  let searchFrom = 0;
  let discarding = false;
  const rejectOversize = (): void => {
    console.error(
      `codemux: an input line exceeded the ${MAX_INPUT_LINE_BYTES}-byte cap and was rejected`
    );
    driver.handleCallerLine("oversize");
  };
  // UTF-8 decoding is fatal-strict here too (design §4.2): a lossy decode
  // substituted U+FFFD for a bad byte, so a line carrying one was acked,
  // echoed, and forwarded with its text silently changed (review live20).
  // The line is rejected as malformed instead, like any unparseable one.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const deliverLine = (bytes: Buffer): void => {
    let line: string;
    try {
      line = decoder.decode(bytes).replace(/\r$/, "");
    } catch {
      console.error("codemux: an input line was not valid UTF-8 and was rejected");
      driver.handleCallerLine("invalid-utf8");
      return;
    }
    if (line.trim() !== "") driver.handleCallerLine(line);
  };
  const deliver = (): void => {
    while (length > 0) {
      const newline = buffer.subarray(0, length).indexOf(0x0a, searchFrom);
      if (newline === -1) break;
      // The cap applies to every complete line, not only to an
      // unterminated run: a line whose newline arrived in the same chunk
      // as the bytes that took it past the cap used to be delivered
      // (review live18).
      const oversize = newline > MAX_INPUT_LINE_BYTES;
      // A copy: the compaction below overwrites these bytes.
      const bytes = oversize ? null : Buffer.from(buffer.subarray(0, newline));
      buffer.copyWithin(0, newline + 1, length);
      length -= newline + 1;
      searchFrom = 0;
      if (bytes === null) {
        rejectOversize();
        continue;
      }
      deliverLine(bytes);
    }
    // The last scan covered [searchFrom, length) and found no newline;
    // the next chunk's scan starts where this one stopped.
    searchFrom = length;
  };
  const append = (chunk: Buffer): void => {
    if (length + chunk.length > buffer.length) {
      const grown = Buffer.alloc(Math.max(buffer.length * 2, length + chunk.length));
      buffer.copy(grown, 0, 0, length);
      buffer = grown;
    }
    buffer.set(chunk, length);
    length += chunk.length;
  };
  const onData = (chunk: Buffer): void => {
    if (discarding) {
      // Still inside the rejected oversized line: everything up to its
      // newline belongs to it, whatever it contains.
      const newline = chunk.indexOf(0x0a);
      if (newline === -1) return;
      discarding = false;
      length = 0;
      searchFrom = 0;
      append(chunk.subarray(newline + 1));
    } else {
      append(chunk);
    }
    deliver();
    if (length > MAX_INPUT_LINE_BYTES) {
      // What remains after delivery holds no newline: one unterminated
      // run past the cap. Reject the line once, then resync at its
      // newline — without the discard the remainder would re-accumulate
      // (a second rejection and input_seq for one line) or be parsed as a
      // command it never was, depending on chunk boundaries.
      length = 0;
      searchFrom = 0;
      discarding = true;
      rejectOversize();
    }
  };
  const onEnd = (): void => {
    input.removeListener("error", onError);
    if (!discarding) {
      deliver();
      const rest = Buffer.from(buffer.subarray(0, length));
      length = 0;
      if (rest.length > 0) deliverLine(rest);
    }
    driver.handleCallerEnd();
  };
  // A read error is not an end of input: the trailing partial line may be
  // a fragment, so it is not delivered, and the driver reports the error
  // as a failure instead of a clean close (review live17 — it used to run
  // the same handler as "end" and exit 0).
  const onError = (error: unknown): void => {
    input.removeListener("end", onEnd);
    length = 0;
    driver.handleCallerEnd(error ?? new Error("unknown read error"));
  };
  input.on("data", onData);
  input.once("end", onEnd);
  input.once("error", onError);
  return (): void => {
    input.removeListener("data", onData);
    input.removeListener("end", onEnd);
    input.removeListener("error", onError);
  };
}
