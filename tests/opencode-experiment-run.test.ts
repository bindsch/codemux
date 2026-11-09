import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpencodeExperimentRun, opencodeExperimentFailureResult, type OpencodeExperimentRelay } from "../src/opencode-experiment-run.js";
import { installOpencodeExperimentObserver, opencodeExperimentPluginSource, OPENCODE_EVIDENCE_HEADER } from "../src/opencode-experiment-plugin.js";
import { experimentFailure } from "../src/experiment-records.js";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import { experimentCanaryControl } from "../src/experiment-mcp.js";
import { writeRunStdin } from "../src/process-stdin-repeat.js";
import type { JsonObject } from "../src/experiment-server.js";
import { evidence, source, stdout } from "./fixtures/live/fake-opencode-experiment.js";

const spec = { name: "test", command: "/synthetic/server", args: [], env: [] };
async function rig(run: (h: ReturnType<typeof setup>) => void | Promise<void>): Promise<void> {
  const parent = join(process.cwd(), "scratch", "fix", "opencode-synthetic"); mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "experiment-"));
  try { await run(setup(home)); } finally { rmSync(home, { recursive: true, force: true }); }
}
function setup(home: string) {
  let starts = 0, finishes = 0, closes = 0, syncCloses = 0, terms = 0, failure: ReturnType<typeof experimentFailure> | null = null;
  const listeners = new Set<() => void>();
  const s = source();
  const relay: OpencodeExperimentRelay = { ...s, spec, token: "synthetic-secret", url: "http://127.0.0.1:12345/mcp", recordingPath: join(home, "recording.jsonl"),
    get failureError() { return failure; }, start: async () => { starts++; }, finish: () => { finishes++; },
    fail: (error) => { failure ??= experimentFailure(error); for (const listener of listeners) listener(); },
    onFailure: (listener) => { const fn = () => listener(failure!); listeners.add(fn); return () => { listeners.delete(fn); }; },
    terminateProtocol: () => { terms++; }, close: async () => { closes++; }, closeSync: () => { syncCloses++; },
  };
  const experiment = new OpencodeExperimentRun(spec, home, home, {}, "literal prompt", relay);
  return { home, relay, experiment, records: s.records,
    state: () => ({ starts, finishes, closes, syncCloses, terms, listeners: listeners.size }),
    writeEvidence: (records: JsonObject[] = evidence()) => writeFileSync(experiment.evidencePath, records.map((r) => JSON.stringify(r) + "\n").join("")) };
}

