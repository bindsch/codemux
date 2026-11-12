import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GeminiExperimentRun, type GeminiExperimentRelay, type GeminiExperimentSpec } from "../src/gemini-experiment-run.js";
import { experimentFailure } from "../src/experiment-records.js";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import * as geminiSpecModule from "../src/experiment-mcp.js";
import { geminiExperimentDefinitions, geminiExperimentOutput } from "../src/gemini-experiment-content.js";
import { geminiEvents, geminiNativeId, geminiSource, geminiStdout, geminiTelemetry } from "./gemini-experiment-content.test.js";
import type { JsonObject } from "../src/experiment-server.js";

const geminiSpec: GeminiExperimentSpec = { name: "test", command: "/synthetic/fake-gemini-mcp", args: [], env: [],
  accept_harness_prefix: ["gemini-untrusted-context"], accept_harness_schema: ["gemini-wait-for-previous"] };
async function geminiRig(run: (h: ReturnType<typeof geminiSetup>) => unknown | Promise<unknown>): Promise<void> {
  const parent = join(process.cwd(), "scratch", "fix", "gemini-synthetic"); mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "experiment-"));
  mkdirSync(join(home, ".gemini")); writeFileSync(join(home, ".gemini", "settings.json"), '{"tools":{"exclude":["*"]}}');
  try { await run(geminiSetup(home)); } finally { rmSync(home, { recursive: true, force: true }); }
}
function geminiSetup(home: string) {
  let starts = 0, finishes = 0, closes = 0, syncCloses = 0, terms = 0, failure: ReturnType<typeof experimentFailure> | null = null;
  const listeners = new Set<() => void>(), source = geminiSource();
  const relay: GeminiExperimentRelay = { ...source, spec: geminiSpec, token: "synthetic-secret", url: "http://127.0.0.1:12345/mcp", recordingPath: join(home, "record.jsonl"),
    get failureError() { return failure; }, start: async () => { starts++; }, finish: () => { finishes++; },
    fail: (error) => { failure ??= experimentFailure(error); for (const listener of listeners) listener(); },
    onFailure: (listener) => { const fn = () => listener(failure!); listeners.add(fn); return () => { listeners.delete(fn); }; },
    terminateProtocol: () => { terms++; }, close: async () => { closes++; }, closeSync: () => { syncCloses++; } };
  const experiment = new GeminiExperimentRun(geminiSpec, home, home, {}, "literal prompt", relay);
  return { home, relay, experiment, records: source.records, state: () => ({ starts, finishes, closes, syncCloses, terms, listeners: listeners.size }),
    write: (records = geminiTelemetry()) => writeFileSync(experiment.evidencePath, records.map((r) => JSON.stringify(r, null, 2)).join("\n")) };
}

