import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { QwenAdapter } from "../src/adapters/qwen.js";
import { PARITY } from "../src/parity/index.js";
import { normalizeClineUsage } from "../src/result-envelope/cline.js";
import { parseQwenResultEnvelope, qwenResult } from "../src/result-envelope/qwen.js";
import { DROID_DRIVER_PROFILE } from "../src/session/droid-driver.js";
import { QWEN_DRIVER_PROFILE } from "../src/session/qwen-driver.js";
import { CURSOR_DRIVER_PROFILE } from "../src/session/cursor-driver.js";
import { COPILOT_DRIVER_PROFILE } from "../src/session/copilot-driver.js";
import { PI_DRIVER_PROFILE } from "../src/session/pi-driver.js";
import { GOOSE_DRIVER_PROFILE } from "../src/session/goose-driver.js";
import { OPENHANDS_DRIVER_PROFILE } from "../src/session/openhands-driver.js";
import { GEMINI_DRIVER_PROFILE } from "../src/session/gemini-driver.js";
import { engineSession, fakeTurnProcess } from "./helpers/session-turn-engine.js";

const id = "11111111-2222-4333-8444-555555555555";
const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");

test.each([{ hermetic: true }, { web: false }])("legacy Qwen refuses unsupported restrictions %j", (restriction) => {
  const adapter = new QwenAdapter((name) => name === "qwen-coder" ? "/fake/qwen-coder" : null, {});
  const request = { agent: "qwen" as const, prompt: "p", sandboxed: true, ...restriction };
  expect(() => adapter.validateRunRequest(request)).toThrow();
  expect(() => adapter.buildRunCommand(request)).toThrow();
});

test("Qwen configuration model fields never become provider identity", () => {
  for (const assistant of [
    { type: "assistant", message: { role: "assistant", model: "configured", content: [{ type: "text", text: "Done" }] } },
    { type: "assistant", model: "invented-top-level", message: { content: [{ type: "text", text: "Done" }] } },
  ]) {
    const stdout = lines(assistant, { type: "result", subtype: "success", result: "Done", session_id: id });
    expect(parseQwenResultEnvelope(stdout)?.servedModel).toBeNull();
    const result = qwenResult({ stdout, stderr: "", exitCode: 0, success: true }, { agent: "qwen", prompt: "p" });
    expect(result.servedModel).toBeNull();
    expect(JSON.parse(result.stdout).codemux.served_model).toBeNull();
  }
  expect(PARITY.qwen["run.served-model-evidence"].state).toBe("harness-limitation");
  expect(PARITY.qwen["check.provider-override.served-model"].state).toBe("harness-limitation");
});

test.each([[10, 0], [0, 10], [3, 3]])("Cline inconsistent cache counts %s/%s invalidate input and total", (read, write) => {
  expect(normalizeClineUsage({ inputTokens: 5, outputTokens: 2, cacheReadTokens: read, cacheWriteTokens: write }))
    .toMatchObject({ input_tokens: null, total_tokens: null, output_tokens: 2, cached_input_tokens: read + write });
});

test("budget help describes a soft threshold", () => {
  const source = readFileSync(new URL("../src/run-command.ts", import.meta.url), "utf8");
  expect(source).toContain("Soft dollar spend threshold");
  expect(source).not.toContain("Maximum dollar amount the harness may spend");
});

const failures = [
  { name: "cursor error result", profile: CURSOR_DRIVER_PROFILE, stdout: lines(
    { type: "result", session_id: id, result: "Partial answer", subtype: "error_during_execution", is_error: true }) },
  { name: "copilot error result", profile: COPILOT_DRIVER_PROFILE, stdout: lines(
    { type: "result", sessionId: id, result: "Partial answer", exitCode: 1 }) },
  { name: "copilot session error followed by zero result", profile: COPILOT_DRIVER_PROFILE, stdout: lines(
    { type: "assistant.message", data: { content: "Partial answer" } },
    { type: "session.error", data: { message: "provider failed" } },
    { type: "result", sessionId: id, exitCode: 0 }) },
  { name: "pi error stop reason", profile: PI_DRIVER_PROFILE, stdout: lines(
    { type: "session", id }, { type: "message_end", message: { role: "assistant", stopReason: "error",
      content: [{ type: "text", text: "Partial answer" }], errorMessage: "provider failed" } }) },
  { name: "goose error metadata", profile: GOOSE_DRIVER_PROFILE, sessionId: "20261111_1",
    stdout: "    __( O)>  ● new session · provider model\n   \\____)     20261111_1 · /workspace\n" + JSON.stringify({
      messages: [{ role: "assistant", content: [{ type: "text", text: "Partial answer" }] }], metadata: { status: "error" } }) },
  { name: "openhands error event", profile: OPENHANDS_DRIVER_PROFILE, stdout: lines(
    { kind: "MessageEvent", source: "agent", llm_message: { role: "assistant", content: [{ type: "text", text: "Partial answer" }] } },
    { kind: "ConversationErrorEvent", source: "environment", code: "ModelError", detail: "provider failed" }) + `\nConversation ID: ${id.replaceAll("-", "")}\n` },
  { name: "gemini error status without text", profile: GEMINI_DRIVER_PROFILE, stdout: lines(
    { type: "init", session_id: id, model: "configured" },
    { type: "message", role: "assistant", content: "Partial answer" },
    { type: "result", status: "error" }) },
  { name: "droid stream error", profile: DROID_DRIVER_PROFILE, stdout: lines(
    { type: "system", session_id: id }, { type: "message", role: "assistant", text: "Partial answer" },
    { type: "error", message: "provider failed" }) },
  { name: "droid legacy failure subtype", profile: DROID_DRIVER_PROFILE, stdout: lines(
    { type: "result", session_id: id, result: "Partial answer", subtype: "failure", is_error: false }) },
  { name: "qwen failure subtype", profile: QWEN_DRIVER_PROFILE, stdout: lines(
    { type: "result", session_id: id, result: "Partial answer", subtype: "error_during_execution", is_error: false }) },
];
for (const { name, profile, stdout, sessionId = id } of failures) {
  test(`${name}: structured failure survives process exit zero`, async () => {
    const child = fakeTurnProcess();
    const h = engineSession({ options: { profile, mintedSessionId: sessionId, resumeSessionId: sessionId,
      cwd: process.cwd(), harnessHome: process.cwd(), spawnTurn: async () => child } });
    try {
      h.user();
      await h.wait("turn_started");
      for (const line of stdout.split("\n")) h.line(line);
      child.exit(0);
      const completed = await h.wait("turn_completed");
      expect(completed.finish).toBe("failed");
      expect(String(completed.reason)).not.toContain("code 0");
      h.shutdown();
      // A handled failed turn leaves the session usable; clean shutdown is zero.
      expect(await h.code()).toBe(0);
    } finally { h.dispose(); }
  });
}
