import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { ExperimentBridge, experimentUserFrameBytes, MAX_EXPERIMENT_MESSAGE_BYTES } from "../src/experiment-bridge.js";
import { ExperimentFailureCode } from "../src/experiment-records.js";
import { readExperimentSpec, validateExperimentRequest, experimentCanaryControl } from "../src/experiment-mcp.js";
import { runCapturedCommand } from "../src/process-runner.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import { plantCanary } from "../src/hermetic-canary.js";
import { MARKER } from "./fixtures/experiment-mcp.js";
import type { RunRequest } from "../src/types.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { launchRunRequest } from "../src/launch.js";
import { cleanupPeers, peer, restores } from "./helpers/experiment-peer.js";
import { ExperimentServer } from "../src/experiment-server.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
afterEach(cleanupPeers);
test("a JSON-RPC response with the wrong ID cannot be associated", async () => {
  const p = peer();
  await p.ready();
  p.request.mockResolvedValue({ jsonrpc: "2.0", id: 999, result: { content: [] } });
  p.call("first");
  p.invoke("first", 10);
  await Promise.resolve();
  await Promise.resolve();
  expect(() => p.bridge.finish()).toThrow("response id mismatch");
});
test("normal completion without a Claude result latches a protocol failure before recording closes", async () => {
  const p = peer();
  await p.ready();
  expect(() => p.bridge.finish({ timedOut: false })).toThrow("no experiment result envelope");
  await expect(p.bridge.closeProtocol()).rejects.toThrow("no experiment result envelope");
  expect(p.records().at(-1)).toMatchObject({ kind: "run_end", code: ExperimentFailureCode.Protocol,
    error: "Claude returned no experiment result envelope" });
});

test.each([{ timedOut: true }, { timedOut: false, aborted: true }])("interrupted completion permits an absent Claude result: %j", async (options) => {
  const p = peer();
  await p.ready();
  expect(p.bridge.finish(options)).toBe("");
  expect(p.bridge.failureCode).toBeNull();
});
test("a later cleanup failure keeps its code while run_end retains the first failure", async () => {
  const p = peer();
  await p.ready();
  expect(() => p.push({ type: "assistant", message: { role: "assistant", content: [
    { type: "tool_use", id: "unknown-call", name: "built_in", input: {} },
  ] } })).toThrow("unknown");
  const close = spyOn(ExperimentServer.prototype, "close").mockImplementation(() => { throw new Error("cleanup failed"); });
  restores.push(() => close.mockRestore());
  await expect(p.bridge.close()).rejects.toThrow("cleanup failed");
  const records = p.records();
  expect(records.filter((record) => record.kind === "failure").map((record) => record.code))
    .toEqual([ExperimentFailureCode.UnknownTool, ExperimentFailureCode.Protocol]);
  expect(records.at(-1)).toMatchObject({ kind: "run_end", code: ExperimentFailureCode.UnknownTool });
});
function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "codemux-bridge-test-"));
  dirs.push(cwd);
  const spec = { name: "experiment", command: process.execPath, args: ["--no-env-file", "--no-install",
    `--config=${resolve("bunfig.runtime.toml")}`, resolve("tests/fixtures/experiment-mcp.ts")], env: [] };
  const path = join(cwd, "spec.json");
  writeFileSync(path, JSON.stringify(spec));
  const request: RunRequest = { agent: "claude", prompt: "probe", cwd, hermetic: true, tools: "none",
    autonomy: "read-only", sandboxed: true, experimentMcp: path };
  return { cwd, spec, path, request };
}
// Recordings follow the ledger's test redirect (tests/setup.ts), so the
// explicit bridge environments below must carry it too.
function bridgeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { CODEMUX_TEST_LEDGER: process.env.CODEMUX_TEST_LEDGER, ...extra };
}