describe("OpenCode native observer boundary", () => {
  test("captures final JSON, removes its private header, and excludes authorization", async () => {
    const records: JsonObject[] = [], sent: { input: unknown; init?: RequestInit }[] = [];
    const original = (async (input: unknown, init?: RequestInit) => {
      sent.push({ input, init }); return new Response("ok");
    }) as typeof fetch;
    const runtime = { fetch: original };
    const hooks = installOpencodeExperimentObserver(runtime, (kind, fields) => { records.push({ kind, fields }); });
    const output = { headers: { Authorization: "secret" } as Record<string, string> };
    await hooks["chat.headers"]({ sessionID: "s" }, output);
    await runtime.fetch("https://provider.invalid", { method: "POST", headers: output.headers, body: '{"transformed":"final"}' });
    expect(new Headers(sent[0]!.init!.headers).get(OPENCODE_EVIDENCE_HEADER)).toBeNull();
    expect(new Headers(sent[0]!.init!.headers).get("authorization")).toBe("secret");
    expect(records[1]).toEqual({ kind: "provider_request", fields: { request_id: "1", payload: { transformed: "final" } } });
    expect(JSON.stringify(records)).not.toContain("secret");
    await hooks["tool.execute.before"]({ sessionID: "s", callID: "id", tool: "test_echo" }, { args: { text: "x" } });
    expect(records.at(-1)!.fields.call_id).toBe("id");
    await runtime.fetch("https://provider.invalid/unobserved"); expect(records).toHaveLength(4);
    await hooks.dispose(); expect(runtime.fetch).toBe(original);
  });
  test("handles Request bodies and refuses unknown markers, absent/oversized bodies, malformed JSON", async () => {
    const sent: Request[] = [];
    const runtime = { fetch: (async (input: Request) => { sent.push(input); return new Response(); }) as typeof fetch };
    const hooks = installOpencodeExperimentObserver(runtime, () => {});
    const output = { headers: {} }; await hooks["chat.headers"]({ sessionID: "s" }, output);
    await runtime.fetch(new Request("https://provider.invalid", { method: "POST", headers: output.headers, body: "{}" }));
    expect(sent[0]!.headers.has(OPENCODE_EVIDENCE_HEADER)).toBe(false);
    await expect(runtime.fetch("https://provider.invalid", { headers: { [OPENCODE_EVIDENCE_HEADER]: "unknown" }, body: "{}" })).rejects.toThrow("unknown");
    for (const body of [undefined, new Uint8Array([1]), " ".repeat(16 * 1024 * 1024 + 1), "invalid"]) {
      await expect(runtime.fetch("https://provider.invalid", { headers: output.headers, body })).rejects.toThrow();
    }
    const replacement = runtime.fetch; runtime.fetch = fetch;
    await hooks.dispose(); expect(runtime.fetch).not.toBe(replacement);
  });
  test("generated plugin executes without an external package or harness", async () => rig(async (h) => {
    const code = opencodeExperimentPluginSource(h.experiment.evidencePath);
    expect(new Bun.Transpiler({ loader: "js" }).transformSync(code)).toContain("export");
    writeFileSync(h.experiment.pluginPath, code);
    const mod = await import(h.experiment.pluginPath);
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"object":"chat.completion","model":"actual-provider-model","choices":[]}', { headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const hooks = await mod.default();
    try {
      const output = { headers: {} };
      await hooks["chat.headers"]({ sessionID: "synthetic" }, output);
      const response = await fetch("https://provider.invalid", { headers: output.headers, body: '{"model":"requested-alias"}' });
      await response.text();
    } finally { await hooks.dispose(); globalThis.fetch = original; }
    expect(readFileSync(h.experiment.evidencePath, "utf8")).toContain('"kind":"model_turn"');
    expect(readFileSync(h.experiment.evidencePath, "utf8")).toContain('"served_model":"actual-provider-model"');
    expect(code).not.toContain("synthetic-secret");
  }));
  test("bounds Request streams before dispatch and stops stalled observation", async () => {
    let dispatched = 0;
    const runtime = { fetch: (async () => { dispatched++; return new Response(); }) as unknown as typeof fetch };
    const hooks = installOpencodeExperimentObserver(runtime, () => {}, undefined, undefined, 10);
    const output = { headers: {} }; await hooks["chat.headers"]({ sessionID: "s" }, output);
    const overflow = new Request("https://provider.invalid", { method: "POST", headers: output.headers,
      body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)); controller.close(); } }) });
    await expect(runtime.fetch(overflow)).rejects.toThrow("exceeds");
    const stalled = new Request("https://provider.invalid", { method: "POST", headers: output.headers, body: new ReadableStream() });
    await expect(runtime.fetch(stalled)).rejects.toThrow("timed out");
    expect(dispatched).toBe(0); await hooks.dispose();
  });
  test("response-model reads run concurrently and dispose waits for their evidence", async () => {
    const records: JsonObject[] = [];
    let finish!: (model: string | null) => void;
    const read = new Promise<string | null>((resolve) => { finish = resolve; });
    const runtime = { fetch: (async () => new Response("body")) as unknown as typeof fetch };
    const hooks = installOpencodeExperimentObserver(runtime, (kind, fields) => { records.push({ kind, fields }); }, undefined, () => read);
    const output = { headers: {} }; await hooks["chat.headers"]({ sessionID: "s" }, output);
    const response = await runtime.fetch("https://provider.invalid", { headers: output.headers, body: "{}" });
    expect(await response.text()).toBe("body"); expect(records.some((record) => record.kind === "provider_model")).toBe(false);
    const disposed = hooks.dispose(); finish("actual-provider-model"); await disposed;
    expect(records.at(-1)).toEqual({ kind: "provider_model", fields: { request_id: "1", served_model: "actual-provider-model" } });
  });
  test("records failed transport attempts before native retry", async () => {
    const records: JsonObject[] = [];
    const runtime = { fetch: (async () => { throw new Error("network failed"); }) as unknown as typeof fetch };
    const hooks = installOpencodeExperimentObserver(runtime, (kind, fields) => { records.push({ kind, fields }); });
    const output = { headers: {} }; await hooks["chat.headers"]({ sessionID: "s" }, output);
    await expect(runtime.fetch("https://provider.invalid", { headers: output.headers, body: "{}" })).rejects.toThrow("network failed");
    expect(records.at(-1)).toEqual({ kind: "provider_response", fields: { request_id: "1", status: 0 } });
    await hooks.dispose();
  });
});

