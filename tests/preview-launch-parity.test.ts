import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import { CopilotAdapter } from "../src/adapters/copilot.js";
import { DroidAdapter } from "../src/adapters/droid.js";
import { treeSnapshot } from "./helpers/tree-snapshot.js";
import type { RunRequest } from "../src/types.js";

const root = mkdtempSync(join(import.meta.dir, "../scratch/preview-launch-parity-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function environment(agent: string, label: string) {
  const home = join(root, `${agent}-${label}`); mkdirSync(home);
  const prefix = `CODEMUX_${agent.toUpperCase()}_PROVIDER_`;
  return { HOME: home, [`${prefix}BASE_URL`]: "https://provider.invalid/v1",
    [`${prefix}API_KEY`]: "synthetic", [`${prefix}MODEL`]: "synthetic-model" };
}

test.each([false, true])("Gemini JSON preview preserves real argv and telemetry environment, hermetic=%s", (hermetic) => {
  const env = environment("gemini", String(hermetic)), adapter = new GeminiAdapter(env);
  const request: RunRequest = { agent: "gemini", prompt: "unused", resultJson: true, hermetic };
  const before = treeSnapshot(env.HOME);
  const preview = adapter.prepareRun(request, undefined, undefined, { printOnly: true });
  const previewHome = preview.geminiHermeticHome!.home;
  expect(preview.geminiTelemetryPath).toBe(join(previewHome, "codemux-telemetry.json"));
  expect(existsSync(previewHome)).toBe(false);
  adapter.cleanupRunSync(preview);
  expect(treeSnapshot(env.HOME)).toEqual(before);
  const real = adapter.prepareRun(request);
  try {
    const normalize = (value: unknown) => JSON.stringify(value).replaceAll(real.geminiHermeticHome!.home, previewHome);
    expect(normalize(adapter.buildRunCommand(request, real))).toBe(JSON.stringify(adapter.buildRunCommand(request, preview)));
    expect(normalize(adapter.getRunEnv(request, real))).toBe(JSON.stringify(adapter.getRunEnv(request, preview)));
    expect(existsSync(real.geminiTelemetryPath!)).toBe(true);
    expect(readFileSync(real.geminiTelemetryPath!, "utf8")).toBe("");
  } finally { adapter.cleanupRunSync(real); }
});

for (const resultJson of [false, true]) {
  for (const capped of [false, true]) {
    test(`Copilot preview matches real launch argv, JSON=${resultJson}, capped provider=${capped}`, () => {
      const env = { ...environment("copilot", `${resultJson}-${capped}`),
        ...(capped ? { CODEMUX_COPILOT_PROVIDER_MAX_CONTEXT_TOKENS: "10000" } : {}) };
      const adapter = new CopilotAdapter(env), request: RunRequest = { agent: "copilot", prompt: "unused", resultJson };
      const before = treeSnapshot(env.HOME);
      const preview = adapter.prepareRun(request, undefined, undefined, { printOnly: true });
      if (resultJson) adapter.prepareCopilotModelRun(request, preview, true);
      expect(preview.copilotModelRun).toBeUndefined();
      const argv = adapter.buildRunCommand(request, preview);
      if (resultJson) { expect(argv).toContain("--headless"); expect(argv).toContain("--stdio"); }
      if (capped && !resultJson) expect(argv).toContain("codemux/model");
      adapter.cleanupRunSync(preview);
      expect(treeSnapshot(env.HOME)).toEqual(before);
      const real = adapter.prepareRun(request);
      try {
        if (resultJson) adapter.prepareCopilotModelRun(request, real);
        const normalize = (arg: string) => capped ? arg.replaceAll(real.copilotProviderFile!.path, preview.copilotProviderFile!.path) : arg;
        expect(adapter.buildRunCommand(request, real).map(normalize)).toEqual(argv);
      } finally { adapter.cleanupRunSync(real); }
    });
  }
}

test("Droid TUI preview keeps the real settings carrier without creating or cleaning state", () => {
  const env = environment("droid", "tui"), adapter = new DroidAdapter(env);
  const before = treeSnapshot(env.HOME), hooks = process.listenerCount("exit");
  const preview = adapter.prepareTuiCommand("synthetic-model", "low", "high", true);
  expect(treeSnapshot(env.HOME)).toEqual(before);
  expect(process.listenerCount("exit")).toBe(hooks);
  const real = adapter.buildTuiCommand("synthetic-model", "low", "high");
  const path = real[real.indexOf("--settings") + 1]!;
  expect(real.map((arg) => arg === path ? preview[preview.indexOf("--settings") + 1]! : arg)).toEqual(preview);
  expect(JSON.parse(readFileSync(path, "utf8")).sessionDefaultSettings).toMatchObject({ reasoningEffort: "high" });
  // The real builder owns an exit-hook cleanup. Keep its directory until
  // that hook runs; afterAll removes this test's surrounding fixture.
  expect(existsSync(dirname(path))).toBe(true);
});
