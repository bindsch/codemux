import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { MARKER } from "./fixtures/experiment-mcp.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const fixture = resolve("tests/fixtures/experiment-kimi.ts");
const runtime = resolve("bunfig.runtime.toml");

function setup(scenario = "clean", structured = false, serverMode?: string) {
  const parent = resolve("scratch/session-14c66a93/exp/kimi-synthetic");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "case-"));
  const home = join(root, "operator");
  const cwd = join(root, "work");
  const recording = join(root, "records");
  mkdirSync(join(home, ".kimi-code", "credentials"), { recursive: true });
  mkdirSync(join(cwd, ".git"), { recursive: true });
  writeFileSync(join(home, ".kimi-code", "credentials", "kimi.json"), "synthetic");
  const spec = join(root, "spec.json");
  writeFileSync(spec, JSON.stringify({ name: "experiment", command: process.execPath,
    args: ["--no-env-file", "--no-install", `--config=${runtime}`,
      structured || serverMode ? fixture : resolve("tests/fixtures/experiment-mcp.ts"),
      ...(structured ? ["--server-structured"] : serverMode ? [`--server-${serverMode}`] : [])],
    env: [], recording, accept_harness_prefix: ["kimi-wall-time"] }));
  const fake = createFakeBinaryEnv({ kimi: `exec ${quote(process.execPath)} --no-env-file --no-install --config=${quote(runtime)} ${quote(fixture)} --scenario ${quote(scenario)} "$@"`,
    scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"' });
  const env = { ...fake.env, HOME: home, CODEMUX_ALLOW_UNTESTED_HARNESS: "" };
  const flags = ["-a", "kimi", "--hermetic", "--tools", "none", "--experiment-mcp", spec];
  return { root, recording, home, cwd, spec, env, fake, flags };
}

function records(directory: string) {
  const names = readdirSync(directory);
  return names.filter((name) => /^[0-9a-f-]+(?:\.control)?\.jsonl$/.test(name)).map((name) =>
    readFileSync(join(directory, name), "utf8").trim().split("\n").map((line) => JSON.parse(line)));
}

test.each([true, false])("Kimi synthetic experiment records a clean run in order; resultJson=%s", async (resultJson) => {
  const f = setup();
  try {
    const result = await runCli(["run", ...f.flags, "--cwd", f.cwd, "-p", "fixture", ...(resultJson ? ["--result-json"] : [])], f.env);
    expect(result.stderr).not.toContain("experiment failure");
    expect(result.exitCode, result.stderr).toBe(0);
    if (resultJson) {
      const envelope = JSON.parse(result.stdout);
      expect(envelope.reply).toBe("OK\n");
      expect(envelope.codemux.failure_code).toBeNull();
      expect(existsSync(envelope.codemux.recording)).toBe(true);
    } else expect(result.stdout).toBe("OK\n");
    const log = records(f.recording)[0]!;
    expect(log.at(-1)).toMatchObject({ kind: "run_end", code: null, error: null });
    expect(log.filter((r: any) => r.kind === "turn")).toMatchObject([
      { message_id: "step-1", t: 1.1, usage: null, tool_calls: [{ call_id: "native-call-1", name: "bash" }] },
      { message_id: "step-2", t: 1.4, usage: null, tool_calls: [] },
    ]);
    expect(log.filter((r: any) => r.kind === "turn_call")).toMatchObject([
      { message_id: "step-1", call_id: "native-call-1", name: "bash", t: 1.1 },
    ]);
    expect(log.filter((r: any) => r.kind === "turn_usage")).toMatchObject([
      { message_id: "step-1", t: 1.3, usage: { input: 10, output: 5, cache_read: 20, cache_write: 0 } },
      { message_id: "step-2", t: 1.5, usage: { input: 10, output: 5, cache_read: 20, cache_write: 0 } },
    ]);
    expect(log.filter((r: any) => r.kind === "harness_stdout")).toHaveLength(4);
    expect(log.find((r: any) => r.kind === "harness_tool_result")).toMatchObject({ tool_call_id: "native-call-1", content: MARKER });
    expect(log.find((r: any) => r.kind === "model_tool_result")).toMatchObject({
      content: [{ type: "text", text: `Wall time: 0.001 seconds\n${MARKER}` }], wire_content: [{ type: "text", text: MARKER }],
    });
    expect(log.find((r: any) => r.kind === "result_comparison")).toMatchObject({ equal: true,
      harness_prefix: "kimi-wall-time", header: "Wall time: 0.001 seconds\n" });
    const dispatch = log.find((r: any) => r.kind === "mcp_request" && r.message.method === "tools/call");
    expect(dispatch.message.params._meta["codemux/callId"]).toBe("native-call-1");
    expect(log.findIndex((r: any) => r.kind === "turn")).toBeLessThan(log.indexOf(dispatch));
    expect(log.findIndex((r: any) => r.kind === "turn_call")).toBeLessThan(log.indexOf(dispatch));
    expect(log.indexOf(dispatch)).toBeLessThan(log.findIndex((r: any) => r.kind === "turn_usage"));
    expect(log.findIndex((r: any) => r.kind === "tool_inventory")).toBeLessThan(log.findIndex((r: any) => r.kind === "tool_call_identified"));
    expect(log.findIndex((r: any) => r.kind === "tool_call_identified")).toBeLessThan(log.indexOf(dispatch));
  } finally { f.fake.cleanup(); }
});

test("Kimi synthetic error result preserves the exact projected error status", async () => {
  const f = setup("clean", false, "error");
  try {
    const result = await runCli(["run", ...f.flags, "--cwd", f.cwd, "-p", "fixture", "--result-json"], f.env);
    expect(result.exitCode, result.stderr).toBe(0);
    const log = records(f.recording)[0]!;
    expect(log.find((r: any) => r.kind === "model_tool_result")).toMatchObject({
      content: [{ type: "text", text: `Wall time: 0.001 seconds\n<system>ERROR: Tool execution failed.</system>\n${MARKER}` }],
      wire_content: [{ type: "text", text: MARKER }],
    });
    expect(log.find((r: any) => r.kind === "result_comparison")).toMatchObject({ equal: true });
  } finally { f.fake.cleanup(); }
});

test("Kimi synthetic empty result refuses before HTTP delivery or model context", async () => {
  const f = setup("clean", false, "empty");
  try {
    const result = await runCli(["run", ...f.flags, "--cwd", f.cwd, "-p", "fixture", "--result-json"], f.env);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("codemux: experiment failure [unsupported_result]:");
    const log = records(f.recording)[0]!;
    const raw = log.findIndex((r: any) => r.kind === "server_tool_result");
    expect(raw).toBeGreaterThan(0);
    expect(log.slice(raw + 1).some((r: any) => r.kind === "http_response" && r.status === 200)).toBe(false);
    expect(log.some((r: any) => r.kind === "tool_result_delivered" || r.kind === "model_tool_result")).toBe(false);
    expect(log.at(-1)).toMatchObject({ kind: "run_end", code: "unsupported_result" });
  } finally { f.fake.cleanup(); }
});

test.each([
  ["changed-result", false, "result_changed"],
  ["unknown-tool", false, "unknown_tool"],
  ["missing-snapshot", false, "inventory_mismatch"],
  ["missing-log", false, "harness_log_missing"],
  ["missing-hint", false, "protocol"],
  ["empty-reply", false, "protocol"],
  ["clean", true, "unsupported_result"],
])("Kimi synthetic %s structured=%s fails with %s", async (scenario, structured, code) => {
  const f = setup(scenario as string, structured as boolean);
  try {
    const result = await runCli(["run", ...f.flags, "--cwd", f.cwd, "-p", "fixture", "--result-json"], f.env);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`codemux: experiment failure [${code}]:`);
    expect(JSON.parse(result.stdout).codemux.failure_code).toBe(code);
    const log = records(f.recording)[0]!;
    expect(log.at(-1)).toMatchObject({ kind: "run_end", code });
    expect(log.find((r: any) => r.kind === "failure")).toMatchObject({ code });
  } finally { f.fake.cleanup(); }
});

