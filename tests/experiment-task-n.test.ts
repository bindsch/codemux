import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ExperimentInventory } from "../src/experiment-inventory.js";
import { ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { cleanupPeers, peer } from "./helpers/experiment-peer.js";

afterEach(cleanupPeers);

test("Z.AI fixture records its first response's real stream usage instead of assistant placeholders", async () => {
  const frames = readFileSync(resolve("tests/fixtures/live/zai-session-a.ndjson"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line)).filter((entry) => entry.dir === "out").map((entry) => JSON.parse(entry.line));
  const delta = frames.findIndex((frame) => frame.event?.usage?.input_tokens === 25266);
  const assistant = frames.slice(0, delta).findLast((frame) => frame.type === "assistant");
  const start = frames.findIndex((frame) => frame.event?.message?.id === assistant.message.id);
  const end = frames.findIndex((frame, index) => index > delta && frame.type === "result");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(delta);
  const p = peer();
  await p.ready();
  for (const frame of frames.slice(start, end + 1)) {
    p.push(frame);
    if (frame.event?.type === "message_stop") {
      expect(p.records().filter((record) => record.kind === "turn_usage")).toHaveLength(1);
    }
  }
  expect(p.bridge.finish()).toContain('"type":"result"');
  expect(p.records().find((record) => record.kind === "turn")).toMatchObject({
    message_id: assistant.message.id, usage: null,
  });
  expect(p.records().filter((record) => record.kind === "turn_usage")).toMatchObject([{
    message_id: assistant.message.id, usage: { input: 25266, output: 3, cache_read: 0, cache_write: 0 },
  }]);
});

test("Z.AI fixture without partial stream events fails instead of recording zero usage", async () => {
  const frames = readFileSync(resolve("tests/fixtures/live/zai-session-a.ndjson"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line)).filter((entry) => entry.dir === "out").map((entry) => JSON.parse(entry.line));
  const p = peer();
  await p.ready();
  const assistant = frames.find((frame) => frame.type === "assistant");
  const result = frames.find((frame) => frame.type === "result");
  p.push(assistant);
  expect(() => p.push(result)).toThrow(expect.objectContaining({ code: Code.HarnessLogMissing }));
  expect(p.records().filter((record) => record.kind === "turn_usage")).toHaveLength(0);
});

test("Claude completes each usage record on ID change or result without using cumulative result usage", async () => {
  const p = peer();
  await p.ready();
  const assistant = (id: string, usage: object) => p.push({ type: "assistant", message: {
    id, role: "assistant", content: [], usage,
  } });
  assistant("first", { input_tokens: 0, output_tokens: 0 });
  expect(p.records().filter((record) => record.kind === "turn_usage")).toHaveLength(0);
  assistant("first", { input_tokens: 174, output_tokens: 9, cache_read_input_tokens: 25344 });
  assistant("second", { input_tokens: 7, output_tokens: 1 });
  expect(p.records().filter((record) => record.kind === "turn_usage")).toMatchObject([{
    message_id: "first", usage: { input: 174, output: 9, cache_read: 25344, cache_write: 0 },
  }]);
  assistant("second", { output_tokens: 3 });
  p.push({ type: "result", result: "OK", usage: { input_tokens: 999, output_tokens: 999 } });
  expect(p.bridge.finish()).toContain('"result":"OK"');
  expect(p.records().filter((record) => record.kind === "turn_usage")).toMatchObject([
    { message_id: "first", usage: { input: 174, output: 9, cache_read: 25344, cache_write: 0 } },
    { message_id: "second", usage: { input: 7, output: 3, cache_read: 0, cache_write: 0 } },
  ]);
});

test("Claude retains stream usage received before an assistant placeholder snapshot", async () => {
  const p = peer();
  await p.ready();
  p.push({ type: "stream_event", event: { type: "message_start", message: {
    id: "early-stream", usage: { input_tokens: 0, output_tokens: 0 },
  } } });
  p.push({ type: "stream_event", event: { type: "message_delta", usage: {
    input_tokens: 174, output_tokens: 9, cache_read_input_tokens: 25344,
  } } });
  p.push({ type: "assistant", message: { id: "early-stream", role: "assistant", content: [],
    usage: { input_tokens: 0, output_tokens: 0 } } });
  p.result();
  expect(p.bridge.finish()).toContain('"result":"OK"');
  expect(p.records().find((record) => record.kind === "turn")).toMatchObject({ usage: null });
  expect(p.records().filter((record) => record.kind === "turn_usage")).toMatchObject([{
    message_id: "early-stream", usage: { input: 174, output: 9, cache_read: 25344, cache_write: 0 },
  }]);
});

test("a delta after its stream's message_stop is evidence, never the turn's usage (review round 69)", async () => {
  const p = peer();
  await p.ready();
  // One complete stream, then a delta with no new message_start: the
  // stale stream id used to correlate it and merge it into the counters.
  p.push({ type: "stream_event", event: { type: "message_start", message: { id: "done-stream",
    usage: { input_tokens: 10, output_tokens: 1 } } } });
  p.push({ type: "stream_event", event: { type: "message_stop" } });
  p.push({ type: "assistant", message: { id: "done-stream", role: "assistant", content: [],
    usage: { input_tokens: 10, output_tokens: 5 } } });
  p.push({ type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 999, output_tokens: 999 } } });
  expect(p.records().filter((record) => record.kind === "uncorrelated_delta")).toMatchObject([{
    usage: { input_tokens: 999, output_tokens: 999 },
  }]);
  p.push({ type: "stream_event", event: { type: "message_stop" } });
  expect(p.records().filter((record) => record.kind === "turn_usage")).toMatchObject([{
    message_id: "done-stream", usage: { input: 10, output: 5, cache_read: 0, cache_write: 0 },
  }]);
  p.result();
  expect(p.bridge.finish()).toContain('"result":"OK"');
});

