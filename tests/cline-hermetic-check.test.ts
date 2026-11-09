import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ClineAdapter } from "../src/adapters/cline.js";
import { CLINE_INSTRUCTION_CHANNEL } from "../src/cline-isolation-probe.js";
import { createHermeticCheckPlan } from "../src/check-hermetic-plan.js";
import { HERMETIC_CHECK_CHANNELS } from "../src/hermetic-check-channels.js";
import type { ClineRunContext } from "../src/cline-config.js";

test("Cline's proposed instruction channel separates probe HOME from control HOME", () => {
  mkdirSync("scratch/fix/w1-fixtures", { recursive: true });
  const root = mkdtempSync(resolve("scratch/fix/w1-fixtures/cline-check-"));
  const channels = HERMETIC_CHECK_CHANNELS as Record<string, unknown>;
  const old = channels.cline;
  channels.cline = CLINE_INSTRUCTION_CHANNEL;
  const adapter = new ClineAdapter({ HOME: root, PATH: "",
    CODEMUX_CLINE_PROVIDER_BASE_URL: "https://fixture.invalid/v1",
    CODEMUX_CLINE_PROVIDER_API_KEY: "fixture-key", CODEMUX_CLINE_PROVIDER_MODEL: "fixture-model" });
  try {
    const plan = createHermeticCheckPlan(adapter, { agent: "cline", prompt: "p" }, { sandbox: true, requestedAutonomy: "read-only" });
    try {
      const home = plan.canary.home!;
      expect(readFileSync(join(home, ".agents/AGENTS.md"), "utf8")).toContain(plan.canary.marker);
      expect(plan.probe.request.cwd).toBe(plan.control.request.cwd);
      expect(plan.probe.request.hermetic).toBe(true);
      expect(plan.control.request.hermetic).toBe(false);
      for (const [entry, privateHome] of [[plan.probe, true], [plan.control, false]] as const) {
        entry.adapter.validateRunRequest(entry.request);
        const prepared = entry.adapter.prepareRun(entry.request) as ClineRunContext;
        try {
          const command = entry.adapter.buildRunCommand(entry.request, prepared);
          expect(command[0]).toBe("env");
          expect(command[1]).toBe(`HOME=${privateHome ? prepared.clineConfig!.home : home}`);
          expect(command.filter((arg) => arg.startsWith("HOME="))).toHaveLength(1);
        } finally { entry.adapter.cleanupRun(prepared); }
      }
    } finally { plan.canary.cleanup(); }
  } finally {
    if (old === undefined) delete channels.cline; else channels.cline = old;
    rmSync(root, { recursive: true, force: true });
  }
});