describe("OpenCode experiment lifecycle", () => {
  test("prepares once, resolves exact call IDs, verifies retained evidence and closes", async () => rig(async (h) => {
    await Promise.all([h.experiment.prepare(), h.experiment.prepare()]); expect(h.state().starts).toBe(1);
    h.writeEvidence();
    const native = { relay_index: 0, name: "echo", input: { text: "unchanged" } };
    expect(await h.relay.resolveCallId!(native, {})).toBe("call-1");
    await expect(h.relay.resolveCallId!(native, {})).rejects.toThrow("unambiguous");
    let input = "", ended = false;
    h.experiment.start((text) => { input += text; }, () => { ended = true; }, () => {});
    expect([input, ended]).toEqual(["literal prompt", true]);
    h.experiment.push(stdout()); expect(h.experiment.hasOutput).toBe(true);
    expect(h.experiment.keptBytes()).toBe(Buffer.byteLength(stdout()));
    expect(h.experiment.finish()).toBe(stdout()); h.experiment.push("ignored");
    expect(h.experiment.capturedOutput).toBe(stdout());
    await Promise.all([h.experiment.complete(), h.experiment.complete()]); expect(h.state().finishes).toBe(1);
    expect(h.records.some((r) => r.kind === "opencode_evidence_copy")).toBe(true);
    expect(h.experiment.scanSurface()).toContain('"kind":"provider_request"');
    expect(h.experiment.recordingPath).toEndWith("recording.jsonl");
    const config = h.experiment.config;
    expect(config.mcp.test).toMatchObject({ type: "remote", oauth: false, timeout: 7200000 });
    expect(config.agent[h.experiment.agent].permission).toEqual({ "*": "deny", "test_*": "allow" });
    expect(JSON.stringify(config)).not.toContain("synthetic-secret");
    await Promise.all([h.experiment.close(), h.experiment.close()]); h.experiment.closeSync();
    expect(h.state()).toMatchObject({ closes: 1, syncCloses: 1, listeners: 0 });
  }));
  test("refuses ambiguous concurrent calls without FIFO attribution", async () => rig(async (h) => {
    await h.experiment.prepare(); const e = evidence();
    e.push({ ...e[3]!, fields: { ...e[3]!.fields, call_id: "second" } }); h.writeEvidence(e);
    await expect(h.relay.resolveCallId!({ relay_index: 0, name: "echo", input: { text: "unchanged" } }, {})).rejects.toThrow("unambiguous");
  }));
  test("the shared stdin boundary selects the experiment start hook once", async () => rig(async (h) => {
    const writes: string[] = []; let ends = 0;
    const stdin = { write: (text: string) => { writes.push(text); }, end: () => { ends++; } };
    writeRunStdin({ stdinInput: "must not write twice", stdoutSink: h.experiment }, { stdin, exited: Promise.resolve() }, () => {});
    expect([writes.length, ends]).toEqual([0, 0]);
    h.experiment.start(stdin.write, stdin.end, () => {});
    expect(writes).toEqual(["literal prompt"]); expect(ends).toBe(1);
    h.experiment.closeProtocol();
  }));
  test("relay failure aborts input and detaches the listener", async () => rig(async (h) => {
    await h.experiment.prepare(); let aborted = 0;
    h.experiment.start(() => {}, () => {}, () => { aborted++; });
    h.relay.fail(new Error("server exited")); expect(aborted).toBe(1);
    h.experiment.start(() => { throw new Error("must not write"); }, () => {}, () => { aborted++; });
    expect(aborted).toBe(2); await h.experiment.close();
  }));
  test.each(["timeout", "abort", "truncated", "invalid-json", "missing", "changed", "stdout-bound"])("retains failure for %s", async (kind) => rig(async (h) => {
    if (kind !== "missing") await h.experiment.prepare();
    if (kind === "timeout") { h.writeEvidence(); h.experiment.terminateProtocol(); expect(h.state().terms).toBe(1); }
    if (kind === "abort") h.experiment.finish({ timedOut: false, aborted: true });
    if (kind === "truncated") writeFileSync(h.experiment.evidencePath, "{}");
    if (kind === "invalid-json") writeFileSync(h.experiment.evidencePath, "broken\n");
    if (kind === "changed") { const e = evidence(); e[5]!.fields.payload.messages[1].content = "changed"; h.writeEvidence(e); h.experiment.push(stdout()); }
    if (kind === "stdout-bound") { h.writeEvidence(); h.experiment.push(" ".repeat(16 * 1024 * 1024 + 1)); }
    await expect(h.experiment.complete({ timedOut: kind === "timeout" })).rejects.toThrow();
    expect(h.relay.failureError).not.toBeNull(); await h.experiment.close();
  }));
  test("failed preparation is retained", async () => rig(async (h) => {
    h.relay.start = async () => { throw new Error("startup failed"); };
    await expect(h.experiment.prepare()).rejects.toThrow("startup failed"); expect(h.relay.failureError).not.toBeNull();
  }));
  test("shared failure and interruption helpers retain evidence before cleanup", async () => rig(async (h) => {
    const request = { agent: "opencode" as const, prompt: "p", experimentMcp: "spec" };
    const context = { experimentOpencode: h.experiment };
    h.experiment.push(stdout()); h.experiment.finish();
    const adapter = { processRunResult: (result: { stdout: string; stderr: string; exitCode: number; success: boolean }) => result };
    const normalized = opencodeExperimentFailureResult(adapter, request, context, undefined, undefined);
    expect(normalized?.stdout).toBe(stdout());
    expect(opencodeExperimentFailureResult(adapter, request, context, undefined, normalized)).toBe(normalized);
    expect(opencodeExperimentFailureResult(adapter, { ...request, experimentMcp: undefined }, context, undefined, undefined)).toBeUndefined();
    h.experiment.interruptBeforeEvidence(); expect(h.relay.failureError?.message).toContain("interrupted");
    expect(h.state().terms).toBe(1);
  }));
  test("adapter omits pure only for the owned plugin and preserves probe/control isolation", async () => rig(async (h) => {
    const adapter = new OpencodeAdapter({ HOME: h.home });
    let finalized = false;
    const context = { experimentOpencode: h.experiment, experimentRecording: h.experiment.recordingPath,
      stdoutSink: h.experiment, opencodeHermeticHome: { home: h.home, finalize: () => { finalized = true; } } };
    const request = { agent: "opencode" as const, prompt: "p", experimentMcp: "spec.json", hermetic: true, tools: "none" as const, autonomy: "read-only" as const };
    const command = adapter.buildRunCommand(request, context);
    expect(command).not.toContain("--pure"); expect(command).toContain("OPENCODE_DISABLE_PROJECT_CONFIG=1");
    expect(command).toContain(h.experiment.agent); expect(command).not.toContain('OPENCODE_PERMISSION={"*":"deny"}');
    expect(command.find((arg) => arg.startsWith("OPENCODE_CONFIG_CONTENT="))).toContain("experiment.mjs");
    expect(adapter.getRunEnv(request, context)).toEqual({ CODEMUX_OPENCODE_EXPERIMENT_TOKEN: "synthetic-secret" });
    expect(command.join(" ")).not.toContain("synthetic-secret");
    expect(() => adapter.buildRunCommand(request)).toThrow("not prepared");
    const control = adapter.buildRunCommand(experimentCanaryControl(request), context);
    expect(control).not.toContain("OPENCODE_DISABLE_PROJECT_CONFIG=1"); expect(control).not.toContain(`HOME=${h.home}`);
    h.experiment.push(stdout()); h.experiment.finish();
    const result = adapter.processRunResult({ stdout: stdout(), stderr: "", exitCode: 0, success: true }, { ...request, resultJson: true }, context);
    expect(JSON.parse(result.stdout).codemux.recording).toBe(h.experiment.recordingPath);
    await h.experiment.prepare();
    h.writeEvidence([...evidence(), ...["1", "2"].map((id) => ({ kind: "provider_model", fields: { request_id: id, served_model: "actual-provider-model" }, t: 8 }))]);
    await h.experiment.complete();
    const identified = adapter.processRunResult({ stdout: stdout(), stderr: "", exitCode: 0, success: true }, { ...request, model: "requested-alias", resultJson: true }, context);
    expect(JSON.parse(identified.stdout).codemux).toMatchObject({ model: "actual-provider-model", served_model: "actual-provider-model" });
    const plain = adapter.processRunResult({ stdout: stdout(), stderr: "", exitCode: 0, success: true }, request, context);
    expect(plain.stdout).toBe("done\n");
    expect(plain.servedModel).toBe("actual-provider-model");
    await adapter.cleanupRun(context); expect(finalized).toBe(true);
    expect(() => adapter.prepareRun({ ...request, experimentMcp: join(h.home, "missing") })).toThrow();
  }));
});
