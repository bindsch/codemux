import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExperimentKimiEvidence } from "../src/experiment-kimi.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { kimiResult } from "../src/result-envelope/kimi.js";
import { experimentFailedResult } from "../src/result-envelope/experiment.js";
import { parseKimiStreamLine } from "../src/session/kimi-session.js";
import { emptyUsage } from "../src/result-envelope/common.js";
import * as wire from "../src/kimi-wire-log.js";
import type { RunContext } from "../src/run-context.js";
import type { RunRequest } from "../src/types.js";
import { kimiResumeHint } from "./fixtures/kimi-stream.js";

const malformed = [
  {}, { tool_calls: [] }, { content: "" }, { content: null }, { tool_calls: {} },
  { tool_calls: [null] }, { tool_calls: [{}] },
  { tool_calls: [{ function: { name: "mcp__experiment__lookup" } }] },
  { tool_calls: [{ type: "function", id: "call", function: { name: "mcp__experiment__lookup", arguments: {} } }] },
  { tool_calls: [{ type: "function", id: "call", function: { name: "", arguments: "{}" } }] },
].map((fields) => ({ role: "assistant", ...fields }));
const request: RunRequest = { agent: "kimi", prompt: "fixture", resultJson: true, experimentMcp: "synthetic.json" };
const context = { experimentKimi: { foldedUsage: () => undefined,
  relay: { failureError: null, failureCode: null, fail() {} },
  evidence: { wireLogPath: resolve("tests/fixtures/live/kimi-session.ndjson") } } } as unknown as RunContext;
const raw = (stdout: string) => ({ stdout, stderr: "native diagnostic", success: true, exitCode: 0 });
const stream = (frames: unknown[]) => frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n";
const hint = kimiResumeHint();

test.each(malformed)("Kimi evidence applies the session assistant grammar: %j", (frame) => {
  expect(parseKimiStreamLine(JSON.stringify(frame), { knownSessionId: null }).kind).toBe("grammar_error");
  const parent = resolve("scratch/session-14c66a93/exp/kimi-task-n");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "case-"));
  const evidence = new ExperimentKimiEvidence({ spec: { name: "experiment" },
    toolNames: new Set(["lookup"]), toolDefinitions: [], calls: [], record() {} }, { kimiHome: home });
  try { expect(() => evidence.accept(frame)).toThrow(ExperimentFailure); }
  finally { evidence.stop(); }
});

test.each(malformed)("Kimi result refuses malformed assistant frames before a valid reply: %j", (frame) => {
  const result = kimiResult(raw(stream([frame, { role: "assistant", content: "answer" }, hint])), request, ".", context);
  expect(result.success).toBe(false);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).codemux.failure_code).toBe(Code.Protocol);
  expect(result.stderr).toContain("stream-json line 1");
});

test.each([false, true])("Kimi output failures print exactly one coded diagnostic; JSON=%s", (resultJson) => {
  const selected = { ...request, resultJson };
  const normalized = kimiResult(raw(stream([hint])), selected, ".", context);
  const failure = new ExperimentFailure(Code.Protocol, "kimi printed no assistant reply in stream-json");
  const result = experimentFailedResult(normalized, selected, "recording.jsonl", failure);
  expect(result.stderr).toBe(`native diagnostic\ncodemux: experiment failure [protocol]: ${failure.message}\n`);
});

test.each([false, true])("Kimi failure refuses unnormalized input without reading any brand home; JSON=%s", (resultJson) => {
  const lookup = spyOn(wire, "findKimiWireLog").mockImplementation(() => { throw new Error("brand home read"); });
  try {
    expect(() => experimentFailedResult(raw(stream([{ role: "assistant", content: "answer" }, hint])),
      { ...request, resultJson }, "recording.jsonl", new ExperimentFailure(Code.Protocol, "failed"), emptyUsage()))
      .toThrow("internal error: Kimi experiment result must be normalized before failure reporting");
    expect(lookup).not.toHaveBeenCalled();
  } finally { lookup.mockRestore(); }
});
