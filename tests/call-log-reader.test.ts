import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendCallRecord, CALL_LOG_ENV, MAX_CALL_LOG_BYTES, readCallLog, resetCallLogWarningForTests } from "../src/call-log.js";
import { BASE_RECORD, tempEnv } from "./helpers/call-log.js";

afterEach(() => {
  resetCallLogWarningForTests();
});

describe("readCallLog", () => {
  test("a line without the record's full shape is malformed, never a record (ul2)", () => {
    const { dir, cleanup } = tempEnv();
    try {
      const path = join(dir, "calls.jsonl");
      const good = JSON.stringify(BASE_RECORD);
      const lines = [
        // Parses as JSON, names ts/agent/kind — the old lenient check
        // accepted it, and the table's usage columns crashed on the
        // missing block.
        JSON.stringify({ ts: "2026-10-08T12:00:00.000Z", agent: "claude", kind: "run" }),
        // A usage block with a wrong-typed count is equally malformed.
        JSON.stringify({ ...BASE_RECORD, usage: { input_tokens: "many" } }),
        // So is a kind outside the record set.
        JSON.stringify({ ...BASE_RECORD, kind: "greeting" }),
        good,
      ].join("\n") + "\n";
      writeFileSync(path, lines);
      const log = readCallLog(path);
      expect(log.malformed).toBe(3);
      expect(log.entries).toHaveLength(4);
      expect(log.entries[3]!.record?.kind).toBe("run");
      expect(log.entries[0]!.record).toBeNull();
      expect(log.entries[1]!.record).toBeNull();
      expect(log.entries[2]!.record).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("corrupt lines are skipped and counted, never fatal", () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      const path = join(dir, "calls.jsonl");
      const withPath = { ...env, [CALL_LOG_ENV]: path };
      appendCallRecord(BASE_RECORD, withPath);
      appendCallRecord({ ...BASE_RECORD, agent: "zai" }, withPath);
      const good = readFileSync(path, "utf8");
      writeFileSync(path, `not json\n${good}{bad json\n`);
      const log = readCallLog(path);
      expect(log.malformed).toBe(2);
      // Entries carry every line, parsed or not: the two corrupt lines
      // ride along with record null, skipped — never fatal.
      expect(log.entries).toHaveLength(4);
      expect(log.entries[0]!.line).toBe("not json");
      expect(log.entries[0]!.record).toBeNull();
      expect(log.entries[1]!.record?.agent).toBe("claude");
      expect(log.entries[2]!.record?.agent).toBe("zai");
      expect(log.entries[3]!.line).toBe("{bad json");
      expect(log.entries[3]!.record).toBeNull();
      expect(log.truncated).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("invalid UTF-8 never throws: the broken line lands in malformed (ul5)", () => {
    // The ul5 contracts defect: the docstring claimed a throw on invalid
    // UTF-8, but the decode is non-fatal — the bytes become replacement
    // characters and the line is malformed like any corrupt one. The
    // comment states that now, and this pins the behavior it states.
    const { dir, cleanup } = tempEnv();
    try {
      const path = join(dir, "calls.jsonl");
      writeFileSync(
        path,
        Buffer.concat([
          Buffer.from("clau"),
          Buffer.from([0xff, 0xfe]), // invalid UTF-8 mid-line
          Buffer.from("der\n"),
        ])
      );
      let log: ReturnType<typeof readCallLog> | undefined;
      expect(() => {
        log = readCallLog(path);
      }).not.toThrow();
      expect(log!.malformed).toBe(1);
      expect(log!.entries).toHaveLength(1);
      expect(log!.entries[0]!.record).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("a file larger than 16 MiB reads only its bounded tail", () => {
    const { dir, cleanup } = tempEnv();
    try {
      const path = join(dir, "calls.jsonl");
      const filler = "x".repeat(1024);
      const chunk = `${JSON.stringify({ ...BASE_RECORD, model: filler })}\n`;
      const chunkCount = Math.floor((MAX_CALL_LOG_BYTES + 1024 * 1024) / chunk.length) + 1;
      const handle = Bun.file(path).writer();
      for (let i = 0; i < chunkCount; i++) {
        handle.write(chunk);
      }
      // The newest record is identifiable: appended after the filler.
      handle.write(`${JSON.stringify({ ...BASE_RECORD, agent: "aider" })}\n`);
      handle.end();
      const log = readCallLog(path);
      expect(log.truncated).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(MAX_CALL_LOG_BYTES);
      // The first entry starts at a line boundary (the partial line the
      // bounded read cut was dropped), and the newest record survived.
      expect(() => JSON.parse(log.entries[0]!.line)).not.toThrow();
      const last = log.entries[log.entries.length - 1]!;
      expect(last.record?.agent).toBe("aider");
    } finally {
      cleanup();
    }
  });

  test("a cut landing exactly on a record boundary keeps the complete record there (ul6)", () => {
    // The regression: the tail read always dropped through the first
    // newline, so a window whose cut fell exactly BETWEEN two records
    // (the byte before the cut a newline) discarded one complete record
    // with the partial one it never was. Built so the window is exactly
    // 4096 records of 4096 bytes behind 8192 bytes of junk: the cut lands
    // on the first record's leading byte.
    const { dir, cleanup } = tempEnv();
    try {
      const path = join(dir, "calls.jsonl");
      const recordSize = 4096;
      const count = MAX_CALL_LOG_BYTES / recordSize; // 4096 exact records
      // The model field pads the line to exactly recordSize bytes.
      const bare = `${JSON.stringify({ ...BASE_RECORD, model: "" })}\n`;
      const model = "m".repeat(recordSize - bare.length);
      const chunk = `${JSON.stringify({ ...BASE_RECORD, model })}\n`;
      expect(Buffer.byteLength(chunk)).toBe(recordSize);
      const junkSize = 8192;
      const handle = Bun.file(path).writer();
      // Junk ends with a newline, so the byte before the cut is one and
      // the window begins with a complete record.
      handle.write(`${"j".repeat(junkSize - 1)}\n`);
      for (let i = 0; i < count; i++) {
        handle.write(chunk);
      }
      handle.end();
      expect(statSync(path).size).toBe(junkSize + MAX_CALL_LOG_BYTES);
      const log = readCallLog(path);
      expect(log.truncated).toBe(true);
      expect(log.malformed).toBe(0);
      // Every record survived — none dropped for the bound.
      expect(log.entries).toHaveLength(count);
      expect(log.entries[0]!.record?.model).toBe(model);
      expect(log.entries[count - 1]!.record?.model).toBe(model);
    } finally {
      cleanup();
    }
  });

  test("a cut landing inside a line still drops the partial line (ul6)", () => {
    // The boundary rule's other half: junk with no trailing newline merges
    // with the first record into one line that starts before the window,
    // so that line was cut by the read and is dropped as before. The
    // records whose lines begin inside the window all survive.
    const { dir, cleanup } = tempEnv();
    try {
      const path = join(dir, "calls.jsonl");
      const recordSize = 4096;
      const count = MAX_CALL_LOG_BYTES / recordSize;
      const bare = `${JSON.stringify({ ...BASE_RECORD, model: "" })}\n`;
      const model = "m".repeat(recordSize - bare.length);
      const chunk = `${JSON.stringify({ ...BASE_RECORD, model })}\n`;
      const junkSize = 8192;
      const handle = Bun.file(path).writer();
      // No trailing newline: the first record's line begins with the junk,
      // before the cut, and the window sees only its tail.
      handle.write("j".repeat(junkSize));
      for (let i = 0; i < count; i++) {
        handle.write(chunk);
      }
      handle.end();
      expect(statSync(path).size).toBe(junkSize + MAX_CALL_LOG_BYTES);
      const log = readCallLog(path);
      expect(log.truncated).toBe(true);
      expect(log.malformed).toBe(0);
      // The merged junk+first-record line is the partial one dropped;
      // every later record survived whole.
      expect(log.entries).toHaveLength(count - 1);
    } finally {
      cleanup();
    }
  });
});
