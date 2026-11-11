import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as childProcess from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IDS, getAdapter } from "../src/adapters/index.js";
import type { RunRequest } from "../src/types.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import * as remoteConfig from "../src/opencode-remote-config.js";

// No real credentials or native harnesses: any attempted mutation or spawn
// fails before it happens. Restore the spies even when preparation throws.
function forbidSideEffects() {
  const fail = () => { throw new Error("preview attempted a side effect"); };
  const spies = [
    ...(["mkdirSync", "mkdtempSync", "writeFileSync", "appendFileSync", "linkSync", "symlinkSync",
      "rmSync", "unlinkSync", "chmodSync", "renameSync", "openSync", "readFileSync"] as const).map((name) => spyOn(fs, name).mockImplementation(fail)),
    ...(["spawn", "spawnSync", "execFileSync", "execSync"] as const).map((name) => spyOn(childProcess, name).mockImplementation(fail)),
    spyOn(Bun, "spawn").mockImplementation(fail), spyOn(Bun, "spawnSync").mockImplementation(fail),
  ];
  return () => spies.forEach((spy) => spy.mockRestore());
}

for (const agent of AGENT_IDS) {
  for (const hermetic of [false, true]) {
    test(`${agent} ${hermetic ? "hermetic" : "plain"} preview only builds argv and environment`, () => {
      const environment = { HOME: "/synthetic/preview-home", PATH: "", ZAI_API_KEY: "synthetic",
        [`CODEMUX_${agent.toUpperCase()}_PROVIDER_BASE_URL`]: "https://provider.example/v1",
        [`CODEMUX_${agent.toUpperCase()}_PROVIDER_API_KEY`]: "synthetic",
        [`CODEMUX_${agent.toUpperCase()}_PROVIDER_MODEL`]: "test-model" };
      const adapter = getAdapter(agent, environment);
      if (hermetic && !adapter.capabilities().supportsHermetic) return;
      const request: RunRequest = { agent, prompt: "preview", cwd: process.cwd(), sandboxed: true,
        autonomy: "read-only", hermetic, model: "test-model", resultJson: adapter.capabilities().supportsResultJson };
      const restore = forbidSideEffects();
      try {
        const context = adapter.prepareRun(request, "standard", {}, { printOnly: true });
        expect(adapter.buildRunCommand(request, context).length).toBeGreaterThan(0);
        adapter.getRunEnv(request, context);
        adapter.cleanupRunSync(context);
      } finally { restore(); }
    });
  }
}

test.each([...AGENT_IDS])("%s TUI preview never prepares provider files", (agent) => {
  const adapter = getAdapter(agent, { HOME: "/synthetic/preview-home", PATH: "", ZAI_API_KEY: "synthetic",
    [`CODEMUX_${agent.toUpperCase()}_PROVIDER_BASE_URL`]: "https://provider.example/v1",
    [`CODEMUX_${agent.toUpperCase()}_PROVIDER_API_KEY`]: "synthetic",
    [`CODEMUX_${agent.toUpperCase()}_PROVIDER_MODEL`]: "test-model" });
  const restore = forbidSideEffects();
  try {
    const prepared = adapter.prepareTuiEnvironment("test-model", "read-only", undefined, true, [], true);
    expect(adapter.buildTuiCommand("test-model", "read-only", undefined, true, false, process.cwd(), [], true).length).toBeGreaterThan(0);
    prepared.finalize();
  } finally { restore(); }
});

test.each([...AGENT_IDS])("%s native preview builds its environment without reading credentials", (agent) => {
  const adapter = getAdapter(agent, { HOME: "/synthetic/preview-home", PATH: "" });
  const request: RunRequest = { agent, prompt: "preview", sandboxed: true, autonomy: "read-only" };
  const restore = forbidSideEffects();
  try {
    const context = adapter.prepareRun(request, "standard", {}, { printOnly: true });
    expect(adapter.buildRunCommand(request, context).length).toBeGreaterThan(0);
    adapter.buildExecutionEnv(adapter.getRunEnv(request, context), [], { printOnly: true });
    adapter.cleanupRunSync(context);
  } finally { restore(); }
});