test("an out-of-order delta with no stream start is evidence, never the turn's usage (review round 64)", async () => {
  const p = peer();
  await p.ready();
  p.push({ type: "assistant", message: { id: "live-turn", role: "assistant", content: [],
    usage: { input_tokens: 10, output_tokens: 5 } } });
  // A message_delta whose message_start never arrived: with no stream id
  // to correlate it, the old code merged it into the open turn and the
  // following message_stop finalized that turn with another message's
  // counters. It is now kept as raw evidence (an uncorrelated_delta
  // note) and the turn keeps its own snapshot's usage.
  p.push({ type: "stream_event", event: { type: "message_delta", usage: {
    input_tokens: 999, output_tokens: 999,
  } } });
  expect(p.records().filter((record) => record.kind === "uncorrelated_delta")).toMatchObject([{
    usage: { input_tokens: 999, output_tokens: 999 },
  }]);
  p.push({ type: "stream_event", event: { type: "message_stop" } });
  expect(p.records().filter((record) => record.kind === "turn_usage")).toMatchObject([{
    message_id: "live-turn", usage: { input: 10, output: 5, cache_read: 0, cache_write: 0 },
  }]);
  p.result();
  expect(p.bridge.finish()).toContain('"result":"OK"');
});

test.each(["initial", "recheck", "later-recheck"])("inventory stops after an awaited page becomes inactive: %s", async (phase) => {
  let active = true;
  let requests = 0;
  const failures: Error[] = [];
  const inventory = new ExperimentInventory("experiment", async (message) => {
    requests++;
    if (phase === "later-recheck" && requests === 1) {
      return { id: message.id, result: { tools: [{ name: "lookup" }], nextCursor: "page-2" } };
    }
    active = false;
    return { id: message.id, result: { tools: [], nextCursor: requests === 1 ? "page-2" : undefined } };
  }, () => {}, (error) => failures.push(error), () => active);
  await inventory.accept({ result: { tools: [{ name: "lookup" }],
    ...(phase === "initial" ? { nextCursor: "page-1" } : {}) } }, null);
  if (phase !== "initial") { inventory.changed(); await inventory.rechecking; }
  expect(requests).toBe(phase === "later-recheck" ? 2 : 1);
  expect(failures).toEqual([]);
});

test.each(["initial", "recheck"])("inventory ignores an absent reply after shutdown: %s", async (phase) => {
  let active = true;
  const failures: Error[] = [];
  const inventory = new ExperimentInventory("experiment", async () => {
    active = false;
    return undefined;
  }, () => {}, (error) => failures.push(error), () => active);
  await inventory.accept({ result: { tools: [{ name: "lookup" }],
    ...(phase === "initial" ? { nextCursor: "page-1" } : {}) } }, null);
  if (phase === "recheck") { inventory.changed(); await inventory.rechecking; }
  expect(failures).toEqual([]);
});

test("catalog request documentation includes the complete-body flag", () => {
  const text = readFileSync(resolve("docs/results-and-usage.md"), "utf8");
  const catalog = text.slice(text.indexOf("Catalog `http_request`"), text.indexOf("Missing explicit `-m`"));
  expect(catalog).toContain("`body_complete: true`");
});

test("usage documentation and Unreleased notes require finalized Claude counters", () => {
  const results = readFileSync(resolve("docs/results-and-usage.md"), "utf8");
  expect(results).toContain("first assistant frame emits `turn` with null usage");
  expect(results).toContain("`turn_usage` records the final values");
  expect(results).toContain("completed turn without real counters fails with `harness_log_missing`");
  const notes = readFileSync(resolve("CHANGELOG.md"), "utf8").split("## [0.15.1]")[0]!;
  expect(notes).not.toContain("Claude emits first-frame usage immediately");
});

test("missing identity documentation describes every harness", () => {
  const row = readFileSync(resolve("docs/experiment-mcp.md"), "utf8").split("\n")
    .find((line) => line.startsWith("| `message_id_missing`"));
  for (const name of ["Claude", "Z.AI", "Codex", "Kimi"]) expect(row).toContain(name);
});
