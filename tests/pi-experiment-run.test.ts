import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PiExperimentRun, piExperimentExtensionSource, type PiExperimentRelay } from "../src/pi-experiment-run.js";
import { experimentFailure, ExperimentFailureCode, ExperimentRecording } from "../src/experiment-records.js";
import { PiAdapter } from "../src/adapters/pi.js";
import { assistant, content, definition, evidence, payload, resultMessage, source, stdout } from "./pi-experiment-content.test.js";
import type { JsonObject } from "../src/experiment-server.js";
import { experimentCanaryControl, type ExperimentSpec } from "../src/experiment-mcp.js";
import { verifyPiExperimentEvidence } from "../src/pi-experiment-evidence.js";
import type { PiMcpTool } from "../src/pi-mcp-extension.js";

const spec: ExperimentSpec = { name: "test", command: "/synthetic/fake-pi-server", args: [], env: [] };
async function rig(run: (h: ReturnType<typeof setup>) => void | Promise<void>): Promise<void> {
  const parent = join(process.cwd(), "scratch", "fix", "pi-synthetic"); mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "experiment-"));
  const h = setup(home);
  try { await run(h); } finally { rmSync(home, { recursive: true, force: true }); }
}
function setup(home: string) {
  let starts = 0, finishes = 0, closes = 0, syncCloses = 0, terms = 0, failure: ReturnType<typeof experimentFailure> | null = null;
  const listeners = new Set<() => void>();
  const s = source();
  const relay: PiExperimentRelay = { ...s, spec, token: "synthetic-secret", url: "http://127.0.0.1:12345/mcp", recordingPath: join(home, "recording.jsonl"),
    get failureError() { return failure; }, start: async () => { starts++; }, finish: () => { finishes++; },
    fail: (error) => { failure ??= experimentFailure(error); for (const listener of listeners) listener(); },
    onFailure: (listener) => { const fn = () => listener(failure!); listeners.add(fn); return () => { listeners.delete(fn); }; },
    terminateProtocol: () => { terms++; }, close: async () => { closes++; }, closeSync: () => { syncCloses++; },
  };
  const experiment = new PiExperimentRun(spec, home, home, {}, "literal prompt", relay);
  return { home, relay, experiment, records: s.records, state: () => ({ starts, finishes, closes, syncCloses, terms, listeners: listeners.size }),
    writeEvidence: (records: JsonObject[] = evidence()) => writeFileSync(experiment.evidencePath, records.map((r) => JSON.stringify(r) + "\n").join("")) };
}