describe("Gemini experiment launch ownership", () => {
  test("a final relay failure cannot record verified delivery", async () => geminiRig(async (h) => {
    await h.experiment.prepare("0.60.0"); h.write(); h.experiment.push(geminiStdout()); h.experiment.finish();
    h.relay.finish = () => { throw new Error("late relay failure"); };
    await expect(h.experiment.complete()).rejects.toThrow("late relay failure");
    expect(h.records.filter((r) => r.kind === "model_tool_result" || r.kind === "result_comparison")).toEqual([]);
    await h.experiment.close();
  }));
  test("prepares local telemetry and authenticated MCP, matches delayed stdout, verifies and retains evidence", async () => geminiRig(async (h) => {
    await Promise.all([h.experiment.prepare("0.60.0"), h.experiment.prepare("0.60.0")]);
    expect(h.state().starts).toBe(1);
    const settings = readFileSync(join(h.home, ".gemini", "settings.json"), "utf8");
    expect(settings).toContain("CODEMUX_GEMINI_EXPERIMENT_TOKEN"); expect(settings).not.toContain("synthetic-secret");
    expect(JSON.parse(settings).tools).toEqual({ core: [] });
    expect(readFileSync(join(h.home, "codemux-policy.toml"), "utf8")).toContain('mcpName = "test"');
    expect(h.experiment.environment).toMatchObject({ GEMINI_TELEMETRY_TARGET: "local", GEMINI_TELEMETRY_USE_COLLECTOR: "false", GEMINI_TELEMETRY_USE_CLI_AUTH: "false" });
    let text = "", ended = false;
    h.experiment.start((value) => { text += value; }, () => { ended = true; }, () => {});
    expect([text, ended]).toEqual(["literal prompt", true]);
    const pending = h.relay.resolveCallId!({ relay_index: 1, name: "echo", input: {} }, {});
    const stdout = geminiStdout(); h.experiment.push(stdout.slice(0, 20)); h.experiment.push(stdout.slice(20));
    expect(await pending).toBe(geminiNativeId);
    expect(h.relay.resolveCallId!({ relay_index: 2, name: "echo", input: {} }, {})).rejects.toThrow("already claimed");
    expect(h.experiment.hasOutput).toBe(true); expect(h.experiment.keptBytes()).toBe(Buffer.byteLength(stdout));
    expect(h.experiment.finish()).toBe(stdout); h.experiment.push("ignored");
    expect(h.experiment.capturedOutput).toBe(stdout); h.write();
    await Promise.all([h.experiment.complete(), h.experiment.complete()]);
    expect(h.state().finishes).toBe(1); expect(h.records.some((r) => r.kind === "gemini_evidence_copy")).toBe(true);
    expect(h.experiment.recordingPath).toEndWith("record.jsonl");
    await Promise.all([h.experiment.close(), h.experiment.close()]); h.experiment.closeSync();
    expect(h.state()).toMatchObject({ closes: 1, syncCloses: 1, listeners: 0 });
  }));
  test.each(["ambiguous", "missing", "duplicate", "malformed", "oversized", "interrupt", "relay-failure"])("fails closed on %s native identity", async (kind) => geminiRig(async (h) => {
    let aborted = false; h.experiment.start(() => {}, () => {}, () => { aborted = true; });
    const call = { relay_index: 1, name: "echo", input: {} };
    if (kind === "ambiguous") h.experiment.push(geminiStdout([geminiEvents()[1]!, { ...geminiEvents()[1], tool_id: "other" }]));
    if (kind === "duplicate") h.experiment.push(geminiStdout([geminiEvents()[1]!, geminiEvents()[1]!]));
    if (kind === "malformed") h.experiment.push("broken\n");
    if (kind === "oversized") h.experiment.push("x".repeat(32 * 1024 * 1024));
    if (kind === "interrupt") h.experiment.terminateProtocol();
    if (kind === "relay-failure") h.relay.fail(new Error("synthetic failure"));
    if (kind === "missing") { const pending = h.relay.resolveCallId!(call, {}); h.experiment.finish(); await expect(pending).rejects.toThrow("identity"); }
    else await expect(h.relay.resolveCallId!(call, {})).rejects.toThrow();
    if (["duplicate", "malformed", "oversized", "relay-failure"].includes(kind)) expect(aborted).toBe(true);
    h.experiment.closeSync();
  }));
  test.each(["timeout", "abort", "truncated", "missing", "changed", "unknown-version", "start-failure"])("retains %s verification failure", async (kind) => geminiRig(async (h) => {
    if (kind === "unknown-version") await expect(h.experiment.prepare("0.61.0")).rejects.toThrow("pinned");
    else if (kind === "start-failure") { h.relay.start = async () => { throw new Error("startup failure"); }; await expect(h.experiment.prepare("0.60.0")).rejects.toThrow("startup"); }
    else if (kind !== "missing") {
      await h.experiment.prepare("0.60.0"); h.write(); h.experiment.push(geminiStdout());
      if (kind === "truncated") writeFileSync(h.experiment.evidencePath, "{");
      if (kind === "changed") { const records = geminiTelemetry(); records[1]!.attributes["gen_ai.tool.definitions"] = "[]"; h.write(records); }
      h.experiment.finish({ timedOut: false, aborted: kind === "abort" });
    }
    await expect(h.experiment.complete({ timedOut: kind === "timeout" })).rejects.toThrow();
    let aborted = false; h.experiment.start(() => { throw new Error("must not write"); }, () => {}, () => { aborted = true; }); expect(aborted).toBe(true);
    await h.experiment.close();
  }));
  test("requires separate result-wrapper and schema-transform opt-ins", () => {
    expect(() => new GeminiExperimentRun({ ...geminiSpec, accept_harness_prefix: [] }, ".", ".", {}, "")).toThrow("untrusted-context");
    expect(() => new GeminiExperimentRun({ ...geminiSpec, accept_harness_schema: [] }, ".", ".", {}, "")).toThrow("schema acceptance");
  });
  test("bounds unresolved native identities and releases them on shutdown", async () => geminiRig(async (h) => {
    const pending = Array.from({ length: 64 }, (_, i) => h.relay.resolveCallId!({ relay_index: i, name: "echo", input: { i } }, {}).catch((error) => error));
    await expect(h.relay.resolveCallId!({ relay_index: 65, name: "echo", input: {} }, {})).rejects.toThrow("exceed 64");
    h.experiment.closeProtocol();
    expect((await Promise.all(pending)).every((value) => value instanceof Error)).toBe(true);
  }));
  test("adapter builds a private native stream and envelope with recording, then cleans up", async () => geminiRig(async (h) => {
    const adapter = new GeminiAdapter({ HOME: h.home });
    const request = { agent: "gemini" as const, prompt: "p", cwd: h.home, experimentMcp: "synthetic.json", hermetic: true, tools: "none" as const, autonomy: "read-only" as const };
    const context = { experimentGemini: h.experiment, experimentRecording: h.experiment.recordingPath, geminiHermeticHome: { home: h.home, geminiDir: join(h.home, ".gemini"), finalize: () => {} } };
    expect(adapter.buildRunCommand(request, context)).toContain("stream-json");
    expect(adapter.buildRunCommand(request, context)).toContain("--policy");
    expect(() => adapter.buildRunCommand(request)).toThrow("not prepared");
    expect(adapter.getRunEnv(request, context).CODEMUX_GEMINI_EXPERIMENT_TOKEN).toBe("synthetic-secret");
    const raw = { stdout: geminiStdout(), stderr: "", exitCode: 0, success: true };
    const result = adapter.processRunResult(raw, { ...request, resultJson: true }, context);
    expect(JSON.parse(result.stdout)).toMatchObject({ response: "done", codemux: { recording: h.experiment.recordingPath, served_model: null, usage: { input_tokens: 90, cached_input_tokens: 10, output_tokens: 20, total_tokens: 120 } } });
    expect(adapter.processRunResult(raw, request, context).stdout).toBe("done\n");
    expect(adapter.processRunResult({ ...raw, stdout: "bad" }, request, context).success).toBe(false);
    expect(adapter.processRunResult({ ...raw, stdout: geminiStdout(geminiEvents().slice(0, -1)) }, request, context).success).toBe(false);
    await adapter.cleanupRun(context);
    const spy = spyOn(geminiSpecModule, "readExperimentRunSpec").mockReturnValue({ ...geminiSpec, recording: join(h.home, "records") });
    try {
      expect(() => adapter.prepareRun({ ...request, hermetic: false })).toThrow("private hermetic");
      const prepared = adapter.prepareRun(request);
      expect(prepared.stdoutSink).toBe(prepared.experimentGemini);
      expect(prepared.experimentRecording).toEndWith(".jsonl");
      const home = prepared.geminiHermeticHome!.home;
      await adapter.cleanupRun(prepared); expect(existsSync(home)).toBe(false);
      spy.mockReturnValue({ ...geminiSpec, control: true, recording: join(h.home, "records") });
      const control = adapter.prepareRun({ ...request, hermetic: false });
      expect(control.experimentRecording).toEndWith(".control.jsonl"); await adapter.cleanupRun(control);
    } finally { spy.mockRestore(); }
  }));
  test("real authenticated relay dispatches a synthetic server and verifies native-shaped telemetry", async () => geminiRig(async (h) => {
    const spec: GeminiExperimentSpec = { ...geminiSpec, command: process.execPath,
      args: ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`, resolve("tests/fixtures/experiment-mcp.ts")], recording: join(h.home, "recordings") };
    const experiment = new GeminiExperimentRun(spec, h.home, h.home, {}, "synthetic prompt");
    try {
      await experiment.prepare("0.60.0");
      const post = async (id: number, method: string, params?: JsonObject) => {
        const response = await fetch(experiment.relay.url, { method: "POST", headers: { Authorization: `Bearer ${experiment.relay.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
        expect(response.status).toBe(200); return await response.json() as JsonObject;
      };
      await post(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake-gemini", version: "0" } });
      const catalog = await post(2, "tools/list");
      const events = geminiEvents(); events[1] = { ...events[1], tool_name: "mcp_test_bash", tool_id: "mcp_test_bash__native-1", parameters: { command: "constant" } };
      events[2] = { ...events[2], tool_id: "mcp_test_bash__native-1" };
      experiment.push(geminiStdout(events.slice(0, 2)));
      const result = await post(3, "tools/call", { name: "bash", arguments: { command: "constant" } });
      experiment.push(geminiStdout(events.slice(2))); experiment.finish();
      const records = geminiTelemetry();
      records[1]!.attributes["gen_ai.tool.definitions"] = JSON.stringify([{ functionDeclarations: geminiExperimentDefinitions("test", catalog.result.tools) }]);
      records[2]!.attributes.request_text = JSON.stringify([{ role: "model", parts: [{ functionCall: { id: "native-1", name: "mcp_test_bash", args: { command: "constant" } } }] },
        { role: "user", parts: [{ functionResponse: { id: "native-1", name: "mcp_test_bash", response: { output: geminiExperimentOutput(result.result) } } }] }]);
      writeFileSync(experiment.evidencePath, records.map((r) => JSON.stringify(r, null, 2)).join("\n"));
      await experiment.complete(); await experiment.close();
      const receipt = readFileSync(experiment.recordingPath, "utf8");
      expect(receipt).toContain('"kind":"tool_result_delivered"');
      expect(receipt).toContain('"native_call_id":"mcp_test_bash__native-1"');
      expect(receipt).toContain('"code":null');
    } finally { await experiment.close(); }
  }));
});