test("Kimi experiment check runs the home-planted pair through the synthetic relay", async () => {
  const f = setup();
  try {
    const result = await runCli(["check", ...f.flags], f.env);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("HERMETIC kimi: OK\n");
    expect(result.stderr).toContain("control: planted code word reached the model");
    const logs = records(f.recording);
    expect(logs).toHaveLength(2);
    for (const log of logs) {
      expect(log.at(-1)).toMatchObject({ kind: "run_end", code: null, error: null });
      expect(log.find((r: any) => r.kind === "result_comparison").equal).toBe(true);
    }
  } finally { f.fake.cleanup(); }
});

test("Kimi paired experiment control writes only to the planted home and removes it with a real-home guard", async () => {
  const f = setup();
  const brand = join(f.home, ".kimi-code"), canaryParent = join(brand, ".codemux-canary");
  const guard = join(brand, "mcp.json"), audit = join(f.root, "home-audit.jsonl"), shim = join(f.root, "audit-kimi.ts");
  const original = '{"mcpServers":{"operator":{"command":"do-not-run"}}}\n';
  writeFileSync(guard, original, { mode: 0o400 });
  mkdirSync(canaryParent, { mode: 0o700 });
  chmodSync(brand, 0o500);
  writeFileSync(shim, `import {appendFileSync,readFileSync} from "node:fs";
import {join} from "node:path";
if(!process.argv.includes("--version")) {
  const brand=process.env.KIMI_CODE_HOME;
  const config=JSON.parse(readFileSync(join(brand,"mcp.json"),"utf8"));
  appendFileSync(${JSON.stringify(audit)},JSON.stringify({brand,config,hermetic:process.argv.includes("--skills-dir")})+"\\n");
}
await import(${JSON.stringify(fixture)});`);
  const fake = createFakeBinaryEnv({ kimi: `exec ${quote(process.execPath)} --no-env-file --no-install --config=${quote(runtime)} ${quote(shim)} --scenario clean "$@"`,
    scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"' });
  try {
    const result = await runCli(["check", ...f.flags], { ...f.env, ...fake.env });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("HERMETIC kimi: OK\n");
    const homes = readFileSync(audit, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(homes).toHaveLength(2);
    expect(homes.map((entry) => entry.hermetic)).toEqual([true, false]);
    const control = homes[1]!;
    expect(control.brand.startsWith(join(canaryParent, "run-"))).toBe(true);
    expect(control.brand).not.toBe(brand);
    expect(control.config.mcpServers.experiment.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(control.config.mcpServers.experiment.headers.Authorization).toMatch(/^Bearer [a-f0-9]+$/);
    for (const entry of homes) expect(existsSync(entry.brand)).toBe(false);
    expect(existsSync(resolve(control.brand, "../.."))).toBe(false);
    expect(readdirSync(canaryParent)).toEqual([]);
    expect(readFileSync(guard, "utf8")).toBe(original);
    expect(readdirSync(brand).sort()).toEqual([".codemux-canary", "credentials", "mcp.json"]);
  } finally { chmodSync(brand, 0o700); fake.cleanup(); f.fake.cleanup(); }
});

test.each(["run", "check"])("Kimi experiment %s refuses no-net before running the shim", async (command) => {
  const f = setup();
  try {
    const result = await runCli([command, ...f.flags, "--sandbox-no-net", ...(command === "run" ? ["-p", "fixture"] : [])], f.env);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--sandbox-no-net");
    expect(existsSync(f.recording)).toBe(false);
  } finally { f.fake.cleanup(); }
});

test("Kimi experiment refuses 2.3.1 before the synthetic run starts", async () => {
  const f = setup("old-version");
  try {
    const result = await runCli(["run", ...f.flags, "--cwd", f.cwd, "-p", "fixture"], f.env);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("2.3.1 is older than");
    expect(result.stderr).toContain("2.3.2");
    if (existsSync(f.recording)) {
      for (const log of records(f.recording)) expect(log.some((r: any) => r.kind === "http_request")).toBe(false);
    }
  } finally { f.fake.cleanup(); }
});
