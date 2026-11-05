/**
 * The ledger's `ts` rule (review round 151): the writer's only shape has
 * ever been `new Date(ms).toISOString()` (git log -S on src/call-log.ts:
 * both call sites landed together in the ledger's introducing commit), so
 * a `ts` that is not an RFC 3339 timestamp is a wrong-shaped line —
 * skipped and counted by both readers, never rendered. The one shared
 * rule is calendar.ts timestampValid, the same one the usage protocol's
 * timestamp fields use.
 */

import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCallLog, streamCallLog } from "../src/call-log.js";
import { BASE_RECORD, tempEnv } from "./helpers/call-log.js";
import { callsWith, iso, record } from "./helpers/calls-records.js";

test("a ts that is not an RFC 3339 timestamp is malformed in both readers (round 151)", () => {
  // The malformed shapes, named before the tightening: a string with a
  // newline and an escape sequence (one JSONL line, so the reader is the
  // only guard), a date-only string (Date.parse accepts it; it names no
  // time), and free text. The old check accepted all three because it
  // looked at the type alone, and the table printed them verbatim.
  const { dir, cleanup } = tempEnv();
  try {
    const path = join(dir, "calls.jsonl");
    writeFileSync(path, [
      JSON.stringify({ ...BASE_RECORD, ts: "forged\nrow\x1b[2J" }),
      JSON.stringify({ ...BASE_RECORD, ts: "2026-10-08" }),
      JSON.stringify({ ...BASE_RECORD, ts: "yesterday, roughly" }),
      JSON.stringify(BASE_RECORD),
    ].join("\n") + "\n");
    const read = readCallLog(path);
    expect(read.malformed).toBe(3);
    expect(read.entries.filter((entry) => entry.record !== null)).toHaveLength(1);
    const streamed = streamCallLog(path, () => {});
    expect(streamed.malformed).toBe(3);
  } finally {
    cleanup();
  }
});

test("every timestamp shape the rule accepts still reads (round 151)", () => {
  // The writer has only ever produced `.sssZ`; the shared RFC 3339 rule
  // accepts the shapes around it too — no fraction, and a numeric offset
  // (timestampMs parses one) — and each must keep reading.
  const { dir, cleanup } = tempEnv();
  try {
    const path = join(dir, "calls.jsonl");
    writeFileSync(path, [
      JSON.stringify(BASE_RECORD),
      JSON.stringify({ ...BASE_RECORD, ts: "2026-10-08T12:00:00.000Z" }),
      JSON.stringify({ ...BASE_RECORD, ts: "2026-10-08T12:00:00Z" }),
      JSON.stringify({ ...BASE_RECORD, ts: "2026-10-08T14:00:00+02:00" }),
    ].join("\n") + "\n");
    const read = readCallLog(path);
    expect(read.malformed).toBe(0);
    expect(read.entries).toHaveLength(4);
    expect(read.entries.every((entry) => entry.record !== null)).toBe(true);
  } finally {
    cleanup();
  }
});

test("the table prints no control byte a corrupted ts carried (round 151)", async () => {
  // A record whose ts holds a newline and an escape sequence used to
  // forge a table row and replay the escape into the terminal. The
  // reader now counts it malformed, so the table holds the valid record
  // alone and stdout carries no control byte.
  const dirty = JSON.stringify({ ...BASE_RECORD, ts: "forged\nrow\x1b[2J" });
  const { stdout, stderr, exitCode } = await callsWith([dirty, record({ ts: iso(0) })], []);
  expect(exitCode).toBe(0);
  expect(stdout).not.toContain("\x1b");
  const rows = stdout.split("\n").filter((line) => line !== "");
  expect(rows).toHaveLength(2); // the header plus the one valid record
  expect(stderr).toContain("skipped 1 unparseable line(s)");
});

test("a leap-second ts the reader accepts is rendered and placed in the --since window", async () => {
  // The reader's rule accepts a leap second that happened. The table and
  // the window parsed with Date, which rejects second 60: the record
  // printed a dash and fell out of every --since window. Both now parse
  // with the reader's own rule.
  const leap = JSON.stringify({ ...BASE_RECORD, ts: "2016-12-31T23:59:60Z" });
  const table = await callsWith([leap], []);
  expect(table.exitCode).toBe(0);
  const rows = table.stdout.split("\n").filter((line) => line !== "");
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatch(/^20(16-12-31|17-01-01) \d{2}:\d{2}:00\b/);
  const inside = await callsWith([leap], ["--since", "2016-12-31T23:59:59Z"]);
  expect(inside.stdout.split("\n").filter((line) => line !== "")).toHaveLength(2);
  const outside = await callsWith([leap], ["--since", "2017-01-01T00:00:01Z"]);
  expect(outside.stdout).not.toContain("2016-12-31");
  expect(outside.stdout).not.toMatch(/^2017-01-01/m);
});
