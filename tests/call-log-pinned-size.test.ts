/**
 * The ledger stream's pinned identity records the bytes the pass read, not
 * the end it planned to read to (review round 316): a ledger that shrinks
 * under the pass reaches EOF early, and a second pass pinned to the planned
 * end would read bytes the first pass never inspected.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamCallLog } from "../src/call-log.js";
import { BASE_RECORD } from "./helpers/call-log.js";

test("the pinned size is the position the pass reached, not the planned end", () => {
  const dir = mkdtempSync(join(tmpdir(), "codemux-call-pin-"));
  try {
    const path = join(dir, "calls.jsonl");
    const line = `${JSON.stringify(BASE_RECORD)}\n`;
    writeFileSync(path, line + line);
    const size = Buffer.byteLength(line) * 2;
    // A planned end past the file: the pass stops at EOF and says so.
    const short = streamCallLog(path, () => {}, { endAt: size + 4096 });
    expect(short.identity.size).toBe(size);
    // A planned end inside the file: the pass stops there.
    const partial = streamCallLog(path, () => {}, { endAt: Buffer.byteLength(line) });
    expect(partial.identity.size).toBe(Buffer.byteLength(line));
    // No plan: the whole file.
    expect(streamCallLog(path, () => {}).identity.size).toBe(size);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
