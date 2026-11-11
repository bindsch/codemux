import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertQwenExperimentCwd, QwenExperimentRun, qwenExperimentResult, type QwenExperimentRelay } from "../src/qwen-experiment-run.js";
import { experimentFailure, ExperimentFailureCode } from "../src/experiment-records.js";
import { QWEN_ACCESS_ONLY_REFRESH_TOKEN } from "../src/qwen-access-login.js";
import { QwenAdapter } from "../src/adapters/qwen.js";
import { MAX_CAPTURE_BYTES, runCapturedCommand } from "../src/process-runner.js";
import { writeRunStdin } from "../src/process-stdin-repeat.js";
import * as safeRemove from "../src/safe-remove.js";
import { evidence, input, nativeEvents, prompt, session, source, stdout } from "./fixtures/live/fake-qwen-experiment.js";

const spec = { name: "test", command: "/synthetic/server", args: [], env: [] };
const environment = { OPENAI_API_KEY: "synthetic-api-key", OPENAI_BASE_URL: "http://127.0.0.1:1", OPENAI_MODEL: "synthetic" };
function scratch(): string {
  const parent = join(process.cwd(), "scratch", "fix", "qwen-experiment-synthetic");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "run-"));
}
function setup(home: string) {
  let starts = 0, finishes = 0, closes = 0, syncCloses = 0, terms = 0;
  let failure: ReturnType<typeof experimentFailure> | null = null;
  const listeners = new Set<() => void>(), s = source();
  const relay: QwenExperimentRelay = { ...s, spec, token: "synthetic-secret", url: "http://127.0.0.1:12345/mcp",
    recordingPath: join(home, "recording.jsonl"), get failureError() { return failure; },
    start: async () => { starts++; }, finish: () => { finishes++; },
    fail: (error) => { failure ??= experimentFailure(error); for (const listener of listeners) listener(); },
    onFailure: (listener) => { const fn = () => listener(failure!); listeners.add(fn); return () => { listeners.delete(fn); }; },
    terminateProtocol: () => { terms++; }, close: async () => { closes++; }, closeSync: () => { syncCloses++; },
  };
  const experiment = new QwenExperimentRun(spec, home, home, environment, prompt, { reasoningEffort: "high" }, relay);
  return { home, relay, experiment, records: s.records,
    state: () => ({ starts, finishes, closes, syncCloses, terms, listeners: listeners.size }),
    writeEvidence: (logs = evidence()) => logs.forEach((log, index) => writeFileSync(join(experiment.logs, `openai-${index}.json`), JSON.stringify(log))) };
}
async function rig(run: (h: ReturnType<typeof setup>) => void | Promise<void>): Promise<void> {
  const home = scratch(), h = setup(home);
  try { await run(h); } finally { h.experiment.closeSync(); rmSync(home, { recursive: true, force: true }); }
}