test.each(["claude", "zai"] as const)("%s project-settings preview never creates configuration", (agent) => {
  const cwd = fs.mkdtempSync(join(tmpdir(), "codemux-project-preview-"));
  const adapter = getAdapter(agent, { HOME: "/synthetic/preview-home", PATH: "" });
  const request: RunRequest = { agent, prompt: "preview", cwd, sandboxed: true,
    autonomy: "low", hermetic: true, experimentProjectSettings: true };
  const restore = forbidSideEffects();
  try {
    const context = adapter.prepareRun(request, "standard", {}, { printOnly: true });
    expect(context.claudeProjectConfigDir?.dir).toContain("preview");
    adapter.getRunEnv(request, context);
    adapter.cleanupRunSync(context);
  } finally { restore(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("OpenCode run and TUI preview validation never inspect login configuration", () => {
  const cwd = fs.mkdtempSync(join(tmpdir(), "codemux-preview-validation-"));
  const adapter = getAdapter("opencode", { HOME: cwd, PATH: "",
    CODEMUX_OPENCODE_PROVIDER_BASE_URL: "https://provider.example/v1",
    CODEMUX_OPENCODE_PROVIDER_API_KEY: "synthetic", CODEMUX_OPENCODE_PROVIDER_MODEL: "test-model" });
  const inspect = spyOn(remoteConfig, "opencodeRemoteConfigCarrier").mockImplementation(() => {
    throw new Error("preview inspected login configuration");
  });
  try {
    adapter.validateRunRequest({ agent: "opencode", prompt: "preview", cwd, hermetic: true }, { printOnly: true });
    adapter.validateTuiRequest("test-model", cwd, "read-only", undefined, [], false, { printOnly: true });
    expect(inspect).not.toHaveBeenCalled();
    expect(() => adapter.validateTuiRequest("test-model", cwd)).toThrow("preview inspected login configuration");
  } finally { inspect.mockRestore(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("Pi budget preview does not create extension or evidence files", () => {
  const adapter = getAdapter("pi", { HOME: "/synthetic/preview-home", PATH: "" });
  const request: RunRequest = { agent: "pi", prompt: "preview", maxBudgetUsd: 1, hermetic: true };
  const restore = forbidSideEffects();
  try {
    const context = adapter.prepareRun(request, undefined, undefined, { printOnly: true });
    expect(adapter.buildRunCommand(request, context)).toContain("--extension");
    adapter.cleanupRunSync(context);
  } finally { restore(); }
});

test("Copilot result preview uses RPC without starting its transport", () => {
  const adapter = getAdapter("copilot", { HOME: "/synthetic/preview-home", PATH: "" });
  const request: RunRequest = { agent: "copilot", prompt: "preview", resultJson: true, sandboxed: true };
  const restore = forbidSideEffects();
  try {
    const context = adapter.prepareRun(request, "standard", {}, { printOnly: true });
    const command = adapter.buildRunCommand(request, context);
    expect(command).toContain("--headless");
    expect(command).toContain("--stdio");
    expect(command).not.toContain("--output-format");
    expect(context.stdoutSink).toBeUndefined();
    adapter.cleanupRunSync(context);
  } finally { restore(); }
});

test("Copilot CLI result preview prints its headless RPC command", async () => {
  const cwd = fs.mkdtempSync(join(tmpdir(), "codemux-preview-cli-"));
  const fake = createFakeBinaryEnv({ copilot: 'if [ "$1" = "--binary-version" ]; then echo "Copilot binary version: 1.0.103"; else exit 93; fi', scode: "exit 94" });
  try {
    const result = await runCli(["run", "-a", "copilot", "-s", "--print-sandbox", "--result-json", "--cwd", cwd, "-p", "preview"], fake.env);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain("--headless\n--stdio\n");
    expect(result.stdout).not.toContain("--output-format");
  } finally { fake.cleanup(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("Zai CLI preview needs neither a key file nor an environment credential", async () => {
  const cwd = fs.mkdtempSync(join(tmpdir(), "codemux-preview-zai-"));
  const fake = createFakeBinaryEnv({ claude: 'if [ "$1" = "--version" ]; then echo "2.1.317 (Claude Code)"; else exit 93; fi', scode: "exit 94" });
  try {
    const result = await runCli(["run", "-a", "zai", "-s", "--print-sandbox", "--cwd", cwd, "-p", "preview"],
      { ...fake.env, HOME: cwd, ZAI_API_KEY: "" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("\n-p\n");
    expect(fs.existsSync(join(cwd, ".zai"))).toBe(false);
  } finally { fake.cleanup(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test.each(["pi", "qwen", "gemini", "copilot"] as const)("%s preview preserves provider and effort artifact paths", (agent) => {
  const adapter = getAdapter(agent, { HOME: "/synthetic/preview-home", PATH: "",
    [`CODEMUX_${agent.toUpperCase()}_PROVIDER_BASE_URL`]: "https://provider.example/v1",
    [`CODEMUX_${agent.toUpperCase()}_PROVIDER_API_KEY`]: "synthetic",
    [`CODEMUX_${agent.toUpperCase()}_PROVIDER_MODEL`]: "test-model",
    [`CODEMUX_${agent.toUpperCase()}_PROVIDER_MAX_OUTPUT_TOKENS`]: "100",
    ...(agent === "copilot" ? { CODEMUX_COPILOT_PROVIDER_MAX_CONTEXT_TOKENS: "1000" } : {}) });
  const restore = forbidSideEffects();
  try {
    const prepared = adapter.prepareTuiEnvironment("test-model", "read-only", "high", true, [], true);
    if (agent === "pi") expect(prepared.env.PI_CODING_AGENT_DIR).toContain("preview");
    if (agent === "qwen") expect(prepared.env.QWEN_CODE_SYSTEM_SETTINGS_PATH).toContain("preview");
    if (agent === "gemini") expect(prepared.env.GEMINI_CLI_HOME).toContain("preview");
    if (agent === "copilot") expect(prepared.env.COPILOT_PROVIDERS_CONFIG).toContain("preview");
    prepared.finalize();
  } finally { restore(); }
});
