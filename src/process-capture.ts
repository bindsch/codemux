import type { StdoutSink } from "./process-runner.js";

export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

export class OutputLimitError extends Error {
  /** What the failure reports of the stream, itself bounded at the capture
   * limit: a fold that overflowed on its cumulative kept bytes could hand
   * over more than the limit (two sub-limit replies), and a failure result
   * larger than the bound it reports contradicts it (round 31, edges 5). */
  readonly partialOutput: string;
  constructor(
    readonly streamName: "stdout" | "stderr",
    partialOutput: string
  ) {
    super(`${streamName} exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit`);
    this.partialOutput = boundedUtf8Prefix(partialOutput, MAX_CAPTURE_BYTES);
  }
}

/** The longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`,
 * ending on a character boundary (the same rule src/plain-unwrap/common.ts
 * applies; spelled here to keep this module free of fold imports). */
export function boundedUtf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}


/** Read a stream to its end, or until `giveUp` resolves, in which case the
 * read is canceled and what arrived so far is returned. Without a `sink` the
 * whole stream is captured, bounded at `MAX_CAPTURE_BYTES`; with one, the
 * sink consumes the stream and the bound applies to what it keeps — on
 * every exit branch, the give-up cancellation included (round al32). */
export async function readBounded(
  stream: ReadableStream<Uint8Array>,
  streamName: "stdout" | "stderr",
  giveUp: Promise<void> = new Promise(() => {}),
  sink?: StdoutSink,
  finishOptions: () => { timedOut: boolean; aborted?: boolean } = () => ({ timedOut: false })
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let output = "";
  let gaveUp = false;

  // The give-up reaction is registered ONCE, here — never raced against
  // each read. A chatty command emits thousands of small chunks, and a
  // pending promise per chunk pins all of them in memory until the capture
  // ends. Canceling the reader resolves the pending read as done, which
  // is what ends the loop on a timeout.
  giveUp.then(() => {
    gaveUp = true;
    reader.cancel().catch(() => {
      // The lock may already be released after a natural end.
    });
  }, () => {
    gaveUp = true;
    reader.cancel().catch(() => {});
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (gaveUp) {
          // A give-up cancellation can leave an incomplete multibyte
          // character buffered, and flushing a fatal decoder throws on
          // one. Every complete character was already emitted, so the
          // incomplete suffix is all that is lost: drop it and return the
          // timeout result instead of rejecting the whole capture. A
          // natural end with a partial character is genuinely invalid
          // UTF-8 and still throws.
          let tail = "";
          try {
            tail = decoder.decode();
          } catch {
            // Only the incomplete suffix is lost.
          }
          if (sink === undefined) return output + tail;
          if (tail !== "") sink.push(tail);
          // The capture bound holds on EVERY exit branch (round al32,
          // edges major 1): a timeout or signal abandonment ends the
          // read with give-up, and the fold a sink performs inside
          // finish() can push what it keeps past the limit exactly as at
          // a natural EOF (the al30 rule) — an abandoned run over the
          // bound fails at 125, never succeeds over the bound at 124.
          const folded = sink.finish({ ...finishOptions(), aborted: true });
          if (sink.keptBytes() > MAX_CAPTURE_BYTES) {
            await reader.cancel();
            throw new OutputLimitError(streamName, folded);
          }
          return folded;
        }
        const tail = decoder.decode();
        if (sink !== undefined && tail !== "") sink.push(tail);
        if (sink !== undefined) {
          // The EOF tail — and the fold a sink performs inside finish()
          // — are accounted against the capture bound like any completed
          // chunk (round al30, edges major 1): the check runs AFTER
          // finish(), because a wire-regime fold does not count the
          // buffered partial line until close() folds it (round al27's
          // rule), so a final unterminated event whose value crosses the
          // limit latches it exactly there — the run fails at 125 instead
          // of succeeding over the bound.
          const folded = sink.finish(finishOptions());
          if (sink.keptBytes() > MAX_CAPTURE_BYTES) {
            await reader.cancel();
            throw new OutputLimitError(streamName, folded);
          }
          return folded;
        }
        return output + tail;
      }
      if (sink !== undefined) {
        sink.push(decoder.decode(value, { stream: true }));
        // The sink's residue is this run's stdout: past the capture bound
        // the run fails at the limit, partial output and all, exactly as a
        // whole-stream capture does.
        if (sink.keptBytes() > MAX_CAPTURE_BYTES) {
          await reader.cancel();
          throw new OutputLimitError(streamName, sink.finish({ ...finishOptions(), aborted: true }));
        }
        continue;
      }
      const remaining = MAX_CAPTURE_BYTES - bytesRead;
      bytesRead += value.byteLength;
      if (value.byteLength > remaining) {
        output += decoder.decode(value.subarray(0, remaining), { stream: true });
        await reader.cancel();
        throw new OutputLimitError(streamName, output);
      }
      output += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`${streamName} is not valid UTF-8`, { cause: error });
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}


