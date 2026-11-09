import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ClineAdapter } from "../src/adapters/cline.js";
import { CLINE_DISABLED_NATIVE_TOOLS } from "../src/cline-experiment-policy.js";

let root: string;
let environment: NodeJS.ProcessEnv;
beforeEach(() => {
  mkdirSync("scratch/fix/w1-fixtures", { recursive: true });
  root = mkdtempSync(resolve("scratch/fix/w1-fixtures/cline-tools-"));
  for (const path of ["home/.cline/data/settings", "cwd/.git", "bin"]) mkdirSync(join(root, path), { recursive: true });
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(root, "bin/cline"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve("tests/fixtures/live/fake-cline-parity.ts"))} "$@"\n`);
  chmodSync(join(root, "bin/cline"), 0o700);
  symlinkSync("/usr/bin/env", join(root, "bin/env"));
  environment = { HOME: join(root, "home"), PATH: join(root, "bin"),
    CODEMUX_CLINE_PROVIDER_BASE_URL: "https://fixture.invalid/v1", CODEMUX_CLINE_PROVIDER_API_KEY: "fixture-key",
    CODEMUX_CLINE_PROVIDER_MODEL: "fixture-model" };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

for (const autonomy of ["read-only", "low", "medium", "high"] as const) {
  for (const hermetic of [false, true]) test(`${autonomy} tools-none ${hermetic ? "hermetic" : "plain"} uses native settings`, async () => {
    const source = join(root, "home/.cline/data/settings/global-settings.json");
    writeFileSync(source, JSON.stringify({ rulesEnabled: true, disabledTools: ["custom"], tools: { web_search: { enabled: true } } }));
    const rules = join(root, "cwd/AGENTS.md");
    if (!hermetic) writeFileSync(rules, "Keep these project instructions.\n");
    const adapter = new ClineAdapter(environment);
    const request = { agent: "cline" as const, prompt: "synthetic answer", cwd: join(root, "cwd"), tools: "none" as const,
      autonomy, hermetic, resultJson: true };
    adapter.validateRunRequest(request);
    const context = adapter.prepareRun(request);
    context.harnessVersion = "3.0.74";
    try {
      const env = adapter.getRunEnv(request, context);
      const settings = JSON.parse(readFileSync(env.CLINE_GLOBAL_SETTINGS_PATH!, "utf8"));
      expect(settings.disabledTools).toEqual(hermetic ? [...CLINE_DISABLED_NATIVE_TOOLS] : ["custom", ...CLINE_DISABLED_NATIVE_TOOLS]);
      expect(settings.tools.web_search.enabled).toBe(false);
      expect(JSON.parse(readFileSync(env.CLINE_MCP_SETTINGS_PATH!, "utf8"))).toEqual({ mcpServers: {} });
      expect(settings.rulesEnabled).toBe(hermetic ? undefined : true);
      if (!hermetic) { expect(env.HOME).toBeUndefined(); expect(existsSync(rules)).toBe(true); }
      const command = adapter.resolveExecutionCommand(adapter.buildRunCommand(request, context), request.cwd);
      const child = Bun.spawn(command, { cwd: request.cwd, env: adapter.buildExecutionEnv({ ...env, FIXTURE_TOOLS_NONE: "1" }),
        stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.write(request.prompt); child.stdin.end();
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      expect(adapter.processRunResult({ stdout, stderr, exitCode: 0, success: true }, request).success).toBe(true);
    } finally { adapter.cleanupRunSync(context); }
  });
}

test("tools-none rejects unowned tool channels, configuration overrides, and unaudited versions", () => {
  const adapter = new ClineAdapter(environment);
  const request = { agent: "cline" as const, prompt: "p", tools: "none" as const, cwd: join(root, "cwd") };
  for (const variable of ["CLINE_DIR", "OneDrive"]) {
    expect(() => adapter.validateRunRequest({ ...request, passthroughEnv: [variable] })).toThrow("configuration passthrough");
  }
  const context = adapter.prepareRun(request);
  try {
    for (const version of [undefined, "3.0.73", "3.0.75"]) {
      context.harnessVersion = version;
      expect(() => adapter.buildRunCommand(request, context)).toThrow("requires verified Cline 3.0.74");
    }
  } finally { adapter.cleanupRunSync(context); }
  mkdirSync(join(root, "cwd/.cline/plugins"), { recursive: true });
  expect(() => adapter.validateRunRequest(request)).toThrow("unowned plugin or configured-agent channel");
});
