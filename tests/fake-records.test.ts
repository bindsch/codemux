// The session fakes' record reader skips a record still being written
// (CI run 42759642305: a poll parsed a half-written line and threw).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFakeRecords } from "./helpers/fake-records.js";

test("an unterminated tail is a write in flight, not a record", () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-records-"));
  try {
    const path = join(dir, "records.jsonl");
    expect(readFakeRecords(path)).toEqual([]);
    writeFileSync(path, `${JSON.stringify({ n: 1 })}\n{"n":2,"text":"half`);
    expect(readFakeRecords(path)).toEqual([{ n: 1 }]);
    writeFileSync(path, `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2, text: "whole" })}\n`);
    expect(readFakeRecords(path)).toEqual([{ n: 1 }, { n: 2, text: "whole" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
