import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCallLog, streamCallLog } from "../src/call-log.js";
import { BASE_RECORD } from "./helpers/call-log.js";

/** The review round 223 reader rule, as the file's own contract states it:
 * a ledger line whose bytes are not valid UTF-8 is malformed — counted and
 * skipped, never accepted. The reader decoded with a replacing decoder, so
 * an invalid byte inside a permissive string field (provider holds any
 * string) became U+FFFD while the line stayed valid JSON, passed the
 * record check, and reached the table and totals as content that is not
 * the bytes on disk. Both readers now decode each line with the same fatal
 * rule readUtf8FileBounded uses (file-io.ts). */
describe("ledger invalid UTF-8", () => {
  test("a byte-order mark keeps a line malformed, as the replacing decode read it (round 226)", () => {
    // TextDecoder strips a leading BOM unless told not to; a BOM-prefixed
    // record would then parse and count, which the writer never produces
    // and the old decode refused.
    const dir = mkdtempSync(join(tmpdir(), "codemux-call-bom-"));
    try {
      const path = join(dir, "calls.jsonl");
      const good = `${JSON.stringify(BASE_RECORD)}\n`;
      writeFileSync(path, Buffer.concat([Buffer.from(good), Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(good)]));
      const log = readCallLog(path);
      expect(log.malformed).toBe(1);
      expect(log.entries).toHaveLength(2);
      expect(log.entries[1]!.record).toBeNull();
      expect(log.entries[1]!.line.startsWith("\uFEFF")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a record whose provider carries an invalid byte is malformed, never accepted (round 223)", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-call-utf8-"));
    try {
      const path = join(dir, "calls.jsonl");
      // One byte no UTF-8 text holds, spliced into the provider string of
      // an otherwise well-shaped record: the replacing decode left the
      // line parseable and the record accepted.
      const full = JSON.stringify({ ...BASE_RECORD, provider: "apiEXAMPLE" });
      const marker = '"provider":"api';
      const at = full.indexOf(marker);
      expect(at).toBeGreaterThan(0);
      const broken = Buffer.concat([
        Buffer.from(full.slice(0, at + marker.length)),
        Buffer.from([0xff]),
        Buffer.from(full.slice(at + marker.length)),
      ]);
      const good = `${JSON.stringify(BASE_RECORD)}\n`;
      writeFileSync(path, Buffer.concat([
        Buffer.from(good),
        broken,
        Buffer.from("\n"),
        Buffer.from(good),
      ]));

      const log = readCallLog(path);
      expect(log.malformed).toBe(1);
      expect(log.entries).toHaveLength(3);
      expect(log.entries[0]!.record?.provider).toBe("default");
      // The broken line carries no record; its displayed text keeps the
      // replacing decode so `calls --json` still shows the line.
      expect(log.entries[1]!.record).toBeNull();
      expect(log.entries[1]!.line).toContain("api�EXAMPLE");
      expect(log.entries[2]!.record?.provider).toBe("default");

      const providers: (string | null)[] = [];
      const streamed = streamCallLog(path, (entry) => {
        providers.push(entry.record?.provider ?? null);
      });
      expect(streamed.malformed).toBe(1);
      expect(providers).toEqual(["default", null, "default"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
