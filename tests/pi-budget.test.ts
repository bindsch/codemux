import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PiAdapter } from "../src/adapters/pi.js";
import { verifyPiBudget, type PiBudgetRunContext } from "../src/pi-budget.js";
import { installPiBudgetExtension, type PiBudgetApi } from "../src/pi-budget-extension.js";
import type { RunRequest } from "../src/types.js";

const MODEL = { id: "native-priced", provider: "synthetic", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
const usage = (cost: number) => ({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
  cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost } });
const message = (cost: number) => ({ role: "assistant", content: [{ type: "text", text: "answer" }],
  model: MODEL.id, provider: MODEL.provider, stopReason: "stop", usage: usage(cost) });
const raw = (stdout: string) => ({ stdout, stderr: "", exitCode: 0, success: true });
type Fixture = { adapter: PiAdapter; request: RunRequest; context: PiBudgetRunContext; home: string };
async function prepared(run: (fixture: Fixture) => void | Promise<void>, extra: Partial<RunRequest> = {}) {
  const parent = join(process.cwd(), "scratch", "fix", "pi-synthetic");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "budget-"));
  const adapter = new PiAdapter({ HOME: home }, home);
  const request: RunRequest = { agent: "pi", prompt: "p", cwd: home, maxBudgetUsd: 1, ...extra };
  const context = adapter.prepareRun(request);
  try { await run({ adapter, request, context, home }); }
  finally { await adapter.cleanupRun(context); rmSync(home, { recursive: true, force: true }); }
}
function recorder(context: PiBudgetRunContext) {
  const handlers = new Map<string, Parameters<PiBudgetApi["on"]>[1]>();
  const api: PiBudgetApi = { on: (event, handler) => { handlers.set(event, handler); } };
  const ctx = { model: MODEL, abort() {} };
  const artifact = context.piBudget!;
  installPiBudgetExtension(api, { limit: artifact.limit,
    record: (kind, fields) => appendFileSync(artifact.evidencePath, JSON.stringify({ kind, ...fields }) + "\n") });
  return { api, handlers, emit: (event: string, value: unknown = {}) => handlers.get(event)!(value, ctx) };
}
function completed(context: PiBudgetRunContext, cost = 0.2, compactCost?: number): string {
  const r = recorder(context);
  r.emit("before_provider_request");
  const assistant = message(cost);
  r.emit("message_end", { message: assistant });
  let stdout = JSON.stringify({ type: "message_end", message: assistant }) + "\n";
  if (compactCost !== undefined) {
    r.emit("session_compact", { compactionEntry: { id: "summary-1", usage: usage(compactCost) } });
    stdout += JSON.stringify({ type: "compaction_end", result: { usage: usage(compactCost) } }) + "\n";
  }
  r.emit("agent_settled");
  return stdout;
}

