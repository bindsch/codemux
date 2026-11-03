import { expect, spyOn, test } from "bun:test";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import * as runtime from "../src/cli-runtime.js";
import { launchRunRequest } from "../src/launch.js";
import type { RunRequest } from "../src/types.js";

test.each([
  { agent: "zai", model: undefined, expected: "opus" },
  { agent: "zai", model: "", expected: "opus" },
  { agent: "zai", model: "selected-model", expected: "selected-model" },
  { agent: "claude", model: undefined, expected: "provider-model" },
  { agent: "claude", model: "selected-model", expected: "selected-model" },
] as const)("early $agent capture failure reports effective model $expected", async ({ agent, model, expected }) => {
  const adapter = agent === "zai" ? new ZaiAdapter({}) : new ClaudeAdapter({
    CODEMUX_CLAUDE_PROVIDER_BASE_URL: "https://example.invalid/v1",
    CODEMUX_CLAUDE_PROVIDER_API_KEY: "synthetic", CODEMUX_CLAUDE_PROVIDER_MODEL: "provider-model",
  });
  const request: RunRequest = { agent, prompt: "fixture", resultJson: true, experimentMcp: "synthetic.json",
    hermetic: true, sandboxed: true, tools: "none", model };
  const spies = [
    spyOn(adapter, "validateRunRequest").mockImplementation(() => {}),
    spyOn(adapter, "prepareRun").mockReturnValue({ experimentRecording: "/synthetic/recording.jsonl" }),
    spyOn(adapter, "getRunEnv").mockReturnValue({}),
    spyOn(adapter, "buildRunCommand").mockReturnValue(["synthetic"]),
    spyOn(adapter, "cleanupRun").mockImplementation(async () => {}),
    spyOn(runtime, "assertHarnessSupported").mockResolvedValue("2.1.280"),
    spyOn(runtime, "runSandboxedWithStdin").mockRejectedValue(new Error("synthetic capture failure")),
  ];
  try {
    const result = await launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only" });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ result: null, codemux: {
      agent, model: expected, failure_code: "protocol",
    } });
  } finally { for (const spy of spies.reverse()) spy.mockRestore(); }
});
