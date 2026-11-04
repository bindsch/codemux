import { expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { createKimiHermeticHome } from "../src/kimi-hermetic.js";
import type { RunRequest, RunResult } from "../src/types.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { KIMI_STREAM_SESSION, kimiResumeHint } from "./fixtures/kimi-stream.js";

function fixture(environment: NodeJS.ProcessEnv = {}) {
  const parent = resolve("scratch/session-14c66a93/exp/kimi-lifecycle");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "run-"));
  const brand = join(home, ".kimi-code");
  const cwd = join(home, "work");
  mkdirSync(join(brand, "credentials"), { recursive: true });
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const adapter = new KimiAdapter({ HOME: home, ...environment }, home);
  const request: RunRequest = { agent: "kimi", prompt: "fixture", cwd, autonomy: "high" };
  return { home, brand, cwd, adapter, request, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const stream = [
  { role: "assistant", content: "OK" },
  kimiResumeHint(),
].map((event) => JSON.stringify(event)).join("\n") + "\n";
const raw: RunResult = { stdout: stream, stderr: "reasoning CODEMUX-CANARY-SYNTHETIC\n", exitCode: 0, success: true };

function writeWire(brand: string): string {
  const path = join(brand, "sessions", "workspace", KIMI_STREAM_SESSION, "agents/main/wire.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ type: "usage.record", usage: { inputOther: 1, output: 1,
    inputCacheRead: 0, inputCacheCreation: 0 } }) + "\n");
  return path;
}

test.each([false, true])("Kimi scans raw stdout and stderr on every plain run; hermetic=%s", (hermetic) => {
  const f = fixture();
  const request = { ...f.request, hermetic };
  const context = f.adapter.prepareRun(request);
  try {
    const result = f.adapter.processRunResult({ ...raw, stdout: "• OK\n" }, request,
      { ...context, harnessVersion: "2.3.2" });
    expect(result.stdout).toBe("OK\n");
    expect(result.scanSurface).toContain(raw.stderr);
    expect(result.scanSurface).toContain("• OK\n");
  } finally { f.adapter.cleanupRunSync(context); f.cleanup(); }
});

test.each([false, true])("Kimi result JSON keeps stderr in the marker scan; hermetic=%s", (hermetic) => {
  const f = fixture();
  const request = { ...f.request, hermetic, resultJson: true };
  const context = f.adapter.prepareRun(request);
  try {
    writeWire(context.kimiHermeticHome?.kimiHome ?? f.brand);
    const result = f.adapter.processRunResult(raw, request, context);
    expect(result.success).toBe(true);
    expect(result.scanSurface).toContain(raw.stderr);
    expect(result.scanSurface).toContain(stream);
  } finally { f.adapter.cleanupRunSync(context); f.cleanup(); }
});

test("Kimi hermetic canary fails when only reasoning on stderr contains the marker", async () => {
  const f = fixture();
  const script = join(f.home, "shim.ts");
  writeFileSync(script, `import {readFileSync} from "node:fs";
import {join,resolve} from "node:path";
if (process.argv[2] === "--version") {console.log("2.3.2");process.exit(0);}
const privateRun=process.argv.includes("--skills-dir");
const brand=process.env.KIMI_CODE_HOME;
const source=privateRun ? resolve(brand,"../../..") : brand;
const marker=readFileSync(join(source,"AGENTS.md"),"utf8").match(/CODEMUX-CANARY-[A-Z0-9]+/)[0];
if (privateRun) console.error("reasoning: " + marker);
console.log("• " + (privateRun ? "OK" : marker) + "\\n");`);
  const fake = createFakeBinaryEnv({ kimi: `exec bun '${script}' "$@"`,
    scode: 'while [ "$1" != "--" ]; do shift; done; shift\nexec "$@"' });
  try {
    const result = await runCli(["check", "-a", "kimi", "--hermetic"], { ...fake.env, HOME: f.home });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("HERMETIC kimi: OK");
    expect(result.stderr).toContain("planted code word reached the model");
  } finally { fake.cleanup(); f.cleanup(); }
});

test("Kimi hermetic config preserves the default provider used by unqualified model aliases", () => {
  const f = fixture();
  writeFileSync(join(f.brand, "config.toml"), `default_provider = "fallback"
default_model = "alias"
[providers.fallback]
type = "openai"
api_key = "synthetic"
[models.alias]
model = "model-name"
max_context_size = 4096
`);
  const home = createKimiHermeticHome(f.brand);
  try {
    const config = Bun.TOML.parse(readFileSync(join(home.kimiHome, "config.toml"), "utf8")) as any;
    expect(config.default_provider).toBe("fallback");
    expect(config.models.alias.provider).toBeUndefined();
    expect(config.providers[config.default_provider].type).toBe("openai");
  } finally { home.finalize(); f.cleanup(); }
});