describe("Qwen private experiment lifecycle", () => {
  test("prepares once, captures literal stdin and verifies native evidence before cleanup", async () => rig(async (h) => {
    expect(h.experiment.hasOutput).toBe(false);
    await Promise.all([h.experiment.prepare(), h.experiment.prepare()]);
    expect(h.state().starts).toBe(1);
    expect(JSON.parse(readFileSync(h.experiment.configPath, "utf8"))).toEqual({ mcpServers: { test: {
      httpUrl: h.relay.url, headers: { Authorization: "Bearer synthetic-secret" }, timeout: 7200000, trust: true, alwaysLoadTools: true,
    } } });
    expect(statSync(h.experiment.configPath).mode & 0o777).toBe(0o600);
    expect(statSync(h.experiment.home).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(join(h.experiment.home, "settings.json"), "utf8")))
      .toEqual({ model: { reasoningEffort: "high" }, tools: { toolSearch: { enabled: false } } });
    expect(readFileSync(join(h.experiment.home, "defaults.json"), "utf8")).toBe("{}");
    let written = "", ended = 0;
    const stdin = { write: (text: string) => { written += text; }, end: () => { ended++; } };
    writeRunStdin({ stdinInput: "do not repeat", stdoutSink: h.experiment }, { stdin, exited: Promise.resolve() }, () => {});
    expect(written).toBe("");
    h.experiment.start(stdin.write, stdin.end, () => {});
    expect([written, ended, h.experiment.authType]).toEqual([prompt, 1, "openai"]);
    h.writeEvidence(); h.experiment.push(stdout());
    expect(h.experiment.scanSurface).toContain(stdout());
    expect(h.experiment.hasOutput).toBe(true);
    expect(h.experiment.keptBytes()).toBe(Buffer.byteLength(stdout()));
    expect(h.experiment.finish()).toBe(stdout()); h.experiment.push("ignored");
    expect(h.experiment.capturedOutput).toBe(stdout());
    await Promise.all([h.experiment.complete(), h.experiment.complete()]);
    expect(h.state().finishes).toBe(1);
    expect(h.records.filter((r) => r.kind === "tool_result_delivered")).toHaveLength(1);
    expect(h.experiment.scanSurface).toContain('"id":"response-2"');
    expect(h.experiment.scanSurface).toContain('"role":"tool"');
    expect(h.experiment.scanSurface).not.toContain("must-not-retain");
    writeFileSync(join(h.experiment.logs, "openai-0.json"), "changed after verification");
    expect(h.experiment.recordingPath).toBe(h.relay.recordingPath);
    await Promise.all([h.experiment.close(), h.experiment.close()]); h.experiment.closeSync();
    expect(h.state()).toMatchObject({ closes: 1, syncCloses: 1, listeners: 0 });
    expect(existsSync(h.experiment.home)).toBe(false);
    expect(h.records.filter((r) => r.kind === "harness_stdout")).toEqual([
      { kind: "harness_stdout", fields: { bytes_base64: Buffer.from(stdout()).toString("base64") } },
    ]);
    expect(h.records.filter((r) => r.kind === "qwen_provider_log")).toHaveLength(2);
    expect(JSON.stringify(h.records)).not.toContain("must-not-retain");
  }));
  test.each(["startup", "config"])("retains %s preparation failure and does not retry", async (kind) => rig(async (h) => {
    if (kind === "startup") h.relay.start = async () => { throw new Error("startup refused"); };
    else writeFileSync(h.experiment.configPath, "existing config");
    const first = h.experiment.prepare(); expect(h.experiment.prepare()).toBe(first);
    await expect(first).rejects.toThrow(kind === "startup" ? "startup refused" : "EEXIST");
    expect(h.relay.failureError).not.toBeNull();
    if (kind === "config") expect(readFileSync(h.experiment.configPath, "utf8")).toBe("existing config");
  }));
  test("relay failure aborts an active stream and an already-failed start writes nothing", async () => rig(async (h) => {
    let aborted = 0, written = 0;
    h.experiment.start(() => { written++; }, () => {}, () => { aborted++; });
    h.relay.fail(new Error("server exited")); expect(aborted).toBe(1);
    h.experiment.closeProtocol(); expect(h.state().listeners).toBe(0);
    h.experiment.start(() => { written++; }, () => {}, () => { aborted++; });
    expect([written, aborted]).toEqual([1, 2]);
    await h.experiment.close(); expect(h.state().listeners).toBe(0);
  }));
  test.each(["finish-timeout", "finish-abort", "complete-timeout", "terminate", "capture-bound"])("fails closed on %s", async (kind) => rig(async (h) => {
    h.writeEvidence(); h.experiment.push(stdout());
    if (kind === "capture-bound") {
      h.experiment.push("é".repeat(MAX_CAPTURE_BYTES));
      expect(Buffer.byteLength(h.experiment.capturedOutput)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
      expect(h.experiment.keptBytes()).toBeGreaterThan(MAX_CAPTURE_BYTES);
    }
    if (kind === "terminate") { h.experiment.terminateProtocol(); expect(h.state().terms).toBe(1); }
    h.experiment.finish({ timedOut: kind === "finish-timeout", aborted: kind === "finish-abort" });
    await expect(h.experiment.complete({ timedOut: kind === "complete-timeout" })).rejects.toThrow("interrupted or exceeded");
    expect(h.state().finishes).toBe(0);
    expect(h.relay.failureError?.code).toBe(ExperimentFailureCode.HarnessLogMissing);
  }));
  test.each(["async", "sync"])("removes private home when %s relay cleanup throws", async (kind) => rig(async (h) => {
    h.writeEvidence();
    if (kind === "async") {
      h.relay.close = async () => { throw new Error("close refused"); };
      await expect(h.experiment.close()).rejects.toThrow("close refused");
    } else {
      h.relay.closeSync = () => { throw new Error("sync close refused"); };
      expect(() => h.experiment.closeSync()).toThrow("sync close refused");
      h.relay.closeSync = () => {};
    }
    expect(existsSync(h.experiment.home)).toBe(false);
    expect(h.records.filter((r) => r.kind === "qwen_provider_log_raw")).toHaveLength(2);
  }));
  test("records private-home cleanup failure before closing the relay receipt", async () => rig(async (h) => {
    const remove = safeRemove.removeUnderTrustedParentOrThrow;
    const failing = spyOn(safeRemove, "removeUnderTrustedParentOrThrow").mockImplementation((path, trusted, label) => {
      if (path === h.experiment.home) throw new Error("synthetic cleanup refusal");
      remove(path, trusted, label);
    });
    let observedAtClose: string | undefined;
    h.relay.close = async () => { observedAtClose = h.relay.failureError?.message; };
    try {
      await h.experiment.close();
      expect(observedAtClose).toBe("synthetic cleanup refusal");
      expect(existsSync(h.experiment.home)).toBe(true);
    } finally { failing.mockRestore(); }
    h.experiment.closeSync();
    expect(existsSync(h.experiment.home)).toBe(false);
  }));
});