describe("Pi experiment host lifecycle", () => {
  test("prepares once, forwards literal stdin, verifies, preserves evidence and closes", async () => rig(async (h) => {
    await Promise.all([h.experiment.prepare(), h.experiment.prepare()]);
    expect(h.state().starts).toBe(1);
    const extension = readFileSync(h.experiment.extensionPath, "utf8");
    expect(extension).toContain("CODEMUX_PI_EXPERIMENT_TOKEN");
    expect(extension).not.toContain("synthetic-secret");
    expect(new Bun.Transpiler({ loader: "js" }).transformSync(extension)).toContain("export");
    h.writeEvidence();
    let written = "", ended = false, aborted = false;
    h.experiment.start((text) => { written += text; }, () => { ended = true; }, () => { aborted = true; });
    expect([written, ended, aborted]).toEqual(["literal prompt", true, false]);
    h.experiment.push(stdout); expect(h.experiment.hasOutput).toBe(true);
    expect(h.experiment.keptBytes()).toBe(Buffer.byteLength(stdout));
    expect(h.experiment.finish()).toBe(stdout); h.experiment.push("ignored");
    expect(h.experiment.capturedOutput).toBe(stdout);
    await Promise.all([h.experiment.complete(), h.experiment.complete()]);
    expect(h.state().finishes).toBe(1);
    expect(h.records.some((r) => r.kind === "pi_evidence_copy")).toBe(true);
    expect(h.experiment.recordingPath).toEndWith("recording.jsonl");
    expect(await h.relay.resolveCallId!({ relay_index: 1, name: "echo", input: {} }, { params: { _meta: { "codemux/callId": "id" } } })).toBe("id");
    expect(h.relay.resolveCallId!({ relay_index: 1, name: "echo", input: {} }, {})).rejects.toThrow("toolCallId");
    await Promise.all([h.experiment.close(), h.experiment.close()]); h.experiment.closeSync();
    expect(h.state()).toMatchObject({ closes: 1, syncCloses: 1, listeners: 0 });
  }));
  test("retains provider mismatches before cleanup and keeps the primary failure", async () => rig(async (h) => {
    await h.experiment.prepare();
    const records = evidence(); records[5]!.fields.payload.messages[1].content = "changed";
    h.writeEvidence(records); h.experiment.push(stdout); h.experiment.finish();
    expect(h.experiment.complete()).rejects.toThrow("changed");
    expect(h.records.some((r) => r.kind === "pi_evidence_copy")).toBe(true);
    let aborted = false;
    h.experiment.start(() => { throw new Error("must not write"); }, () => {}, () => { aborted = true; });
    expect(aborted).toBe(true); await h.experiment.close();
  }));
  test("aborts capture when relay fails and detaches listeners", async () => rig(async (h) => {
    await h.experiment.prepare(); let aborted = false;
    h.experiment.start(() => {}, () => {}, () => { aborted = true; });
    h.relay.fail(new Error("server exited")); expect(aborted).toBe(true);
    h.experiment.closeProtocol(); expect(h.state().listeners).toBe(0);
  }));
  test.each(["timeout", "abort", "truncated", "invalid-json", "missing"])("rejects %s evidence", async (kind) => rig(async (h) => {
    if (kind !== "missing") await h.experiment.prepare();
    if (kind === "timeout") { h.writeEvidence(); h.experiment.terminateProtocol(); expect(h.state().terms).toBe(1); }
    if (kind === "abort") h.experiment.finish({ timedOut: false, aborted: true });
    if (kind === "truncated") writeFileSync(h.experiment.evidencePath, "{}");
    if (kind === "invalid-json") writeFileSync(h.experiment.evidencePath, "broken\n");
    expect(h.experiment.complete()).rejects.toThrow();
  }));
  test("failed preparation retains the failure", async () => rig(async (h) => {
    h.relay.start = async () => { throw new Error("synthetic startup failure"); };
    expect(h.experiment.prepare()).rejects.toThrow("startup failure");
    await h.experiment.close(); expect(h.relay.failureError?.message).toContain("startup failure");
  }));
  test("adapter carries the private extension, tokens, native tool denial and cleanup", async () => rig(async (h) => {
    const adapter = new PiAdapter({});
    let finalized = false;
    const context = { experimentPi: h.experiment, experimentRecording: h.experiment.recordingPath,
      piProviderAgentDir: { path: h.home, finalize: () => { finalized = true; } } };
    const specPath = join(h.home, "spec.json"); writeFileSync(specPath, JSON.stringify(spec));
    const request = { agent: "pi" as const, prompt: "p", experimentMcp: specPath, hermetic: true, tools: "none" as const, autonomy: "read-only" as const };
    const command = adapter.buildRunCommand(request, context);
    expect(command).toContain("--no-builtin-tools"); expect(command).not.toContain("--no-tools"); expect(command).not.toContain("--tools");
    expect(command).toContain(h.experiment.extensionPath); expect(command).toContain("--no-extensions");
    expect(adapter.getRunEnv(request, context)).toMatchObject({ CODEMUX_PI_EXPERIMENT_TOKEN: "synthetic-secret" });
    expect(() => adapter.buildRunCommand(request)).toThrow("not prepared");
    expect(() => adapter.prepareRun({ ...request, hermetic: false })).toThrow("private hermetic");
    const result = adapter.processRunResult({ stdout, stderr: "", exitCode: 0, success: true }, { ...request, resultJson: true }, context);
    expect(JSON.parse(result.stdout).codemux.recording).toBe(h.experiment.recordingPath);
    await adapter.cleanupRun(context); expect(finalized).toBe(true);
    expect(() => adapter.prepareRun({ ...request, experimentMcp: join(h.home, "missing-spec") })).toThrow();
  }));
  test("embedded experiment source remains standalone JavaScript", () => {
    const source = piExperimentExtensionSource("http://127.0.0.1:1/mcp", "test", "/synthetic/evidence.jsonl");
    expect(new Bun.Transpiler({ loader: "js" }).transformSync(source)).toContain("createTransport");
    expect(source).toContain("toolTimeoutMs:7200000");
  });
  test("the experiment spec carries its exact tool deadline into the native extension", async () => rig(async (h) => {
    const custom = { ...spec, tool_timeout_seconds: 1 };
    const experiment = new PiExperimentRun(custom, h.home, h.home, {}, "synthetic", { ...h.relay, spec: custom });
    await experiment.prepare();
    expect(readFileSync(experiment.extensionPath, "utf8")).toContain("toolTimeoutMs:1000");
    await experiment.close();
  }));
  test("native deadline evidence preserves the timeout cause before incomplete relay results", async () => rig(async (h) => {
    await h.experiment.prepare();
    delete h.relay.calls[0]!.result;
    const records = evidence().slice(0, 2);
    records.push({ kind: "tool_timeout", fields: { call_id: "native-1", name: "mcp__test__echo", input: {}, timeout_ms: 7_200_000 } });
    h.writeEvidence(records); h.experiment.finish();
    await expect(h.experiment.complete()).rejects.toThrow("pi tool call timed out after 7200000 ms");
    expect(h.relay.failureError?.code).toBe(ExperimentFailureCode.ServerError);
    expect(h.records.some((record) => record.kind === "pi_extension_evidence" && record.fields.event_kind === "tool_timeout")).toBe(true);
    expect(h.records.some((record) => record.kind === "pi_evidence_copy")).toBe(true);
  }));
  test("timeout evidence with the wrong call or deadline fails closed", () => {
    for (const fields of [
      { call_id: "wrong", name: "mcp__test__echo", input: {}, timeout_ms: 7_200_000 },
      { call_id: "native-1", name: "mcp__test__echo", input: {}, timeout_ms: 1 },
    ]) {
      expect(() => verifyPiExperimentEvidence(source(), [{ kind: "tool_timeout", fields }], ""))
        .toThrow("does not match the relay call and configured deadline");
    }
  });
  test("evidence obeys the real recording schema's reserved-field contract", async () => rig((h) => {
    const recording = new ExperimentRecording({ ...spec, recording: join(h.home, "recordings") }, h.home, {});
    try { verifyPiExperimentEvidence({ ...source(), record: recording.record }, evidence(), stdout); }
    finally { recording.close({ code: null, error: null }); }
    const records = readFileSync(recording.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.some((record) => record.kind === "pi_extension_evidence" && record.event_kind === "provider_request")).toBe(true);
  }));
  test("paired-check control keeps cwd discovery and owns separate private artifacts", async () => rig(async (h) => {
    const specPath = join(h.home, "spec.json");
    writeFileSync(specPath, JSON.stringify({ ...spec, recording: join(h.home, "recordings") }));
    const adapter = new PiAdapter({ HOME: h.home }, h.home);
    const request = { agent: "pi" as const, prompt: "probe", cwd: h.home, experimentMcp: specPath, hermetic: true,
      tools: "none" as const, autonomy: "read-only" as const };
    const control = experimentCanaryControl(request);
    const probeContext = adapter.prepareRun(request), controlContext = adapter.prepareRun(control);
    try {
      expect(probeContext.piProviderAgentDir?.path).not.toBe(controlContext.piProviderAgentDir?.path);
      expect(adapter.buildRunCommand(request, probeContext)).toContain("--no-context-files");
      expect(adapter.buildRunCommand(control, controlContext)).not.toContain("--no-context-files");
      expect(controlContext.experimentRecording).toEndWith(".control.jsonl");
      expect(adapter.getRunEnv(request, probeContext).CODEMUX_PI_EXPERIMENT_TOKEN).toHaveLength(64);
    } finally { await adapter.cleanupRun(probeContext); await adapter.cleanupRun(controlContext); }
  }));
  test("the generated extension executes through fake HTTP and real evidence files", async () => rig(async (h) => {
    await h.experiment.prepare();
    const tools: PiMcpTool[] = [], hooks = new Map<string, (event: JsonObject, context?: JsonObject) => unknown>();
    const fetched = spyOn(globalThis, "fetch").mockImplementation((async (_url, request) => {
      const frame = JSON.parse(String(request!.body));
      if (frame.id === undefined) return new Response(null, { status: 202 });
      if (frame.method === "tools/call") expect(frame.params._meta["codemux/callId"]).toBe("native-1");
      return Response.json({ jsonrpc: "2.0", id: frame.id,
        result: frame.method === "tools/list" ? { tools: [definition] } : frame.method === "tools/call" ? { content } : {} });
    }) as typeof fetch);
    const originalToken = process.env.CODEMUX_PI_EXPERIMENT_TOKEN;
    process.env.CODEMUX_PI_EXPERIMENT_TOKEN = "synthetic-secret";
    try {
      const extension = await import(pathToFileURL(h.experiment.extensionPath).href);
      await extension.default({ registerTool: (tool: PiMcpTool) => { tools.push(tool); },
        on: (name: string, hook: (event: JsonObject, context?: JsonObject) => unknown) => { hooks.set(name, hook); },
        getActiveTools: () => [], setActiveTools: () => {} });
      hooks.get("session_start")!({});
      await tools[0]!.execute("native-1", {});
      hooks.get("tool_result")!({ toolCallId: "native-1" });
      hooks.get("context")!({ messages: [assistant, resultMessage] });
      hooks.get("before_provider_request")!({ payload: payload("openai-completions", [assistant, resultMessage]) }, { model: { api: "openai-completions", id: "synthetic" } });
      await hooks.get("session_shutdown")!({});
      h.experiment.push(stdout); h.experiment.finish(); await h.experiment.complete(); await h.experiment.close();
      expect(h.state().finishes).toBe(1);
      expect(h.records.some((record) => record.kind === "tool_result_delivered")).toBe(true);
    } finally {
      fetched.mockRestore();
      if (originalToken === undefined) delete process.env.CODEMUX_PI_EXPERIMENT_TOKEN;
      else process.env.CODEMUX_PI_EXPERIMENT_TOKEN = originalToken;
    }
  }));
});