test("Kimi result JSON reports the provider model when no model flag is passed", () => {
  const f = fixture({ CODEMUX_KIMI_PROVIDER_MODEL: "provider-selected-model",
    CODEMUX_KIMI_PROVIDER_BASE_URL: "https://example.invalid/v1", CODEMUX_KIMI_PROVIDER_API_KEY: "synthetic" });
  try {
    writeWire(f.brand);
    const request = { ...f.request, resultJson: true };
    expect(f.adapter.getRunEnv(request).KIMI_MODEL_NAME).toBe("provider-selected-model");
    const result = f.adapter.processRunResult({ ...raw, stderr: "" }, request);
    expect(result.success).toBe(true);
    expect(JSON.parse(result.stdout).codemux.model).toBe("provider-selected-model");
  } finally { f.cleanup(); }
});

test.each([false, true])("Kimi records private-home cleanup failure before run_end; synchronous=%s", async (synchronous) => {
  const f = fixture();
  const spec = join(f.home, "spec.json");
  writeFileSync(spec, JSON.stringify({ name: "experiment", command: process.execPath,
    args: [resolve("tests/fixtures/experiment-mcp.ts")], env: [], recording: join(f.home, "recordings"),
    accept_harness_prefix: ["kimi-wall-time"] }));
  const context = f.adapter.prepareRun({ ...f.request, hermetic: true, experimentMcp: spec });
  const home = context.kimiHermeticHome!;
  const path = writeWire(home.kimiHome);
  const finalize = home.finalize;
  home.finalize = () => { throw new Error("synthetic private-home removal failure"); };
  try {
    if (synchronous) expect(() => f.adapter.cleanupRunSync(context)).toThrow("synthetic private-home removal failure");
    else await expect(f.adapter.cleanupRun(context)).rejects.toThrow("synthetic private-home removal failure");
    const records = readFileSync(context.experimentRecording!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.find((record) => record.kind === "failure")).toMatchObject({ code: "protocol",
      message: "synthetic private-home removal failure" });
    expect(records.at(-1)).toMatchObject({ kind: "run_end", code: "protocol",
      error: "synthetic private-home removal failure" });
    const copy = records.find((record) => record.kind === "harness_log_copy");
    expect(readFileSync(copy.path, "utf8")).toBe(readFileSync(path, "utf8"));
    expect(existsSync(home.home)).toBe(true);
  } finally { home.finalize = finalize; await context.experimentKimi!.close().catch(() => {}); finalize(); f.cleanup(); }
});

test("Kimi evidence-preservation failure still finalizes the private home (review round 64)", () => {
  const f = fixture();
  const spec = join(f.home, "spec.json");
  writeFileSync(spec, JSON.stringify({ name: "experiment", command: process.execPath,
    args: [resolve("tests/fixtures/experiment-mcp.ts")], env: [], recording: join(f.home, "recordings"),
    accept_harness_prefix: ["kimi-wall-time"] }));
  const context = f.adapter.prepareRun({ ...f.request, hermetic: true, experimentMcp: spec });
  const home = context.kimiHermeticHome!;
  // The copy helper records its own destination failures instead of
  // throwing, so the ordering pin forces the one thrower directly:
  // whatever makes preserveHarnessLog fail, the private home must not
  // survive it, and the failure must still be relayed. Before the fix
  // the throw skipped the finalizer entirely.
  const experiment = context.experimentKimi!;
  const preserve = experiment.preserveHarnessLog;
  let thrown = false;
  experiment.preserveHarnessLog = () => {
    if (thrown) return preserve.call(experiment);
    thrown = true;
    throw new Error("synthetic evidence preservation failure");
  };
  const realHomeFinalize = home.finalize.bind(home);
  let homeFinalized = 0;
  home.finalize = () => { homeFinalized += 1; return realHomeFinalize(); };
  try {
    expect(() => f.adapter.cleanupRunSync(context)).toThrow("synthetic evidence preservation failure");
    expect(homeFinalized).toBe(1);
    expect(existsSync(home.home)).toBe(false);
    const records = readFileSync(context.experimentRecording!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.find((record) => record.kind === "failure" &&
      record.message === "synthetic evidence preservation failure")).toBeDefined();
    expect(records.at(-1)).toMatchObject({ kind: "run_end", error: "synthetic evidence preservation failure" });
  } finally {
    home.finalize = realHomeFinalize;
    f.cleanup();
  }
});

