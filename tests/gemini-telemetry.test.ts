import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import { geminiTelemetryEnvironment, geminiTelemetryServedModel, prepareGeminiTelemetry } from "../src/gemini-telemetry.js";
import type { JsonObject } from "../src/experiment-server.js";

function geminiModelEvidence(): JsonObject[] {
  return [{ _spanContext: { traceId: "trace", spanId: "main" }, status: { code: 1 }, attributes: {
    "gen_ai.tool.definitions": "[]", "gen_ai.conversation.id": "session", "gen_ai.prompt.name": "prompt" } },
  { spanContext: { traceId: "trace", spanId: "main" }, attributes: { "event.name": "gemini_cli.api_request", role: "main" } },
  { spanContext: { traceId: "trace", spanId: "main" }, attributes: { "event.name": "gemini_cli.api_response", role: "main", status_code: 200,
    model: "configured-fallback", prompt_id: "prompt", response_text: JSON.stringify([{ candidates: [] }, { modelVersion: "provider-version" }]) } }];
}
function geminiModelRig(run: (home: string) => void): void {
  const parent = join(process.cwd(), "scratch", "fix", "gemini-synthetic"); mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "model-"));
  try { run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

test("Gemini reports raw provider modelVersion through the actual adapter lifecycle", () => geminiModelRig((home) => {
  const adapter = new GeminiAdapter({ HOME: home, CODEMUX_GEMINI_PROVIDER_BASE_URL: "https://example.invalid", CODEMUX_GEMINI_PROVIDER_API_KEY: "synthetic-key", CODEMUX_GEMINI_PROVIDER_MODEL: "configured" });
  const request = { agent: "gemini" as const, prompt: "p", cwd: home, resultJson: true };
  const context = adapter.prepareRun(request);
  try {
    const path = context.geminiTelemetryPath!;
    expect(adapter.getRunEnv(request, context)).toMatchObject(geminiTelemetryEnvironment(path));
    expect(adapter.buildRunCommand(request, context)).toContain(`GEMINI_CLI_HOME=${context.geminiHermeticHome!.home}`);
    writeFileSync(path, geminiModelEvidence().map((record) => JSON.stringify(record, null, 2)).join("\n"));
    const raw = { stdout: JSON.stringify({ session_id: "session", response: "done", stats: {} }), stderr: "", exitCode: 0, success: true };
    const result = adapter.processRunResult(raw, request, context);
    expect(result.servedModel).toBe("provider-version");
    expect(JSON.parse(result.stdout).codemux).toMatchObject({ model: "configured", served_model: "provider-version" });
    expect(existsSync(join(context.geminiHermeticHome!.geminiDir, "oauth_creds.json"))).toBe(false);
    const privateHome = context.geminiHermeticHome!.home; adapter.cleanupRunSync(context); expect(existsSync(privateHome)).toBe(false);
  } finally { adapter.cleanupRunSync(context); }
}));

test.each(["missing", "fallback-only", "conflicting", "blank", "control", "foreign-session", "missing-span", "duplicate-span", "missing-request", "extra-request", "duplicate-response", "failed-span", "failed-response", "wrong-prompt", "null-chunk", "bad-json", "truncated", "symlink"])("Gemini served model stays unknown with %s evidence", (kind) => geminiModelRig((home) => {
  const path = prepareGeminiTelemetry(home), records = geminiModelEvidence();
  if (kind === "fallback-only") records[2]!.attributes.response_text = "[{}]";
  if (kind === "conflicting") records[2]!.attributes.response_text = '[{"modelVersion":"a"},{"modelVersion":"b"}]';
  if (kind === "blank") records[2]!.attributes.response_text = '{"modelVersion":" "}';
  if (kind === "control") records[2]!.attributes.response_text = JSON.stringify({ modelVersion: "bad\nname" });
  if (kind === "foreign-session") records[0]!.attributes["gen_ai.conversation.id"] = "other";
  if (kind === "missing-span") records.shift();
  if (kind === "duplicate-span") records.push(records[0]!);
  if (kind === "missing-request") records.splice(1, 1);
  if (kind === "extra-request") records.push({ ...records[1], spanContext: { traceId: "trace", spanId: "missing" } });
  if (kind === "duplicate-response") records.push(records[2]!);
  if (kind === "failed-span") records[0]!.status.code = 2;
  if (kind === "failed-response") records[2]!.attributes.status_code = 500;
  if (kind === "wrong-prompt") records[2]!.attributes.prompt_id = "other";
  if (kind === "null-chunk") records[2]!.attributes.response_text = "[null]";
  if (kind === "bad-json") records[2]!.attributes.response_text = "{";
  writeFileSync(path, kind === "truncated" ? "{" : records.map((record) => JSON.stringify(record, null, 2)).join("\n"));
  const link = join(home, "link"); if (kind === "symlink") symlinkSync(path, link);
  expect(geminiTelemetryServedModel(kind === "missing" ? undefined : kind === "symlink" ? link : path, "session")).toBeNull();
  expect(geminiTelemetryServedModel(path, null)).toBeNull();
}));

test("Gemini ignores utility model versions and accepts nonstreaming raw metadata", () => geminiModelRig((home) => {
  const path = prepareGeminiTelemetry(home), records = geminiModelEvidence();
  records[2]!.attributes.response_text = '{"modelVersion":"provider-version"}';
  records.push({ attributes: { "event.name": "gemini_cli.api_response", role: "utility", response_text: '{"modelVersion":"other"}' } });
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n"));
  expect(geminiTelemetryServedModel(path, "session")).toBe("provider-version");
}));
