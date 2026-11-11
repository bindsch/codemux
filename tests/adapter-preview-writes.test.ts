import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AGENT_IDS, getAdapter } from "../src/adapters/index.js";
import type { AgentId, RunRequest } from "../src/types.js";
import { createFakeBinaryEnv } from "./helpers/cli.js";
import { treeSnapshot } from "./helpers/tree-snapshot.js";
import { preparePiTuiLaunch } from "../src/pi-launch.js";
import { prepareClineTuiLaunch } from "../src/cline-tui.js";
import { PiAdapter } from "../src/adapters/pi.js";
import { ClineAdapter } from "../src/adapters/cline.js";
import { preparePiBudget } from "../src/pi-budget.js";

const root = mkdtempSync(join(import.meta.dir, "../scratch/adapter-preview-"));
const fake = createFakeBinaryEnv(Object.fromEntries([...AGENT_IDS, "playwright-mcp"].map((id) => [id, "exit 99"])));
afterAll(() => { fake.cleanup(); rmSync(root, { recursive: true, force: true }); });

function fixture(agent: AgentId, label: string, provider: boolean) {
  const home = join(root, `${agent}-${label}`), cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true }); mkdirSync(join(cwd, ".git"));
  // Existing private parents must not be swept, chmodded, or touched either.
  for (const dir of [".qwen", ".codex", ".gemini", ".kimi-code", ".copilot", ".factory", ".pi/agent",
    ".cline", ".aider", ".openhands", ".config/goose", ".local/share/opencode"]) {
    const stale = join(home, dir, ".codemux", "provider-2147483647-stale");
    mkdirSync(stale, { recursive: true }); writeFileSync(join(stale, "sentinel"), "preserve");
  }
  const prefix = `CODEMUX_${agent.toUpperCase()}_PROVIDER_`;
  const env = { ...fake.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"),
    ...(provider ? { [`${prefix}BASE_URL`]: "https://provider.invalid/v1", [`${prefix}API_KEY`]: "synthetic",
      [`${prefix}MODEL`]: "synthetic-model" } : {}) };
  return { home, cwd, env, adapter: getAdapter(agent, env) };
}

for (const agent of AGENT_IDS) {
  for (const mode of ["native", "provider", "hermetic", "tools"] as const) {
    const capabilities = getAdapter(agent, {}).capabilities();
    if (mode === "provider" && !capabilities.supportsProviderOverride) continue;
    if (mode === "hermetic" && !capabilities.supportsHermetic) continue;
    test(`${agent} ${mode} preparation, environment, argv, and cleanup leave the directory tree unchanged`, () => {
      const f = fixture(agent, mode, mode === "provider" || (mode === "hermetic" && capabilities.hermeticRequiresProviderOverride === true));
      const request: RunRequest = { agent, prompt: "unused", cwd: f.cwd, sandboxed: true, autonomy: "read-only",
        ...(mode === "hermetic" || (mode === "tools" && agent === "opencode") ? { hermetic: true } : {}),
        ...(mode === "tools" ? { tools: "none" } : {}) };
      const before = treeSnapshot(f.home), listeners = process.listenerCount("exit");
      const context = f.adapter.prepareRun(request, "standard", {}, { printOnly: true });
      if (agent === "cline") context.harnessVersion = "3.0.74";
      try {
        f.adapter.getRunEnv(request, context);
        expect(f.adapter.buildRunCommand(request, context).length).toBeGreaterThan(0);
        expect(treeSnapshot(f.home)).toEqual(before);
      } finally { f.adapter.cleanupRunSync(context); }
      expect(treeSnapshot(f.home)).toEqual(before);
      expect(process.listenerCount("exit")).toBe(listeners);
    });
  }
  if (!getAdapter(agent, {}).capabilities().supportsProviderOverride) continue;
  test(`${agent} provider TUI preparation and cleanup leave the directory tree unchanged`, () => {
    const f = fixture(agent, "tui", true), before = treeSnapshot(f.home);
    const context = f.adapter.prepareTuiEnvironment(undefined, "low", undefined, true, [], true);
    expect(treeSnapshot(f.home)).toEqual(before);
    context.finalize();
    expect(treeSnapshot(f.home)).toEqual(before);
  });
}

for (const agent of ["pi", "cline"] as const) {
  test(`${agent} Playwright TUI preview leaves the directory tree unchanged`, () => {
    const f = fixture(agent, "playwright-tui", true), before = treeSnapshot(f.home);
    const input = { cwd: f.cwd, autonomy: "low" as const, sandboxed: true, enablePlaywrightMcp: true, printOnly: true };
    const launch = agent === "pi" ? preparePiTuiLaunch(f.adapter as PiAdapter, input)
      : prepareClineTuiLaunch(f.adapter as ClineAdapter, input, {});
    expect(launch.playwrightCheck).toBeDefined();
    expect(treeSnapshot(f.home)).toEqual(before);
    launch.cleanup();
    expect(treeSnapshot(f.home)).toEqual(before);
  });
}

for (const agent of ["agy", "cline", "gemini", "kimi", "pi", "openhands"] as const) {
  test(`${agent} Playwright run preview leaves the directory tree unchanged`, () => {
    const f = fixture(agent, "playwright-run", true), before = treeSnapshot(f.home);
    const request: RunRequest = { agent, prompt: "unused", cwd: f.cwd, autonomy: "low", sandboxed: true,
      enablePlaywrightMcp: true, ...(agent === "openhands" ? { hermetic: true } : {}) };
    const context = f.adapter.prepareRun(request, "standard", {}, { printOnly: true });
    try {
      f.adapter.buildRunCommand(request, context);
      expect(context.playwrightMcpCheck).toBeDefined();
      expect(treeSnapshot(f.home)).toEqual(before);
    } finally { f.adapter.cleanupRunSync(context); }
    expect(treeSnapshot(f.home)).toEqual(before);
  });
}

for (const agent of ["claude", "zai", "codex", "opencode"] as const) {
  test(`${agent} project-settings run preview leaves the directory tree unchanged`, () => {
    const f = fixture(agent, "project-settings", true), before = treeSnapshot(f.home);
    // These modes refuse every ancestor instruction file, including the operator's HOME.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-preview-project-")), projectBefore = treeSnapshot(cwd);
    const request: RunRequest = { agent, prompt: "unused", cwd, autonomy: "low", sandboxed: true,
      hermetic: true, experimentProjectSettings: true };
    try {
      const context = f.adapter.prepareRun(request, "standard", {}, { printOnly: true });
      try { f.adapter.getRunEnv(request, context); expect(treeSnapshot(f.home)).toEqual(before); }
      finally { f.adapter.cleanupRunSync(context); }
      expect(treeSnapshot(f.home)).toEqual(before);
      expect(treeSnapshot(cwd)).toEqual(projectBefore);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}

test("Pi budget preview carries artifact paths without creating evidence or extension files", () => {
  const f = fixture("pi", "budget", false), before = treeSnapshot(f.home);
  const context = preparePiBudget({ agent: "pi", prompt: "unused", maxBudgetUsd: 1 }, {}, join(f.home, ".pi/agent"), true);
  expect(context.piBudget?.path).toEndWith("budget.mjs");
  expect(treeSnapshot(f.home)).toEqual(before);
  context.piBudget!.directory.finalize();
  expect(treeSnapshot(f.home)).toEqual(before);
});
