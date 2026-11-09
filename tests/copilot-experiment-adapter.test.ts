import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CopilotAdapter } from "../src/adapters/copilot.js";
import type { CopilotRunContext } from "../src/copilot-usage.js";
import { experimentCanaryControl } from "../src/experiment-mcp.js";

test("Copilot adapter owns experiment RPC artifacts and preserves a borrowed canary home", async () => {
  const parent = join(process.cwd(), "scratch", "fix", "copilot-synthetic"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "experiment-")), log = spyOn(console, "error").mockImplementation(() => {});
  const adapter = new CopilotAdapter({ HOME: root, CODEMUX_COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:1234",
    CODEMUX_COPILOT_PROVIDER_MODEL: "model", CODEMUX_COPILOT_PROVIDER_MAX_CONTEXT_TOKENS: "2048" });
  const spec = join(root, "spec.json"), recording = join(root, "recordings");
  writeFileSync(spec, JSON.stringify({ name: "test", command: "/synthetic/fake-copilot-mcp", args: [], env: [], recording }));
  const request = { agent: "copilot" as const, prompt: "literal secret", hermetic: true, resultJson: true, experimentMcp: spec };
  try {
    expect(() => adapter.prepareRun({ ...request, hermetic: false })).toThrow("hermetic home");
    expect(() => adapter.prepareCopilotExperiment(request, {})).toThrow("prepared home");
    expect(() => adapter.buildRunCommand(request)).toThrow("not prepared");
    const context = adapter.prepareRun(request), home = context.copilotHermeticHome!.home;
    const command = adapter.buildRunCommand(request, context);
    expect(command).toContain("--headless"); expect(command).toContain("--stdio"); expect(command).toContain("--no-custom-instructions");
    expect(command.join(" ")).not.toContain(request.prompt); expect(context.copilotUsageFile).toBeUndefined();
    expect(context.stdoutSink).toBe(context.experimentCopilot);
    context.experimentCopilot!.usage = { input_tokens: 1, output_tokens: 2, cached_input_tokens: 0, total_tokens: 3, cost_usd: null };
    const raw = { stdout: JSON.stringify({ type: "assistant.message", data: { content: "answer" } }) + "\n", stderr: "", exitCode: 0, success: true };
    const result = adapter.processRunResult(raw, request, context);
    expect(JSON.parse(result.stdout).codemux).toMatchObject({ recording: context.experimentRecording, served_model: null, usage: { total_tokens: 3 } });
    expect(adapter.processRunResult({ ...raw, stdout: "bad wire" }, request, context).success).toBe(false);
    await adapter.cleanupRun(context); expect(existsSync(home)).toBe(false); expect(existsSync(context.copilotProviderFile!.path)).toBe(false);
    const borrowed: CopilotRunContext = { copilotHermeticHome: { home: root, finalize() {} } };
    adapter.prepareCopilotExperiment(experimentCanaryControl(request), borrowed);
    expect(adapter.buildRunCommand(request, borrowed)).not.toContain("--no-custom-instructions");
    expect(borrowed.experimentCopilot!.relay.spec.control).toBe(true);
    await adapter.cleanupRun(borrowed); expect(existsSync(root)).toBe(true);
  } finally { log.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
