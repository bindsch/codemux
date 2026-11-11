import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QwenAdapter } from "../src/adapters/qwen.js";
import { runSessionCommand } from "./helpers/session-command.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { treeSnapshot as snapshot } from "./helpers/tree-snapshot.js";
import type { RunRequest } from "../src/types.js";

const root = mkdtempSync(join(import.meta.dir, "../scratch/qwen-preview-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const provider = {
  CODEMUX_QWEN_PROVIDER_BASE_URL: "https://api.example/v1",
  CODEMUX_QWEN_PROVIDER_API_KEY: "synthetic",
  CODEMUX_QWEN_PROVIDER_MODEL: "synthetic-model",
  CODEMUX_QWEN_PROVIDER_MAX_CONTEXT_TOKENS: "10000",
};
function fixture(name: string, existing: boolean) {
  const home = join(root, name), qwen = join(home, ".qwen"), cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true }); mkdirSync(join(cwd, ".git"));
  if (existing) {
    const stale = join(qwen, ".codemux/effort-2147483647-stale");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "settings.json"), "stale settings must survive\n");
    writeFileSync(join(qwen, "settings.json"), "user settings must survive\n");
    const old = new Date(Date.now() - 4 * 86_400_000);
    utimesSync(stale, old, old);
  }
  return { home, qwen, cwd };
}

for (const existing of [false, true]) {
  for (const mode of ["session", "run", "tui"] as const) {
    for (const setting of ["effort", "provider", "both"] as const) {
      for (const scrub of [false, true]) {
        test(`Qwen ${mode} preview leaves the tree unchanged: ${setting}, existing=${existing}, scrub=${scrub}`, async () => {
          const { home, qwen, cwd } = fixture(`${mode}-${setting}-${existing}-${scrub}`, existing);
          const before = snapshot(home);
          const flags = ["-a", "qwen", "--sandbox", "--print-sandbox", "--cwd", cwd,
            ...(setting !== "provider" ? ["--effort", "low"] : []), ...(scrub ? ["--sandbox-scrub-env"] : [])];
          const binaries = { qwen: 'case "$1" in --version) echo 0.24.0; exit 0;; esac\nexit 99',
            scode: 'if [ "$1" = "--help" ]; then echo --keep-env; exit 0; fi\nexit 99' };
          const env = { HOME: home, QWEN_HOME: qwen, XDG_CONFIG_HOME: join(home, ".config"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
            ...(setting !== "effort" ? provider : {}) };
          const fake = createFakeBinaryEnv(binaries);
          try {
            const result = mode === "session" ? await runSessionCommand(flags, binaries, { env })
              : await runCli([mode, ...flags, ...(mode === "run" ? ["-p", "unused"] : [])], { ...fake.env, ...env });
            expect(result.exitCode, result.stderr).toBe(0);
            expect(result.stdout).toContain("--safe-mode");
            expect(snapshot(home)).toEqual(before);
          } finally { fake.cleanup(); }
        });
      }
    }
  }
}

test.each(["effort", "context", "both"])("Qwen %s preview retains the settings carrier without writes or cleanup", (setting) => {
  const { qwen } = fixture(`adapter-${setting}`, true);
  const adapter = new QwenAdapter(() => "/opt/bin/qwen", { QWEN_HOME: qwen, ...(setting !== "effort" ? provider : {}) });
  const request: RunRequest = { agent: "qwen", prompt: "unused", sandboxed: true,
    ...(setting !== "context" ? { effort: "low" as const } : {}) };
  const before = snapshot(qwen);
  const hooks = process.listenerCount("exit");
  const context = adapter.prepareRun(request, undefined, undefined, { printOnly: true });
  expect(adapter.getRunEnv(request, context).QWEN_CODE_SYSTEM_SETTINGS_PATH).toBe(context.qwenEffortSettings!.path);
  expect(existsSync(context.qwenEffortSettings!.path)).toBe(false);
  adapter.cleanupRunSync(context);
  expect(snapshot(qwen)).toEqual(before);
  expect(process.listenerCount("exit")).toBe(hooks);
});

test("Qwen experiment preparation refuses print-only before creating artifacts", () => {
  const { qwen } = fixture("experiment", false);
  const adapter = new QwenAdapter(() => "/opt/bin/qwen", { QWEN_HOME: qwen });
  expect(() => adapter.prepareRun({ agent: "qwen", prompt: "unused", experimentMcp: "missing.json" },
    undefined, undefined, { printOnly: true })).toThrow("print-only preview");
  expect(existsSync(qwen)).toBe(false);
});

test("Qwen TUI effort preview uses a representative settings path and a no-op finalizer", () => {
  const { qwen } = fixture("tui-effort-path", true);
  const adapter = new QwenAdapter(() => "/opt/bin/qwen", { QWEN_HOME: qwen });
  const before = snapshot(qwen), hooks = process.listenerCount("exit");
  const preview = adapter.prepareTuiEnvironment(undefined, "low", "low", true, [], true);
  expect(preview.env.QWEN_CODE_SYSTEM_SETTINGS_PATH).toBe(join(qwen, ".codemux/effort-preview/settings.json"));
  expect(existsSync(preview.env.QWEN_CODE_SYSTEM_SETTINGS_PATH!)).toBe(false);
  preview.finalize();
  expect(snapshot(qwen)).toEqual(before);
  expect(process.listenerCount("exit")).toBe(hooks);
  const real = adapter.prepareTuiEnvironment(undefined, "low", "low", true, []);
  try {
    expect(Object.keys(real.env).sort()).toEqual(Object.keys(preview.env).sort());
    expect(JSON.parse(readFileSync(real.env.QWEN_CODE_SYSTEM_SETTINGS_PATH!, "utf8")))
      .toMatchObject({ model: { reasoningEffort: "low" } });
  } finally { real.finalize(); }
});

test("session help lists every representative per-turn preview, including Qwen", async () => {
  const result = await runCli(["session", "--help"]);
  expect(result.exitCode).toBe(0);
  const text = result.stdout.replace(/\s+/g, " ");
  expect(text).toContain("representative per-turn command for Aider, Cline, Copilot, Cursor, Droid, Gemini, Goose, Kimi, OpenCode, OpenHands, Pi, or Qwen");
});