describe("normalized Claude experiment records", () => {
  test("forwards native and common call ID keys before recording the MCP request", async () => {
    const p = peer();
    await p.ready();
    p.call("native-keys");
    p.request.mockResolvedValue({ jsonrpc: "2.0", id: 10, result: { content: [] } });
    p.mcp("native-keys-control", { id: 10, method: "tools/call", params: {
      name: "bash", arguments: {}, _meta: { "claudecode/toolUseId": "native-keys", upstream: "kept" },
    } });
    await Promise.resolve();
    const message = p.request.mock.calls.at(-1)![0];
    expect(message.params._meta).toEqual({ "claudecode/toolUseId": "native-keys", "codemux/callId": "native-keys", upstream: "kept" });
    expect(p.records().find((record) => record.kind === "mcp_request" && record.tool_use_id === "native-keys")?.message).toEqual(message);
  });
  test("emits the first Claude frame immediately and records calls added by later frames", async () => {
    const p = peer();
    await p.ready();
    const call = { type: "tool_use", id: "native-1", name: "mcp__experiment__bash", input: {} };
    const assistant = (content: unknown[], usage: object) => p.push({ type: "assistant", message: {
      id: "message-1", role: "assistant", content, usage,
    } });
    assistant([call], { input_tokens: 11, output_tokens: 1, cache_read_input_tokens: 7 });
    const first = p.records().find((record) => record.kind === "turn");
    expect(first).toMatchObject({ message_id: "message-1", usage: null,
      tool_calls: [{ call_id: "native-1", name: "bash" }] });
    expect(p.records().find((record) => record.kind === "turn_usage")).toBeUndefined();
    assistant([call, { ...call, id: "native-2" }], { output_tokens: 4, cache_creation_input_tokens: 3 });
    assistant([call, { ...call, id: "native-2" }], { output_tokens: 5 });
    p.push({ type: "assistant", message: { id: "message-2", role: "assistant", content: [],
      usage: { input_tokens: 13, output_tokens: 5 } } });
    p.result();
    const turns = p.records().filter((record) => record.kind === "turn");
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual(first);
    expect(turns[1]).toMatchObject({ message_id: "message-2", usage: null, tool_calls: [] });
    expect(turns.every((record) => Number.isFinite(record.t) && record.t > 1_000_000_000)).toBe(true);
    expect(p.records().filter((record) => record.kind === "turn_usage").map(({ message_id, usage }) => ({ message_id, usage }))).toEqual([
      { message_id: "message-1", usage: { input: 11, output: 5, cache_read: 7, cache_write: 3 } }, { message_id: "message-2", usage: { input: 13, output: 5, cache_read: 0, cache_write: 0 } }]);
    expect(p.records().filter((record) => record.kind === "turn_call").map(({ run_id, seq, ...record }) => record)).toEqual([
      { kind: "turn_call", message_id: "message-1", call_id: "native-1", name: "bash", t: first.t },
      { kind: "turn_call", message_id: "message-1", call_id: "native-2", name: "bash", t: expect.any(Number) },
    ]);
    expect(p.records().filter((record) => record.kind === "tool_call")).toHaveLength(2);
  });
  test("records the native ID and receipt time when a result enters a user frame", async () => {
    const p = peer();
    await p.ready();
    p.call("native-1");
    p.request.mockResolvedValue({ jsonrpc: "2.0", id: 10, result: { content: [{ type: "text", text: "output" }] } });
    p.invoke("native-1", 10);
    await Promise.resolve();
    const before = Date.now() / 1000;
    p.delivered("native-1", "output");
    const after = Date.now() / 1000;
    p.result();
    const records = p.records().filter((record) => record.kind === "tool_result_delivered");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ call_id: "native-1", run_id: p.bridge.runId });
    expect(records[0].t).toBeGreaterThanOrEqual(before);
    expect(records[0].t).toBeLessThanOrEqual(after);
  });
  test("a changed result still records model delivery before comparison fails", async () => {
    const p = peer();
    await p.ready();
    p.call("native-1");
    p.request.mockResolvedValue({ jsonrpc: "2.0", id: 10, result: { content: [{ type: "text", text: "original" }] } });
    p.invoke("native-1", 10);
    await Promise.resolve();
    expect(() => p.delivered("native-1", "changed")).toThrow("changed the experiment tool result");
    expect(p.records().find((record) => record.kind === "tool_result_delivered")).toMatchObject({ call_id: "native-1" });
    const comparison = p.records().find((record) => record.kind === "result_comparison");
    expect(comparison).toMatchObject({ equal: false });
    expect(p.bridge.failureCode).toBe(ExperimentFailureCode.ResultChanged);
    expect(p.records().find((record) => record.kind === "failure")).toMatchObject({ code: ExperimentFailureCode.ResultChanged });
  });
});

