import { describe, expect, test } from "bun:test";
import { installPiBudgetExtension, piBudgetUsage, type PiBudgetApi } from "../src/pi-budget-extension.js";

function usage(cost: number) {
  return { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
    cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost } };
}
function harness(limit = 1) {
  const handlers = new Map<string, Parameters<PiBudgetApi["on"]>[1]>();
  const records: { kind: string; [key: string]: unknown }[] = [];
  let aborts = 0;
  const context = { model: { id: "priced", provider: "native", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    abort: () => { aborts += 1; } };
  installPiBudgetExtension({ on: (name, handler) => { handlers.set(name, handler); } },
    { limit, record: (kind, fields) => { records.push({ kind, ...fields }); } });
  return { context, records, aborts: () => aborts,
    emit: (name: string, event: unknown = {}) => handlers.get(name)!(event, context) };
}

describe("Pi native soft USD cap", () => {
  test("assistant responses and a retry are charged once per completed request", () => {
    const h = harness();
    h.emit("before_agent_start"); h.emit("turn_start"); h.emit("before_provider_request");
    h.emit("message_end", { message: { role: "user" } });
    const message = { role: "assistant", usage: usage(0.2), timestamp: 1 };
    h.emit("message_end", { message }); h.emit("message_end", { message });
    h.emit("message_end", { message: { ...message, stopReason: "error", usage: usage(0.3) } });
    h.emit("agent_settled");
    expect(h.aborts()).toBe(0);
    expect(h.records.filter((r) => r.kind === "charge")).toHaveLength(2);
    expect(h.records.at(-1)).toEqual({ kind: "settled", total: 0.5, charges: 2, status: "active" });
  });
  test("threshold evidence precedes abort and later continuation cannot spend", () => {
    const h = harness();
    let persisted = false;
    h.context.abort = () => { persisted = h.records.some((r) => r.kind === "charge" && r.status === "exhausted"); };
    h.emit("message_end", { message: { role: "assistant", usage: usage(1) } });
    expect(persisted).toBe(true);
    h.emit("before_agent_start"); h.emit("turn_start"); h.emit("before_provider_request");
    expect(h.emit("session_before_compact")).toEqual({ cancel: true });
    expect(h.emit("tool_call")).toMatchObject({ block: true });
    h.emit("agent_settled");
    expect(h.records.at(-1)).toEqual({ kind: "settled", total: 1, charges: 1, status: "exhausted" });
    expect(h.records.filter((r) => r.kind === "blocked")).toHaveLength(5);
  });
  test("an unexpected compaction charge is recorded once and fails closed", () => {
    const h = harness();
    h.emit("message_end", { message: { role: "assistant", usage: usage(0.2) } });
    const compact = { compactionEntry: { id: "compact-1", usage: usage(0.9) } };
    h.emit("session_compact", compact); h.emit("session_compact", compact);
    h.emit("agent_settled");
    expect(h.records.at(-1)).toEqual({ kind: "settled", total: 1.1, charges: 2, status: "failed" });
    expect(h.records.filter((r) => r.kind === "charge")).toHaveLength(2);
    expect(h.aborts()).toBe(2);
  });
  test("native compaction and branch summaries are cancelled before hidden retries", () => {
    const compact = harness();
    expect(compact.emit("session_before_compact")).toEqual({ cancel: true });
    expect(compact.records.at(-1)).toMatchObject({ kind: "failure", message: expect.stringContaining("summary retries") });
    expect(compact.aborts()).toBe(1);
    compact.emit("before_provider_request");
    expect(compact.records.filter((record) => record.kind === "request")).toHaveLength(0);
    const branch = harness();
    expect(branch.emit("session_before_tree", { preparation: { userWantsSummary: false } })).toBeUndefined();
    expect(branch.emit("session_before_tree", { preparation: { userWantsSummary: true } })).toEqual({ cancel: true });
    expect(branch.aborts()).toBe(1);
    expect(branch.emit("session_before_tree")).toEqual({ cancel: true });
  });
  test("a post-threshold charge is an accounting failure", () => {
    const h = harness();
    h.emit("message_end", { message: { role: "assistant", usage: usage(1.1) } });
    h.emit("message_end", { message: { role: "assistant", usage: usage(0.2) } });
    expect(h.records.at(-1)).toMatchObject({ kind: "failure", message: expect.stringContaining("another charge") });
    expect(h.aborts()).toBe(2);
  });
  test("missing or zero usage fails before abort instead of becoming free spend", () => {
    for (const value of [undefined, usage(0), { ...usage(0.2), output: -1 }, { ...usage(0.2), totalTokens: Infinity }]) {
      const h = harness();
      h.emit("message_end", { message: { role: "assistant", usage: value } });
      expect(h.records.at(-1)).toMatchObject({ kind: "failure" });
      expect(h.aborts()).toBe(1);
    }
    expect(() => piBudgetUsage({ ...usage(0.2), cost: { ...usage(0.2).cost, total: 0.3 } })).toThrow("disagree");
  });
  test("unpriced models and malformed rates fail before a provider request", () => {
    for (const cost of [undefined, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      { input: 1, output: NaN, cacheRead: 0, cacheWrite: 0 }]) {
      const h = harness();
      h.context.model.cost = cost as typeof h.context.model.cost;
      h.emit("before_provider_request");
      expect(h.records.at(-1)).toMatchObject({ kind: "failure", message: expect.stringContaining("pricing") });
      expect(h.aborts()).toBe(1);
    }
  });
  test("unpriced compaction and tool calls return native cancellation results", () => {
    for (const event of ["session_before_compact", "tool_call"]) {
      const h = harness(); h.context.model.cost.input = 0; h.context.model.cost.output = 0;
      expect(h.emit(event)).toMatchObject(event === "tool_call" ? { block: true } : { cancel: true });
      expect(h.aborts()).toBe(1);
    }
  });
  test("missing compaction identity or usage fails closed", () => {
    for (const compactionEntry of [{ usage: usage(0.2) }, { id: "c" }]) {
      const h = harness(); h.emit("session_compact", { compactionEntry });
      expect(h.records.at(-1)).toMatchObject({ kind: "failure" });
      expect(h.aborts()).toBe(1);
    }
  });
  test("evidence-write errors still abort even if the native runner catches them", () => {
    const handlers = new Map<string, Parameters<PiBudgetApi["on"]>[1]>();
    let writes = 0;
    let aborts = 0;
    installPiBudgetExtension({ on: (name, handler) => { handlers.set(name, handler); } }, {
      limit: 1, record: () => { if (++writes > 1) throw new Error("disk refused"); },
    });
    expect(() => handlers.get("message_end")!({ message: { role: "assistant", usage: usage(1) } },
      { abort: () => { aborts += 1; } })).not.toThrow();
    expect(aborts).toBe(1);
  });
  test("recording and abort failures cannot discard native cancellation or tool blocking", () => {
    for (const event of ["session_before_compact", "session_before_tree", "tool_call"]) {
      const handlers = new Map<string, Parameters<PiBudgetApi["on"]>[1]>();
      const requests: unknown[] = [];
      let aborts = 0;
      installPiBudgetExtension({ on: (name, handler) => { handlers.set(name, handler); } }, {
        limit: 1, record: (kind, fields) => {
          if (kind === "request") requests.push(fields);
          if (kind !== "installed") throw new Error("evidence disk is full");
        },
      });
      const context = { model: event === "tool_call" ? undefined : {
        id: "priced", provider: "native", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      }, abort: () => { aborts += 1; throw new Error("abort failed"); } };
      expect(handlers.get(event)!({ preparation: { userWantsSummary: true } }, context))
        .toMatchObject(event === "tool_call" ? { block: true } : { cancel: true });
      expect(aborts).toBe(1);
      expect(() => handlers.get("before_provider_request")!({}, context)).not.toThrow();
      expect(requests).toEqual([]);
    }
  });
  test("invalid installation limits refuse synchronously", () => {
    expect(() => installPiBudgetExtension({ on() {} }, { limit: 0, record() {} })).toThrow("Invalid");
  });
});
