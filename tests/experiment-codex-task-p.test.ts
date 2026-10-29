import { describe, expect, test } from "bun:test";
import { CodexRolloutParser } from "../src/experiment-codex-parser.js";
import type { JsonObject } from "../src/experiment-server.js";
import { parseCodexEventStream } from "../src/result-envelope/codex-stream.js";

const TIME = "2026-10-29T00:00:00Z";
const RETRY_TIME = "2026-10-29T00:00:01Z";
const USAGE = { input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 4,
  output_tokens: 2, reasoning_output_tokens: 1, total_tokens: 12 };

function line(type: string, payload: JsonObject, timestamp = TIME): JsonObject {
  return { timestamp, type, payload };
}
function message(id: string): JsonObject {
  return line("response_item", { type: "message", role: "assistant", id, content: [] });
}
function response(id: string, usage: JsonObject = USAGE): JsonObject {
  return line("token_usage_record", { thread_id: "thread", response_id: id, usage });
}
function count(usage: JsonObject = USAGE, timestamp = TIME): JsonObject {
  return line("event_msg", { type: "token_count", info: { last_token_usage: usage },
    rate_limits: { limit_id: "codex" } }, timestamp);
}
function fixture() {
  const records: JsonObject[] = [];
  const parser = new CodexRolloutParser("thread", "experiment", () => new Set(["lookup"]),
    (kind, fields) => records.push({ kind, ...fields }), () => []);
  return { parser, records };
}
function accept(parser: CodexRolloutParser, entries: JsonObject[]): void {
  for (const entry of entries) parser.accept(entry);
}
function completed(id: string, usage: JsonObject = USAGE): JsonObject[] {
  return [message(`message-${id}`), response(id, usage), count(usage)];
}

describe("Codex recoverable usage snapshots", () => {
  test("records an exact completed-response snapshot as retry evidence without another turn", () => {
    const { parser, records } = fixture();
    const retry = count({ ...USAGE }, RETRY_TIME);
    accept(parser, [...completed("response-A"), retry, retry]);
    parser.finish();
    expect(records.filter((record) => record.kind === "turn")).toHaveLength(1);
    expect(records.filter((record) => record.kind === "turn_usage")).toHaveLength(1);
    expect(records.filter((record) => record.kind === "harness_retry")).toEqual([0, 1].map(() => ({
      kind: "harness_retry", response_id: "response-A", t: Date.parse(RETRY_TIME) / 1000, item: retry.payload,
    })));
  });

  test("allows the next distinct response after a repeated snapshot and attributes the latest response", () => {
    const { parser, records } = fixture();
    const next = { ...USAGE, output_tokens: 5, total_tokens: 15 };
    accept(parser, [...completed("response-A"), count(), ...completed("response-B", next), count(next)]);
    parser.finish();
    expect(records.filter((record) => record.kind === "turn_usage").map((record) => record.usage.output))
      .toEqual([2, 5]);
    expect(records.filter((record) => record.kind === "harness_retry").map((record) => record.response_id))
      .toEqual(["response-A", "response-B"]);
  });

  test.each(Object.keys(USAGE))("rejects a repeated snapshot with changed native %s", (field) => {
    const { parser, records } = fixture();
    accept(parser, completed("response-A"));
    let failure: unknown;
    try { parser.accept(count({ ...USAGE, [field]: USAGE[field as keyof typeof USAGE] + 1 })); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "harness_log_missing" });
    expect(records.filter((record) => record.kind === "harness_retry")).toHaveLength(0);
  });

  test("rejects an earlier response snapshot after a newer response completed", () => {
    const { parser } = fixture();
    accept(parser, [...completed("response-A"), ...completed("response-B", { ...USAGE, output_tokens: 5 })]);
    expect(() => parser.accept(count())).toThrow("token_count");
  });

  test.each([false, true])("requires a completed response identity before retry acceptance; legacy=%s", (legacy) => {
    const { parser } = fixture();
    if (legacy) accept(parser, [message("legacy"), count()]);
    let failure: unknown;
    try { parser.accept(count()); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "harness_log_missing" });
  });
});

describe("Codex experiment uncached input", () => {
  test.each([
    { read: 0, write: 4, input: 6 },
    { read: 3, write: 4, input: 3 },
    { read: 4, write: 8, input: 0 },
    { read: 4, write: undefined, input: 6 },
  ])("subtracts both cache components consistently with result accounting: %j", ({ read, write, input }) => {
    const usage = { ...USAGE, cached_input_tokens: read, cache_write_input_tokens: write };
    const { parser, records } = fixture();
    accept(parser, completed("response-A", usage));
    parser.finish();
    const normalized = records.find((record) => record.kind === "turn_usage")!.usage;
    expect(normalized).toEqual({ input, output: 2, cache_read: read, cache_write: write ?? 0 });
    const stream = parseCodexEventStream([
      { type: "thread.started", thread_id: "thread" }, { type: "turn.started" },
      { type: "turn.completed", usage: { ...usage, cache_write_input_tokens: write ?? 0 } },
    ].map((entry) => JSON.stringify(entry)).join("\n"))!;
    expect(normalized.input).toBe(stream.usage.input_tokens);
    expect(normalized.cache_read + normalized.cache_write).toBe(stream.usage.cached_input_tokens);
    expect(normalized.input + normalized.output + normalized.cache_read + normalized.cache_write)
      .toBe(stream.usage.total_tokens);
  });
});