describe("experiment validation and isolation", () => {
  test("session cleanup tolerates an absent run context", () => {
    expect(() => new ClaudeAdapter({}).cleanupRun()).not.toThrow();
  });
  test("programmatic callers cannot select a looser sandbox or another cwd", async () => {
    const { request } = setup();
    await expect(launchRunRequest(new ClaudeAdapter({}), request, {
      sandbox: true, requestedAutonomy: "high", cwd: request.cwd,
    })).rejects.toThrow("read-only scode");
    await expect(launchRunRequest(new ClaudeAdapter({}), request, {
      sandbox: true, requestedAutonomy: "read-only", cwd: process.cwd(),
    })).rejects.toThrow("working directory");
  });
  test("an omitted launch cwd equals the request's explicit current directory", async () => {
    // The boundary compares effective directories: an omitted options.cwd
    // means the current directory on both sides, so an explicit request cwd
    // naming it must pass the gate. The invalid model stops the launch right
    // after the gate -- before any binary or sandbox is consulted -- so a
    // regressed gate surfaces as "working directory", not this error.
    const { request } = setup();
    request.cwd = process.cwd();
    request.model = "bad\0model";
    await expect(launchRunRequest(new ClaudeAdapter({}), request, {
      sandbox: true, requestedAutonomy: "read-only",
    })).rejects.toThrow("invalid model name");
  });
  test("accepts one explicit server and keeps safe mode plus empty built-in list", () => {
    const { request, spec, path } = setup();
    expect(readExperimentSpec(path)).toEqual(spec);
    const adapter = new ClaudeAdapter({});
    adapter.validateRunRequest(request);
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toContain("--safe-mode");
    expect(cmd[cmd.indexOf("--tools") + 1]).toBe("");
    expect(cmd[cmd.indexOf("--permission-mode") + 1]).toBe("default");
    expect(cmd).toContain("stream-json");
    expect(JSON.parse(cmd[cmd.indexOf("--mcp-config") + 1]!)).toEqual({ mcpServers: { experiment: { type: "sdk", name: "experiment" } } });
  });
  test("zai takes the claude experiment path unchanged: same bridge, flags, safe mode, and envelope", () => {
    // Regression: zai was refused with "no verified experiment MCP mechanism" although it
    // runs the same Claude Code binary and SDK control bridge against the Z.AI endpoint.
    const { request: claudeRequest, spec } = setup();
    const request: RunRequest = { ...claudeRequest, agent: "zai", model: "glm-5.3" };
    // prepareRun opens a recording, so the adapter carries the test ledger redirect (bridgeEnv).
    const adapter = new ZaiAdapter(bridgeEnv());
    expect(() => adapter.validateRunRequest(request)).not.toThrow();
    const context = adapter.prepareRun(request);
    try {
      expect(context.experimentBridge).toBeDefined();
      expect(context.stdoutSink).toBe(context.experimentBridge);
      const cmd = adapter.buildRunCommand(request, context);
      const claudeCmd = new ClaudeAdapter(bridgeEnv()).buildRunCommand(claudeRequest);
      expect(cmd).toContain("--safe-mode");
      expect(cmd[cmd.indexOf("--tools") + 1]).toBe("");
      expect(cmd[cmd.indexOf("--permission-mode") + 1]).toBe("default");
      expect(cmd).toContain("stream-json");
      expect(cmd).toContain("--permission-prompt-tool");
      expect(JSON.parse(cmd[cmd.indexOf("--mcp-config") + 1]!)).toEqual({ mcpServers: { [spec.name]: { type: "sdk", name: spec.name } } });
      // The experiment flags are claude's, in claude's order; only the model pair differs.
      const withoutModel = (argv: string[]) => { const at = argv.indexOf("--model"); return at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)]; };
      expect(withoutModel(cmd)).toEqual(withoutModel(claudeCmd));
    } finally {
      adapter.cleanupRunSync(context);
    }
  });
  test("refuses every attempt to loosen the launch constraints", () => {
    const { request } = setup();
    for (const change of [{ hermetic: false }, { tools: "default" }, { autonomy: "high" }, { sandboxed: false }, { enablePlaywrightMcp: true }]) {
      expect(() => validateExperimentRequest({ ...request, ...change } as RunRequest)).toThrow("requires");
    }
    const control = experimentCanaryControl(request);
    expect(() => validateExperimentRequest(control)).not.toThrow();
    expect(() => validateExperimentRequest({ ...control })).toThrow("requires");
  });
  test("a prompt whose user frame exceeds the control-frame limit is refused before anything is spawned", () => {
    const { request } = setup();
    // The prompt rides a control frame, so the frame's serialized size --
    // not the prompt alone -- is what the 1 MiB bound measures.
    const atLimit = "x".repeat(MAX_EXPERIMENT_MESSAGE_BYTES - experimentUserFrameBytes(""));
    expect(experimentUserFrameBytes(atLimit)).toBe(MAX_EXPERIMENT_MESSAGE_BYTES);
    expect(() => validateExperimentRequest({ ...request, prompt: atLimit })).not.toThrow();
    expect(() => validateExperimentRequest({ ...request, prompt: atLimit + "x" })).toThrow("control frame limit");
  });
  test("rejects malformed schemas, implicit env, and relative executables", () => {
    const { spec, path } = setup();
    for (const change of [{ name: "x;bad" }, { command: "bun" }, { env: { SECRET: "value" } },
      { env: ["X", "X"] }, { env: ["BAD=VALUE"] }, { args: [null] }, { extra: true },
      { recording: "" }, { recording: 5 }, { recording: "with\0nul" }]) {
      writeFileSync(path, JSON.stringify({ ...spec, ...change }));
      expect(() => readExperimentSpec(path)).toThrow("spec requires");
    }
    writeFileSync(path, " ".repeat(65537));
    expect(() => readExperimentSpec(path)).toThrow("65536 bytes");
    expect(() => readExperimentSpec(resolve("tests"))).toThrow("regular file");
  });
  test("recordings live beside the ledger unless the spec relocates them", async () => {
    const { cwd, spec, path } = setup();
    const ledger = process.env.CODEMUX_TEST_LEDGER!;
    const bridge = new ExperimentBridge(spec, cwd, "probe", bridgeEnv());
    try {
      expect(bridge.recordingPath).toBe(join(dirname(ledger), "experiments", `${bridge.runId}.jsonl`));
      expect(statSync(bridge.recordingPath).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(bridge.recordingPath)).mode & 0o777).toBe(0o700);
    } finally { await bridge.close(); }
    const absolute = join(cwd, "custom-recordings");
    writeFileSync(path, JSON.stringify({ ...spec, recording: absolute }));
    const relocated = new ExperimentBridge(readExperimentSpec(path), cwd, "probe", bridgeEnv());
    try { expect(relocated.recordingPath).toBe(join(absolute, `${relocated.runId}.jsonl`)); } finally { await relocated.close(); }
    const second = join(cwd, "spec2.json");
    writeFileSync(second, JSON.stringify({ ...spec, recording: "relative" }));
    const relative = new ExperimentBridge(readExperimentSpec(second), cwd, "probe", bridgeEnv());
    try { expect(relative.recordingPath).toBe(join(cwd, "relative", `${relative.runId}.jsonl`)); } finally { await relative.close(); }
  });
  test("a recording directory supports repeated runs and rejects an existing file before spawn", async () => {
    const { cwd, spec, path, request } = setup();
    const recording = join(cwd, "recordings");
    writeFileSync(path, JSON.stringify({ ...spec, recording }));
    const paths: string[] = [];
    for (let index = 0; index < 2; index++) {
      const bridge = new ExperimentBridge(readExperimentSpec(path), cwd, "probe", bridgeEnv());
      paths.push(bridge.recordingPath);
      await bridge.close();
    }
    expect(new Set(paths).size).toBe(2);
    expect(readdirSync(recording).length).toBe(2);
    expect(statSync(recording).mode & 0o777).toBe(0o700);
    writeFileSync(path, JSON.stringify({ ...spec, recording: paths[0] }));
    const spawn = spyOn(Bun, "spawn");
    try {
      await expect(launchRunRequest(new ClaudeAdapter({}), request,
        { sandbox: true, requestedAutonomy: "read-only", cwd })).rejects.toThrow("recording must name a directory");
      expect(spawn).not.toHaveBeenCalled();
    } finally { spawn.mockRestore(); }
  });
  test("a failed initial recording write closes its descriptor and removes the partial file", () => {
    const { cwd, spec } = setup();
    const recording = join(cwd, "recordings");
    let opened: number | undefined;
    const original = fs.writeSync;
    const write = spyOn(fs, "writeSync").mockImplementation(((fd: number) => {
      opened = fd;
      original(fd, "partial record");
      throw new Error("injected recording write failure");
    }) as typeof fs.writeSync);
    try {
      expect(() => new ExperimentBridge({ ...spec, recording }, cwd, "probe", bridgeEnv()))
        .toThrow("injected recording write failure");
      expect(opened).toBeDefined();
      expect(() => fs.fstatSync(opened!)).toThrow("EBADF");
      expect(readdirSync(recording)).toEqual([]);
    } finally { write.mockRestore(); }
  });
  test("experiment canary fixtures are planted under the temp root and removed, leaving no listeners", () => {
    const caller = mkdtempSync(join(tmpdir(), "codemux-canary-caller-"));
    dirs.push(caller);
    const before = {
      exit: process.listenerCount("exit"),
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
      SIGHUP: process.listenerCount("SIGHUP"),
    };
    const previousCwd = process.cwd();
    process.chdir(caller);
    try {
      const canary = plantCanary(true);
      expect(canary.cwd.startsWith(join(tmpdir(), ".codemux-experiment-check-"))).toBe(true);
      expect(readFileSync(join(canary.cwd, ".claude/skills/canary/SKILL.md"), "utf8")).toContain(canary.marker);
      expect(readFileSync(join(canary.cwd, ".claude/settings.json"), "utf8")).toContain(canary.marker);
      expect(readFileSync(join(canary.cwd, ".mcp.json"), "utf8")).toContain(canary.marker);
      // The invoking directory was never a planting ground.
      expect(readdirSync(caller)).toEqual([]);
      canary.cleanup();
      expect(existsSync(canary.cwd)).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
    expect(readdirSync(caller)).toEqual([]);
    expect(process.listenerCount("exit")).toBe(before.exit);
    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
    expect(process.listenerCount("SIGHUP")).toBe(before.SIGHUP);
  });
});

