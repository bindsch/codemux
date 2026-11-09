// Review R420 m1: when the empty-answer rule (result-empty.ts) fails an
// experiment run that its relay verified, the recording's run_end carries
// that verdict instead of reporting a clean run.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunContext } from "../src/adapters/base.js";
import { ExperimentHttpRelay } from "../src/experiment-relay.js";
import { ExperimentFailure, ExperimentFailureCode } from "../src/experiment-records.js";
import { recordExperimentEmptyAnswer } from "../src/launch/experiment-arms.js";
import { enforceNonEmptyResult } from "../src/result-empty.js";
import type { RunRequest } from "../src/types.js";

const relays: ExperimentHttpRelay[] = [];
afterEach(async () => { for (const relay of relays.splice(0)) await relay.close().catch(() => {}); });

async function relay(): Promise<ExperimentHttpRelay> {
  const parent = resolve("scratch/fix/experiment-empty-answer");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  const created = new ExperimentHttpRelay({ name: "experiment", command: process.execPath,
    args: ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`,
      resolve("tests/fixtures/experiment-mcp.ts")], env: [], recording: join(cwd, "recordings") }, cwd, {});
  relays.push(created);
  await created.start();
  return created;
}
const runEnd = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line))
  .find((entry) => entry.kind === "run_end");
const emptyVerdict = () => new ExperimentFailure(ExperimentFailureCode.EmptyAnswer, "qwen exited 0 with an empty answer");

test("run_end carries a noted empty-answer verdict without failing the relay", async () => {
  const r = await relay();
  r.noteRunOutcome(emptyVerdict());
  expect(r.failureError).toBeNull();
  await r.close();
  expect(runEnd(r.recordingPath)).toMatchObject({ code: "empty_answer", error: "qwen exited 0 with an empty answer" });
});

test("a relay failure keeps its own code in run_end", async () => {
  const r = await relay();
  r.fail(new ExperimentFailure(ExperimentFailureCode.ServerError, "synthetic server failure"));
  r.noteRunOutcome(emptyVerdict());
  await r.close().catch(() => {});
  expect(runEnd(r.recordingPath)).toMatchObject({ code: "server_error", error: "synthetic server failure" });
});

test("a clean run keeps a null run_end code", async () => {
  const r = await relay();
  await r.close();
  expect(runEnd(r.recordingPath)).toMatchObject({ code: null, error: null });
});

test("the launcher arm notes the verdict on every recording owner, only for an empty experiment answer", () => {
  const noted: string[] = [];
  const owner = (name: string) => ({ failureError: null, fail: () => {}, noteRunOutcome: (error: ExperimentFailure) => {
    noted.push(`${name}:${error.code}`);
  } });
  const context = { experimentBridge: owner("bridge"), experimentQwen: { relay: owner("qwen") },
    experimentCodex: { startedRecordingPath: "recording.jsonl", relay: owner("codex") } } as unknown as RunContext;
  const request: RunRequest = { agent: "qwen", prompt: "synthetic", experimentMcp: "spec.json" };
  const empty = enforceNonEmptyResult({ stdout: "", stderr: "", exitCode: 0, success: true }, request, 0);
  recordExperimentEmptyAnswer(context, { ...request, experimentMcp: undefined }, empty);
  recordExperimentEmptyAnswer(context, request, { stdout: "answer", stderr: "", exitCode: 0, success: true });
  expect(noted).toEqual([]);
  recordExperimentEmptyAnswer(context, request, empty);
  expect(noted.sort()).toEqual(["bridge:empty_answer", "codex:empty_answer", "qwen:empty_answer"]);
});

test("an experiment's result JSON reports the empty-answer failure code", () => {
  const request: RunRequest = { agent: "qwen", prompt: "synthetic", experimentMcp: "spec.json", resultJson: true };
  const result = enforceNonEmptyResult({ stdout: JSON.stringify({ result: "", codemux: { failure_code: null } }),
    stderr: "", exitCode: 0, success: true }, request, 0);
  expect(JSON.parse(result.stdout).codemux).toMatchObject({ failure_code: "empty_answer", finish: "empty-answer" });
  const plain = enforceNonEmptyResult({ stdout: "{}", stderr: "", exitCode: 0, success: true },
    { ...request, experimentMcp: undefined }, 0);
  expect(JSON.parse(plain.stdout).codemux.failure_code).toBeNull();
});