describe("Pi budget adapter integration", () => {
  test("explicit extension preserves ordinary tools and customization", async () => prepared(({ adapter, request, context }) => {
    const command = adapter.buildRunCommand(request, context);
    expect(adapter.capabilities().budgetLimit).toBe(true);
    expect(command).toEqual(["pi", "--print", "--no-session", "--no-approve", "--extension", context.piBudget!.path, "--mode", "json"]);
    expect(adapter.getRunEnv(request, context)).toEqual({});
    expect(existsSync(context.piBudget!.path)).toBe(true);
    expect(readFileSync(context.piBudget!.path, "utf8")).not.toContain("synthetic-key");
  }));
  test("hermetic tools-none runs still load the explicit extension", async () => prepared(({ adapter, request, context }) => {
    const command = adapter.buildRunCommand(request, context);
    expect(command).toContain("--extension"); expect(command).toContain("--no-extensions");
    expect(command).toContain("--no-tools"); expect(command).not.toContain("--tools");
    expect(command).toContain("--no-context-files");
    expect(adapter.getRunEnv(request, context).PI_CODING_AGENT_DIR).toBe(context.piProviderAgentDir!.path);
  }, { hermetic: true, tools: "none", autonomy: "read-only" }));
  test("ordinary requests create no budget artifact", async () => prepared(({ adapter, request, context }) => {
    expect(context.piBudget).toBeUndefined();
    expect(adapter.buildRunCommand(request, context)).not.toContain("--extension");
  }, { maxBudgetUsd: undefined }));
  test("unpriced provider overrides refuse before preparation", async () => prepared(({ home }) => {
    const adapter = new PiAdapter({ HOME: home, CODEMUX_PI_PROVIDER_BASE_URL: "https://synthetic.invalid/v1",
      CODEMUX_PI_PROVIDER_API_KEY: "synthetic-key", CODEMUX_PI_PROVIDER_MODEL: "unpriced" }, home);
    const request: RunRequest = { agent: "pi", prompt: "p", maxBudgetUsd: 1 };
    expect(() => adapter.validateRunRequest(request)).toThrow("no verified USD rates");
    expect(() => adapter.prepareRun(request)).toThrow("no verified USD rates");
  }));
  test("successful plain output and JSON both verify the native charges", async () => prepared(({ adapter, request, context }) => {
    const stdout = completed(context, 0.2);
    expect(verifyPiBudget(context.piBudget!, stdout)).toEqual({ total: 0.2, exhausted: false });
    const plain = adapter.processRunResult(raw(stdout), request, context);
    expect(plain.success).toBe(true); expect(plain.stdout).toBe("answer"); expect(plain.usage?.cost_usd).toBe(0.2);
    const json = adapter.processRunResult(raw(stdout), { ...request, resultJson: true }, context);
    expect(JSON.parse(json.stdout).codemux.usage.cost_usd).toBe(0.2);
  }));
  test("a compaction that bypassed cancellation fails result verification", async () => prepared(({ adapter, request, context }) => {
    const stdout = completed(context, 0.2, 0.3);
    const result = adapter.processRunResult(raw(stdout), request, context);
    expect(result.success).toBe(false); expect(result.stderr).toContain("bypassed");
  }));
  test("threshold becomes a failed result with the accounted overshoot", async () => prepared(({ adapter, request, context }) => {
    const stdout = completed(context, 1.2);
    const result = adapter.processRunResult(raw(stdout), { ...request, resultJson: true }, context);
    expect(result.success).toBe(false); expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("soft USD budget");
    expect(JSON.parse(result.stdout).codemux.failure_code).toBe("budget-limit");
    expect(result.usage?.cost_usd).toBe(1.2);
  }));
  test("missing evidence fails plain output and missing context fails JSON", async () => prepared(({ adapter, request, context }) => {
    const stdout = JSON.stringify({ type: "message_end", message: message(0.2) }) + "\n";
    const plain = adapter.processRunResult(raw(stdout), request, context);
    expect(plain.success).toBe(false); expect(plain.stderr).toContain("missing or truncated");
    const json = adapter.processRunResult(raw(stdout), { ...request, resultJson: true });
    expect(json.success).toBe(false);
    expect(JSON.parse(json.stdout).codemux.failure_code).toBe("budget-evidence-invalid");
  }));
  test("generated extension runs its tested guard and produces verifiable evidence", async () => prepared(async ({ context }) => {
    const handlers = new Map<string, Parameters<PiBudgetApi["on"]>[1]>();
    const module = await import(pathToFileURL(context.piBudget!.path).href);
    module.default({ on: (event: string, handler: Parameters<PiBudgetApi["on"]>[1]) => handlers.set(event, handler) });
    const ctx = { model: MODEL, abort() {} };
    handlers.get("before_provider_request")!({}, ctx);
    const assistant = message(0.25);
    handlers.get("message_end")!({ message: assistant }, ctx);
    handlers.get("agent_settled")!({}, ctx);
    expect(verifyPiBudget(context.piBudget!, JSON.stringify({ type: "message_end", message: assistant }) + "\n"))
      .toEqual({ total: 0.25, exhausted: false });
  }));
  test("cleanup removes only this run's budget artifacts", async () => prepared(({ adapter, request, context }) => {
    const second = adapter.prepareRun(request);
    try {
      adapter.cleanupRunSync(context);
      expect(existsSync(context.piBudget!.directory.path)).toBe(false);
      expect(existsSync(second.piBudget!.directory.path)).toBe(true);
    } finally { adapter.cleanupRunSync(second); }
  }));
});

describe("Pi budget evidence refusal", () => {
  test("malformed, missing, mismatched and post-settlement records refuse", async () => prepared(({ context }) => {
    const stdout = completed(context);
    const artifact = context.piBudget!;
    const records = readFileSync(artifact.evidencePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const cases = [
      "bad json\n", JSON.stringify({ kind: "installed", limit: 2 }) + "\n",
      records.slice(0, -1), [...records, { kind: "blocked" }],
      [records[0], { kind: "failure", message: "missing cost" }],
      [records[0], { kind: "unexpected" }],
      [records[0], { kind: "blocked" }],
      [records[0], { kind: "request", model: { ...MODEL, cost: {} } }],
      [records[0], records[1], { ...records[2], source: "unknown" }, records[3]],
      [records[0], records[1], { ...records[2], total: 2 }, records[3]],
      [records[0], records[1], records[2], { ...records[3], charges: 3 }],
      [records[0], records[2], records[3]],
      [records[0], records[1], records[1], records[2], records[3]],
    ];
    for (const value of cases) {
      writeFileSync(artifact.evidencePath, typeof value === "string" ? value : value.map((r) => JSON.stringify(r)).join("\n") + "\n");
      expect(() => verifyPiBudget(artifact, stdout)).toThrow();
    }
    writeFileSync(artifact.evidencePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    expect(() => verifyPiBudget(artifact, "")).toThrow("does not match");
    expect(() => verifyPiBudget(artifact, "not json\n")).toThrow();
  }));
  test("later provider requests or charges after exhaustion refuse", async () => prepared(({ context }) => {
    const stdout = completed(context, 1);
    const artifact = context.piBudget!;
    const records = readFileSync(artifact.evidencePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    for (const extra of [records[1], records[2]]) {
      writeFileSync(artifact.evidencePath, [...records.slice(0, -1), extra, records.at(-1)].map((r) => JSON.stringify(r)).join("\n") + "\n");
      expect(() => verifyPiBudget(artifact, stdout)).toThrow();
    }
  }));
  test("unusable native output cannot become a successful budget result", async () => prepared(({ adapter, request, context }) => {
    completed(context);
    const result = adapter.processRunResult(raw(""), request, context);
    expect(result.success).toBe(false); expect(result.exitCode).toBe(1);
  }));
});