describe("experiment SDK control round trip", () => {
  async function run(mode: string, timeoutMs = 3000) {
    const { cwd, spec } = setup();
    const bridge = new ExperimentBridge(spec, cwd, "probe", bridgeEnv({ UNNAMED_SECRET: "must-not-inherit" }));
    const operation = runCapturedCommand([process.execPath, "--no-env-file", "--no-install",
      `--config=${resolve("bunfig.runtime.toml")}`, resolve("tests/fixtures/experiment-claude.ts"), mode],
    { cwd, env: {}, stdoutSink: bridge, timeoutMs });
    return { bridge, operation, cwd };
  }
  test("records exact server bytes, native calls, and model-bound results in a private per-run JSONL", async () => {
    const { bridge, operation, cwd } = await run("normal");
    const result = await operation;
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).result).toBe("marker received");
    const records = readFileSync(bridge.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(statSync(bridge.recordingPath).mode & 0o777).toBe(0o600);
    expect(records.every((r) => r.run_id === bridge.runId)).toBe(true);
    const raw = records.filter((r) => r.kind === "server_stdout").map((r) => Buffer.from(r.bytes_base64, "base64").toString()).join("");
    expect(raw).toContain(MARKER);
    expect(records.find((r) => r.kind === "model_tool_result").block.content).toEqual([{ type: "text", text: MARKER }]);
    expect(records.find((r) => r.kind === "result_comparison").equal).toBe(true);
    expect(records.at(-1)).toMatchObject({ kind: "run_end", tool_calls: 1, model_results: 1 });
    // The recording is codemux state, not run-directory output.
    expect(readdirSync(cwd).filter((name) => name.endsWith(".jsonl"))).toHaveLength(0);
  });
  test("server receives only named environment variables and the run cwd", async () => {
    const { cwd, spec } = setup();
    spec.args.push("--inspect");
    const bridge = new ExperimentBridge({ ...spec, env: ["EXPERIMENT_NAMED"] }, cwd, "probe",
      bridgeEnv({ EXPERIMENT_NAMED: "yes", UNNAMED_SECRET: "never" }));
    const result = await runCapturedCommand([process.execPath, "--no-env-file", "--no-install",
      `--config=${resolve("bunfig.runtime.toml")}`, resolve("tests/fixtures/experiment-claude.ts")],
    { cwd, env: {}, stdoutSink: bridge, timeoutMs: 3000 });
    expect(result.exitCode).toBe(0);
    const records = readFileSync(bridge.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const diagnostic = JSON.parse(records.filter((r) => r.kind === "server_stderr").map((r) => Buffer.from(r.bytes_base64, "base64").toString()).join(""));
    expect(diagnostic.cwd).toBe(realpathSync(cwd));
    expect(diagnostic.env_names).toContain("EXPERIMENT_NAMED");
    expect(diagnostic.env_names).not.toContain("UNNAMED_SECRET");
    expect(diagnostic.env_names).not.toContain("HOME");
  });
  test("CLI runs the duplex bridge through scode and returns a structured result", async () => {
    const { cwd, path } = setup();
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const fake = createFakeBinaryEnv({
      claude: `if [ "$1" = "--version" ]; then printf '2.1.280\\n'; exit 0; fi\nexec ${quote(process.execPath)} --no-env-file --no-install --config=${quote(resolve("bunfig.runtime.toml"))} ${quote(resolve("tests/fixtures/experiment-claude.ts"))}`,
      scode: 'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"',
    });
    try {
      const result = await runCli(["run", "-a", "claude", "--hermetic", "--tools", "none", "--experiment-mcp", path,
        "--auto", "read-only", "--cwd", cwd, "--timeout", "5", "--result-json", "-p", "probe"], fake.env);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).result).toBe("marker received");
      const block = JSON.parse(result.stdout).codemux;
      expect(block).toBeDefined();
      expect(block.recording).toMatch(/experiments[/].*\.jsonl$/);
      expect(readdirSync(cwd).filter((name) => name.endsWith(".jsonl"))).toHaveLength(0);
    } finally { fake.cleanup(); }
  });
  test("paired check writes unique probe and control recordings in the specified directory", async () => {
    const { cwd, path, spec } = setup();
    const recording = join(cwd, "recordings");
    writeFileSync(path, JSON.stringify({ ...spec, recording: "recordings" }));
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const fake = createFakeBinaryEnv({
      claude: `if [ "$1" = "--version" ]; then printf '2.1.280\\n'; exit 0; fi
mode=check-control
for arg in "$@"; do if [ "$arg" = "--safe-mode" ]; then mode=check-probe; fi; done
exec ${quote(process.execPath)} --no-env-file --no-install --config=${quote(resolve("bunfig.runtime.toml"))} ${quote(resolve("tests/fixtures/experiment-claude.ts"))} "$mode"`,
      scode: 'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"',
    });
    try {
      const result = await runCli(["check", "-a", "claude", "--hermetic", "--tools", "none",
        "--experiment-mcp", path, "--auto", "read-only", "--timeout", "5"], fake.env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain("HERMETIC claude: OK");
      const files = readdirSync(recording);
      expect(files).toHaveLength(2);
      expect(files.filter((file) => file.endsWith(".control.jsonl"))).toHaveLength(1);
      for (const name of files) {
        const file = join(recording, name);
        expect(result.stderr).toContain(`experiment MCP recording: ${file}`);
        expect(statSync(file).mode & 0o777).toBe(0o600);
        const end = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!);
        expect(end).toMatchObject({ kind: "run_end", result_received: true, error: null });
        expect(name).toBe(`${end.run_id}${name.endsWith(".control.jsonl") ? ".control" : ""}.jsonl`);
      }
      expect(JSON.parse(readFileSync(path, "utf8")).recording).toBe("recordings");
    } finally { fake.cleanup(); }
  });
  test("timeout preserves a partial control frame and returns exit 124", async () => {
    const { bridge, operation } = await run("partial", 500);
    const result = await operation;
    expect(result.exitCode).toBe(124);
    expect(result.success).toBe(false);
    expect(result.stderr).toContain("timed out");
    const records = readFileSync(bridge.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const partial = records.find((record) => record.kind === "control_stdout_partial");
    expect(Buffer.from(partial.bytes_base64, "base64").toString()).toBe('{"type":"control_request"');
    expect(records.at(-1)).toMatchObject({ kind: "run_end", result_received: false, error: null });
  });
  for (const [mode, reason] of [["changed", "changed the experiment"], ["builtin", "advertised set"], ["missing", "without emitting"]]) {
    test(`fails closed on ${mode}`, async () => {
      const { operation } = await run(mode!);
      await expect(operation).rejects.toThrow(reason);
    });
  }
  test("a server failure recorded after Claude's successful finish fails the run", async () => {
    // The fixture's Claude finishes normally but leaves a descendant holding
    // the captured stderr, and the server exits 200 ms after its last reply:
    // the failure lands after finish() succeeded, which must still fail the
    // whole run -- success is decided once, at final protocol cleanup.
    const { bridge, operation } = await run("late-failure", 8000);
    // Which failure lands first -- the stdout closure or the exit event --
    // races inside the bridge; either proves the invariant under test.
    await expect(operation).rejects.toThrow(/experiment MCP (stdout closed before run completion|server exited unexpectedly)/);
    const records = readFileSync(bridge.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const end = records.find((r) => r.kind === "run_end")!;
    expect(end.result_received).toBe(true);
    expect(end.error).toMatch(/stdout closed before run completion|exited unexpectedly/);
    expect(records.find((r) => r.kind === "result_comparison")!.equal).toBe(true);
  }, 15_000);
  test("bounds an unresponsive control peer with the existing timeout", async () => {
    const { operation, bridge } = await run("hang", 100);
    expect((await operation).exitCode).toBe(124);
    expect(readFileSync(bridge.recordingPath, "utf8")).toContain('"result_received":false');
  });
  test("an interrupted experiment check removes its canary fixtures on exit", async () => {
    const { path } = setup();
    const caller = mkdtempSync(join(tmpdir(), "codemux-sigint-caller-"));
    dirs.push(caller);
    const fake = createFakeBinaryEnv({
      claude: `if [ "$1" = "--version" ]; then printf '2.1.280\\n'; exit 0; fi\nsleep 30`,
      scode: 'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"',
    });
    const prefix = ".codemux-experiment-check-";
    const stale = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)));
    const planted = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith(prefix) && !stale.has(name));
    try {
      const proc = Bun.spawn([join(import.meta.dir, "..", "bin", "codemux"), "check", "-a", "claude",
        "--hermetic", "--tools", "none", "--experiment-mcp", path, "--auto", "read-only", "--timeout", "30"], {
        cwd: caller, stdout: "pipe", stderr: "pipe", stdin: "ignore",
        env: { ...process.env, PATH: fake.env.PATH, HOME: caller, XDG_CONFIG_HOME: join(caller, ".config"),
          CODEMUX_NO_KEYCHAIN_SYNC: "1" } as Record<string, string>,
      });
      const drained = new Response(proc.stderr).text();
      const deadline = Date.now() + 15_000;
      while (planted().length === 0 && Date.now() < deadline) await Bun.sleep(100);
      expect(planted().length > 0, "no canary directory appeared in the temp root").toBe(true);
      proc.kill("SIGINT");
      expect(await proc.exited).toBe(143);
      await drained;
      await Bun.sleep(200);
      // Nothing in the temp root, and no canary fixtures in the invoking
      // directory (codemux's own HOME-scoped state may appear there).
      expect(planted()).toEqual([]);
      expect(readdirSync(caller).filter((name) => /^\.?codemux-(experiment-check|canary|agy-check)/.test(name))).toEqual([]);
    } finally { fake.cleanup(); }
  }, 45_000);
});
