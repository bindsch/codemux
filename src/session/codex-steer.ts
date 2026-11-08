/**
 * The codex driver's steer flush, split from codex-turns.ts at the
 * 500-line cap: the batched turn/steer whose probe counts bytes
 * incrementally instead of re-serializing the batch per increment (review
 * round 341). The steer buffer and its drop notice stay with the turn
 * completion paths in codex-turns.ts; src/session/codex-driver.ts owns
 * the lifecycle.
 */

import { buildSteerRequest, steerElementBytes } from "./codex-session.js";
import { MAX_INPUT_LINE_BYTES, utf8ByteLength } from "./stdin-writer.js";
import { CodexDriverTurns, inputSeqList } from "./codex-turns.js";

export abstract class CodexDriverSteer extends CodexDriverTurns {
  /** `currentSeq` is the steer line being handled now, which its caller
   * rejects itself when the write is refused; every other line in a
   * refused batch was acked earlier and is named here (review live23). */
  protected flushSteer(currentSeq: number | null = null): void {
    if (this.steerBuffer.length === 0 || this.harnessTurnId === null) return;
    const threadId = this.threadId ?? "";
    const expectedTurnId = this.harnessTurnId;
    // Batch greedily but never past the 17 MiB write cap (review live14):
    // every buffered text passed the pre-ack check alone, and joining them
    // can cross the cap — a frame writeToHarness would refuse as oversize,
    // ending the session after each steer in it was already acked. The
    // frame is a linear join of serialized elements, so the probe keeps a
    // running byte count and appends each text's own bytes
    // (steerElementBytes; review round 341 — re-serializing the whole
    // batch per increment was quadratic up to the 256-line / 32 MiB buffer
    // caps and stalled harness reads in one synchronous block). `call`
    // assigns `requestCounter + 1` as the id, so the probe frame is
    // byte-identical to the one that is then sent. Splitting is the wire's
    // common shape anyway: one request per steer once the turn is open;
    // batching only happens while turn/start was in flight.
    while (this.steerBuffer.length > 0) {
      const base = utf8ByteLength(
        buildSteerRequest(this.requestCounter + 1, threadId, expectedTurnId, [])
      );
      let count = 0;
      let frameBytes = base;
      for (const [index, entry] of this.steerBuffer.entries()) {
        const element = steerElementBytes(entry.text, index > 0);
        if (frameBytes + element > MAX_INPUT_LINE_BYTES) break;
        frameBytes += element;
        count = index + 1;
      }
      if (count === 0) {
        // The pre-ack margin guarantees a single text fits; zero can
        // only mean the buffer holds something that check should have
        // refused. Drop it with the notice rather than spin forever.
        this.dropBufferedSteer();
        return;
      }
      const entries = this.steerBuffer.splice(0, count);
      const texts = entries.map((entry) => entry.text);
      const sent = this.call(
        {
          kind: "steer",
          inputSeqs: entries.map((entry) => entry.inputSeq),
          turnId: this.fsm.activeTurn,
        },
        (id) => buildSteerRequest(id, threadId, expectedTurnId, texts)
      );
      // A refused write started the crash end; the rest cannot follow.
      if (sent === null) {
        const acked = [...entries, ...this.steerBuffer]
          .map((entry) => entry.inputSeq)
          .filter((seq) => seq !== currentSeq);
        this.steerBuffer.length = 0;
        if (acked.length > 0) {
          this.emitError(
            false,
            "codemux",
            `steering input could not be delivered to the harness (${inputSeqList(acked)})`
          );
        }
        return;
      }
    }
  }
}