describe("Qwen native identity and bounded logs", () => {
  const native = { relay_index: 1, name: "echo", input };
  test("waits for a complete native frame, resolves its exact ID, and rejects a second claim", async () => rig(async (h) => {
    const pending = h.relay.resolveCallId!(native, {});
    h.experiment.push(stdout(nativeEvents().slice(0, 1)));
    expect(await pending).toBe("native-call-42");
    h.experiment.finish();
    await expect(h.relay.resolveCallId!(native, {})).rejects.toThrow("lacks a native call identity");
  }));
  test("waits for the next frame when a later call repeats previously claimed arguments", async () => rig(async (h) => {
    h.experiment.push(stdout(nativeEvents().slice(0, 1)));
    expect(await h.relay.resolveCallId!(native, {})).toBe("native-call-42");
    const later = h.relay.resolveCallId!({ ...native, relay_index: 2 }, {});
    h.experiment.push(stdout(nativeEvents("echo", input, "late-second-id").slice(0, 1)));
    expect(await later).toBe("late-second-id");
  }));
  test("refuses parallel identical calls instead of guessing their order", async () => rig(async (h) => {
    h.experiment.push(stdout([nativeEvents()[0]!, nativeEvents("echo", input, "second-id")[0]!]));
    await expect(h.relay.resolveCallId!(native, {})).rejects.toThrow("ambiguous");
  }));
  test.each(["finished", "terminated", "deadline", "failed", "duplicate"])("refuses %s native identity", async (kind) => rig(async (h) => {
    if (kind === "finished") h.experiment.finish();
    if (kind === "terminated") h.experiment.terminateProtocol();
    if (kind === "failed") h.relay.fail(new Error("identity transport failed"));
    if (kind === "duplicate") h.experiment.push(stdout([nativeEvents()[0]!, nativeEvents()[0]!]));
    let tick = 0;
    const clock = kind === "deadline" ? spyOn(Date, "now").mockImplementation(() => tick++ * 10001) : undefined;
    try { await expect(h.relay.resolveCallId!(native, {})).rejects.toThrow(); } finally { clock?.mockRestore(); }
  }));
  test.each(["missing", "unexpected", "invalid-json", "array", "null", "symlink", "byte-bound", "count-bound"])("rejects %s provider logs", async (kind) => rig(async (h) => {
    h.experiment.push(stdout()); h.experiment.finish();
    const path = join(h.experiment.logs, "openai-0.json");
    if (kind === "unexpected") writeFileSync(join(h.experiment.logs, "untrusted.log"), "{}");
    if (kind === "invalid-json") writeFileSync(path, "{broken");
    if (kind === "array" || kind === "null") writeFileSync(path, kind === "array" ? "[]" : "null");
    if (kind === "symlink") { writeFileSync(join(h.home, "external.json"), "{}"); symlinkSync(join(h.home, "external.json"), path); }
    if (kind === "byte-bound") writeFileSync(path, " ".repeat(32 * 1024 * 1024 + 1));
    if (kind === "count-bound") for (let i = 0; i < 1025; i++) writeFileSync(join(h.experiment.logs, `openai-${i}.json`), "{}");
    await expect(h.experiment.complete()).rejects.toThrow();
    expect(h.relay.failureError).not.toBeNull();
    await h.experiment.close();
    expect(h.records.filter((r) => r.kind === "harness_stdout")).toHaveLength(1);
  }));
  test("retains malformed log bytes and valid adjacent logs independently", async () => rig(async (h) => {
    h.writeEvidence();
    const valid = readFileSync(join(h.experiment.logs, "openai-1.json"), "utf8");
    writeFileSync(join(h.experiment.logs, "openai-0.json"), "{unfinished capture");
    h.experiment.push(stdout()); h.experiment.finish();
    await expect(h.experiment.complete()).rejects.toThrow();
    await h.experiment.close();
    const raw = h.records.filter((r) => r.kind === "qwen_provider_log_raw");
    expect(raw.map((r) => [r.fields.file, Buffer.from(r.fields.bytes_base64, "base64").toString()])).toEqual([
      ["openai-0.json", "{unfinished capture"], ["openai-1.json", valid],
    ]);
  }));
});

