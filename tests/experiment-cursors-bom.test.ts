/** Review round 391, item 2: both append-only cursors hash what the final
 * consistency read compares. The final read decodes, and the UTF-8 decoder
 * strips a leading BOM, so hashing raw read bytes made a BOM-prefixed rollout
 * or wire log always fail its tamper check with a false "changed after live
 * records were emitted". Both sides now hash decoded text. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRolloutCursor } from "../src/experiment-codex-rollout.js";
import { KimiWireCursor } from "../src/experiment-kimi-wire.js";
import type { JsonObject } from "../src/experiment-server.js";

const BOM = "﻿";
const TIME = "2026-10-29T01:02:03.125Z";
const THREAD = "12345678-1234-4234-8234-123456789abc";

test("a BOM-prefixed Codex rollout passes its final tamper check (review round 391, item 2)", () => {
  const home = mkdtempSync(join(tmpdir(), "codemux-bom-rollout-"));
  const sessions = join(home, "sessions/2026/10/29");
  mkdirSync(sessions, { recursive: true });
  const rollout = join(sessions, `rollout-2026-10-29T01-02-03-${THREAD}.jsonl`);
  writeFileSync(rollout, BOM + [
    JSON.stringify({ timestamp: TIME, type: "session_meta", payload: { id: THREAD } }),
    JSON.stringify({ timestamp: TIME, type: "event_msg", payload: { type: "token_count", info: {} } }),
  ].join("\n") + "\n");
  try {
    const accepted: JsonObject[] = [];
    const cursor = new CodexRolloutCursor(home, THREAD, (line) => accepted.push(line));
    cursor.poll();
    expect(cursor.path).toBe(rollout);
    expect(accepted).toHaveLength(2);
    expect(cursor.finish()).toBe(rollout);
    expect(accepted).toHaveLength(2); // the final reread consumed nothing new
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a BOM-prefixed Kimi wire log passes its final tamper check (review round 391, item 2)", () => {
  const home = mkdtempSync(join(tmpdir(), "codemux-bom-wire-"));
  const main = join(home, "sessions/workspace-1/session_a/agents/main");
  mkdirSync(main, { recursive: true });
  const wire = join(main, "wire.jsonl");
  writeFileSync(wire, BOM + [
    JSON.stringify({ type: "session", id: "s1" }),
    JSON.stringify({ type: "agent", message: "x" }),
  ].join("\n") + "\n");
  try {
    const accepted: JsonObject[] = [];
    const cursor = new KimiWireCursor(home, (line) => accepted.push(line));
    cursor.poll();
    expect(cursor.path).toBe(wire);
    expect(accepted).toHaveLength(2);
    expect(cursor.finish()).toBe(wire);
    expect(accepted).toHaveLength(2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