test("Kimi synchronous exit cleanup records interruption before any harness evidence", () => {
  const f = fixture();
  const spec = join(f.home, "spec.json");
  writeFileSync(spec, JSON.stringify({ name: "experiment", command: process.execPath,
    args: [resolve("tests/fixtures/experiment-mcp.ts")], env: [], recording: join(f.home, "recordings"),
    accept_harness_prefix: ["kimi-wall-time"] }));
  const context = f.adapter.prepareRun({ ...f.request, hermetic: true, experimentMcp: spec });
  try {
    f.adapter.cleanupRunSync(context);
    const log = readFileSync(context.experimentRecording!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(log.find((record) => record.kind === "failure")).toMatchObject({ code: "protocol",
      message: "interrupted before harness evidence" });
    expect(log.at(-1)).toMatchObject({ kind: "run_end", code: "protocol", error: "interrupted before harness evidence" });
  } finally { f.cleanup(); }
});

test.each(["SIGINT", "SIGTERM"] as const)("Kimi records an early %s before closing its experiment", async (signal) => {
  const f = fixture();
  const spec = join(f.home, "spec.json"), recording = join(f.home, "recordings"), ready = join(f.home, "ready");
  const script = join(f.home, "waiting-kimi.ts");
  writeFileSync(spec, JSON.stringify({ name: "experiment", command: process.execPath,
    args: [resolve("tests/fixtures/experiment-mcp.ts")], env: [], recording, accept_harness_prefix: ["kimi-wall-time"] }));
  writeFileSync(script, `import {writeFileSync} from "node:fs";
if (process.argv.includes("--version")) {console.log("2.3.2");process.exit(0);}
writeFileSync(${JSON.stringify(ready)},"ready");setInterval(() => {},1000);`);
  const fake = createFakeBinaryEnv({ kimi: `exec bun '${script}' "$@"`,
    scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"' });
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "--config=./bunfig.runtime.toml",
    "src/index.ts", "run", "-a", "kimi", "--hermetic", "--tools", "none", "--experiment-mcp", spec,
    "--cwd", f.cwd, "-p", "fixture"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...fake.env,
    HOME: f.home, CODEMUX_NO_KEYCHAIN_SYNC: "1", CODEMUX_ALLOW_UNTESTED_HARNESS: "" } });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    child.kill(signal);
    expect(await child.exited).toBe(143);
    await output;
    const path = join(recording, readdirSync(recording).find((name) => name.endsWith(".jsonl"))!);
    const log = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(log.find((record) => record.kind === "failure")).toMatchObject({ code: "protocol",
      message: "interrupted before harness evidence" });
    expect(log.at(-1)).toMatchObject({ kind: "run_end", code: "protocol", error: "interrupted before harness evidence" });
  } finally { child.kill(); await child.exited; await output; fake.cleanup(); f.cleanup(); }
}, 15000);

test("two Kimi cleanup failures reach the recording as one failure naming both (review round 69)", () => {
  const f = fixture();
  const spec = join(f.home, "spec.json");
  writeFileSync(spec, JSON.stringify({ name: "experiment", command: process.execPath,
    args: [resolve("tests/fixtures/experiment-mcp.ts")], env: [], recording: join(f.home, "recordings"),
    accept_harness_prefix: ["kimi-wall-time"] }));
  const context = f.adapter.prepareRun({ ...f.request, hermetic: true, experimentMcp: spec });
  const home = context.kimiHermeticHome!;
  const experiment = context.experimentKimi!;
  // closeSync preserves the log once more in cleanupRunSync's finally, so
  // the stub throws only the first time, as the round-64 test does.
  const preserve = experiment.preserveHarnessLog;
  let thrown = false;
  experiment.preserveHarnessLog = () => {
    if (thrown) return preserve.call(experiment);
    thrown = true;
    throw new Error("evidence failure");
  };
  const realHomeFinalize = home.finalize.bind(home);
  home.finalize = () => { throw new Error("home failure"); };
  try {
    let caught: unknown;
    try { f.adapter.cleanupRunSync(context); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as Error).message).toContain("evidence failure");
    expect((caught as Error).message).toContain("home failure");
    const records = readFileSync(context.experimentRecording!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const failure = records.find((record) => record.kind === "failure");
    expect(failure?.message).toContain("evidence failure");
    expect(failure?.message).toContain("home failure");
  } finally {
    home.finalize = realHomeFinalize;
    realHomeFinalize();
    f.cleanup();
  }
});