describe("Qwen OAuth and result boundaries", () => {
  test.each(["missing", "symlink", "oversized"])("cleans constructor state after %s OAuth credentials", (kind) => {
    const home = scratch();
    try {
      const credentials = join(home, "oauth_creds.json");
      if (kind === "symlink") { writeFileSync(join(home, "external.json"), "{}"); symlinkSync(join(home, "external.json"), credentials); }
      if (kind === "oversized") writeFileSync(credentials, " ".repeat(1024 * 1024 + 1));
      expect(() => new QwenExperimentRun(spec, home, home, {}, prompt)).toThrow();
      expect(readdirSync(join(home, ".codemux-experiment"))).toEqual([]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  const login = (access: string, expiry = Date.now() + 3_600_000) => JSON.stringify({
    access_token: access, token_type: "Bearer", refresh_token: "synthetic-refresh-value", expiry_date: expiry,
    resource_url: "portal.example.invalid", extra: "synthetic-extra" });
  test("writes only the access fields of a synthetic credential and protects its permissions", async () => rig(async (h) => {
    writeFileSync(join(h.home, "oauth_creds.json"), login("synthetic-oauth"));
    writeFileSync(join(h.home, "settings.json"), '{"mcpServers":{"untrusted":{}}}');
    const experiment = new QwenExperimentRun(spec, h.home, h.home, { OPENAI_API_KEY: "incomplete" }, prompt, {}, h.relay);
    try {
      expect(experiment.authType).toBe("qwen-oauth");
      const copied = join(experiment.home, "oauth_creds.json");
      const written = JSON.parse(readFileSync(copied, "utf8"));
      expect(written).toEqual({ access_token: "synthetic-oauth", token_type: "Bearer", refresh_token: QWEN_ACCESS_ONLY_REFRESH_TOKEN,
        expiry_date: expect.any(Number), resource_url: "portal.example.invalid" });
      expect(statSync(copied).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(experiment.home, "settings.json"), "utf8")).not.toContain("untrusted");
    } finally { experiment.closeSync(); }
    expect(existsSync(experiment.home)).toBe(false);
  }));
  // Review R420 M4: Qwen renames oauth_creds.json on refresh, so a copy or a
  // hard link strands a rotated refresh token. The private home never holds it.
  test("never places the operator refresh token in the private home, and refuses an expired access token", async () => rig(async (h) => {
    writeFileSync(join(h.home, "oauth_creds.json"), login("synthetic-oauth"));
    const experiment = new QwenExperimentRun(spec, h.home, h.home, {}, prompt, {}, h.relay);
    try {
      const bytes = readFileSync(join(experiment.home, "oauth_creds.json"), "utf8");
      expect(bytes).not.toContain("synthetic-refresh-value");
      expect(statSync(join(experiment.home, "oauth_creds.json")).ino).not.toBe(statSync(join(h.home, "oauth_creds.json")).ino);
    } finally { experiment.closeSync(); }
    writeFileSync(join(h.home, "oauth_creds.json"), login("synthetic-oauth", Date.now() - 1));
    const before = readdirSync(join(h.home, ".codemux-experiment"));
    expect(() => new QwenExperimentRun(spec, h.home, h.home, {}, prompt, {}, h.relay)).toThrow("expired access token");
    expect(readdirSync(join(h.home, ".codemux-experiment"))).toEqual(before);
  }));
  test("selects OAuth from the actual child environment when ambient OpenAI credentials are omitted", async () => rig(async (h) => {
    writeFileSync(join(h.home, "oauth_creds.json"), login("synthetic-child-oauth"));
    const experiment = new QwenExperimentRun(spec, h.home, h.home, environment, prompt, {}, h.relay, {});
    try {
      expect(experiment.authType).toBe("qwen-oauth");
      expect(readFileSync(join(experiment.home, "oauth_creds.json"), "utf8")).toContain("synthetic-child-oauth");
    } finally { experiment.closeSync(); }
  }));
  test("folds plain and JSON native results without treating configuration as served identity", () => {
    const request = { agent: "qwen" as const, prompt, model: "requested-alias" };
    const raw = { stdout: stdout(), stderr: "", exitCode: 0, success: true };
    const plain = qwenExperimentResult(raw, request, "recording.jsonl");
    expect(plain).toMatchObject({ stdout: "complete", success: true, servedModel: null });
    const json = qwenExperimentResult(raw, { ...request, resultJson: true }, "recording.jsonl");
    expect(JSON.parse(json.stdout)).toMatchObject({ result: "complete", codemux: { recording: "recording.jsonl", session_id: session,
      model: "requested-alias", served_model: null, usage: { input_tokens: 12, output_tokens: 3, cached_input_tokens: null } } });
    expect(qwenExperimentResult({ ...raw, stdout: "{broken\n\n" }, request, "recording")).toMatchObject({ stdout: "", success: false });
    expect(qwenExperimentResult({ ...raw, stdout: "{broken\n" }, { ...request, resultJson: true }, "recording").success).toBe(false);
  });
});

describe("Qwen project configuration refusal", () => {
  test.each([".env", ".qwen/.env"])("refuses ancestor %s above a nested git boundary", (name) => {
    const home = scratch(), cwd = join(home, "nested", "repo", "work");
    try {
      mkdirSync(cwd, { recursive: true }); mkdirSync(join(home, "nested", "repo", ".git"));
      mkdirSync(join(home, ".qwen")); writeFileSync(join(home, name), "{}");
      expect(() => assertQwenExperimentCwd(cwd)).toThrow(join(home, name));
      expect(() => new QwenExperimentRun(spec, cwd, home, environment, prompt)).toThrow("clean working directory");
      expect(existsSync(join(home, ".codemux-experiment"))).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  // Review R420 M3: Qwen 0.24.0 reads workspace settings from the cwd only,
  // so the operator's own ~/.qwen/settings.json above a project must pass.
  test("accepts an ancestor .qwen/settings.json and refuses one in the cwd", () => {
    const home = scratch(), cwd = join(home, "Programming", "proj");
    try {
      mkdirSync(join(cwd, ".qwen"), { recursive: true }); mkdirSync(join(home, ".qwen"));
      writeFileSync(join(home, ".qwen", "settings.json"), "{}");
      expect(() => assertQwenExperimentCwd(cwd)).not.toThrow();
      writeFileSync(join(cwd, ".qwen", "settings.json"), "{}");
      expect(() => assertQwenExperimentCwd(cwd)).toThrow(`qwen --experiment-mcp requires a clean working directory owned by this run; offending path: ${join(cwd, ".qwen", "settings.json")}`);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  test.each(["symlink", "dangling"])("refuses a %s project settings file", (kind) => {
    const home = scratch();
    try {
      mkdirSync(join(home, ".qwen"));
      if (kind === "symlink") writeFileSync(join(home, "external.json"), "{}");
      symlinkSync(join(home, "external.json"), join(home, ".qwen", "settings.json"));
      expect(() => assertQwenExperimentCwd(home)).toThrow(join(home, ".qwen", "settings.json"));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  test("resolves a symlinked cwd before checking its real ancestors", () => {
    const home = scratch();
    try {
      const real = join(home, "real"), alias = join(home, "alias");
      mkdirSync(join(real, "work"), { recursive: true }); writeFileSync(join(real, ".env"), "synthetic=1");
      symlinkSync(join(real, "work"), alias);
      expect(() => assertQwenExperimentCwd(alias)).toThrow(join(real, ".env"));
      expect(() => assertQwenExperimentCwd(join(home, "missing"))).toThrow("ENOENT");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

test("real Bun fake binary uses the private configuration and records an exact relay call", async () => {
  const home = scratch(), fixture = resolve("tests/fixtures/live/fake-qwen-experiment.ts");
  const runtime = ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`];
  const realSpec = { ...spec, command: process.execPath, args: [...runtime, resolve("tests/fixtures/experiment-mcp.ts")],
    tool_timeout_seconds: 120, recording: join(home, "recordings") };
  const experiment = new QwenExperimentRun(realSpec, home, home, environment, prompt);
  const observed = join(home, "observed.json");
  try {
    await experiment.prepare();
    const adapter = new QwenAdapter((name) => name === "qwen" ? fixture : null, environment);
    const request = { agent: "qwen" as const, prompt, cwd: home, experimentMcp: "synthetic.json", hermetic: true,
      tools: "none" as const, autonomy: "read-only" as const };
    const context = { experimentQwen: experiment, experimentRecording: experiment.recordingPath, stdoutSink: experiment };
    const command = adapter.buildRunCommand(request, context), binaryAt = command.indexOf(fixture);
    expect(binaryAt).toBeGreaterThan(0);
    expect(command.join(" ")).not.toContain(experiment.relay.token);
    command.splice(binaryAt, 1, process.execPath, ...runtime, fixture);
    const result = await runCapturedCommand(command, { cwd: home, timeoutMs: 5000, stdoutSink: experiment,
      stdinInput: prompt, env: { PATH: "/usr/bin:/bin", ...environment, FAKE_QWEN_OBSERVED: observed,
        QWEN_RUNTIME_DIR: "/untrusted/runtime", QWEN_CODE_TRUSTED_FOLDERS_PATH: "/untrusted/trusted.json",
        QWEN_CODE_MCP_APPROVALS_PATH: "/untrusted/approvals.json",
        QWEN_SYSTEM_MD: "untrusted", QWEN_SYSTEM_IDENTITY_MD: "untrusted", QWEN_WRITE_SYSTEM_MD: "untrusted" } });
    expect(result.stderr).toBe(""); expect(result.exitCode).toBe(0);
    await experiment.complete();
    const observation = JSON.parse(readFileSync(observed, "utf8"));
    expect(observation).toMatchObject({ home: experiment.home, prompt, names: ["bash"] });
    expect(experiment.relay.calls).toMatchObject([{ call_id: "native-call-42", name: "bash", input: { command: "constant" },
      result: { content: [{ type: "text", text: "CODEMUX-MCP-RESULT-8B73E209" }] } }]);
    expect(adapter.processRunResult(result, request, context).stdout).toBe("complete");
    expect(JSON.parse(adapter.processRunResult(result, { ...request, resultJson: true }, context).stdout).codemux.recording)
      .toBe(experiment.recordingPath);
    await adapter.cleanupRun(context);
    expect(existsSync(experiment.home)).toBe(false);
    const receipt = readFileSync(experiment.recordingPath, "utf8"), records = receipt.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((r) => r.kind === "qwen_provider_log")).toHaveLength(2);
    expect(records.find((r) => r.kind === "call_ledger")).toMatchObject({ native_call_id: "native-call-42", correlation: "exact" });
    expect(records.find((r) => r.kind === "tool_result_delivered")).toMatchObject({ call_id: "native-call-42" });
    expect(records.at(-1)).toMatchObject({ kind: "run_end", code: null });
    expect(receipt).not.toContain("must-not-retain"); expect(receipt).not.toContain(experiment.relay.token);
  } finally { await experiment.close(); rmSync(home, { recursive: true, force: true }); }
});
