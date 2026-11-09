import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { enforceNonEmptyResult, emptyAnswerFinish, isEmptyAnswer, EMPTY_ANSWER_EXIT_CODE } from "../src/result-empty.js";
import { emptyUsage, envelopeBoundLine } from "../src/result-envelope/common.js";
import { MAX_CAPTURE_BYTES, OUTPUT_LIMIT_EXIT_CODE } from "../src/process-runner.js";
import { appendFailedLaunchReceipt } from "../src/launch/receipts.js";
import type { RunRequest, RunResult } from "../src/types.js";

const request: RunRequest = { agent: "cursor", prompt: "Answer the question." };
const ok = (stdout = ""): RunResult => ({ stdout, stderr: "", exitCode: 0, success: true });

describe("shared empty-answer verdict", () => {
  test.each(["", " ", "\t\r\n", "\u2002\u00a0"])("rejects empty text %j", (text) => {
    expect(isEmptyAnswer(text)).toBe(true);
    const result = enforceNonEmptyResult(ok(text), request, 0);
    expect(result.exitCode).toBe(EMPTY_ANSWER_EXIT_CODE);
    expect(result.success).toBe(false);
    expect(result.stdout).toBe(text);
    expect(result.stderr).toBe("Error: cursor exited 0 with an empty answer\n");
    expect(emptyAnswerFinish(result)).toBe("empty-answer");
    expect(enforceNonEmptyResult(result, request, 0)).toBe(result);
  });

  test("nonempty answers pass through unchanged", () => {
    const result = ok("\n Answer. \t");
    expect(isEmptyAnswer(result.stdout)).toBe(false);
    expect(enforceNonEmptyResult(result, request, 0)).toBe(result);
    expect(emptyAnswerFinish(result)).toBeNull();
  });

  test("a child failure keeps its exit and diagnostics", () => {
    const result = { ...ok(), success: false, exitCode: 23, stderr: "child failed\n" };
    expect(enforceNonEmptyResult(result, request, 23)).toBe(result);
  });

  test("adapter rejection of an exit-zero empty reply gets the shared finish", () => {
    const result = enforceNonEmptyResult({ ...ok(), success: false, exitCode: 1, stderr: "native note" }, request, 0);
    expect(result.stderr).toBe("native note\nError: cursor exited 0 with an empty answer\n");
    expect(emptyAnswerFinish(result)).toBe("empty-answer");
  });

  test("capture and timeout verdicts cannot become empty-answer failures", () => {
    const cases: RunResult[] = [
      { ...ok(), timedOut: true, exitCode: 124, success: false },
      { ...ok(), captureLimitExceeded: true, exitCode: OUTPUT_LIMIT_EXIT_CODE, success: false },
      { ...ok(), exitCode: OUTPUT_LIMIT_EXIT_CODE, success: false, stderr: envelopeBoundLine("cursor") },
    ];
    for (const result of cases) expect(enforceNonEmptyResult(result, request, 0)).toBe(result);
  });

  test("the answer field decides JSON success, regardless of metadata text", () => {
    const usage = { ...emptyUsage(), output_tokens: 25 };
    const result = enforceNonEmptyResult({
      ...ok(JSON.stringify({ result: " \n", note: "tools completed", codemux: { usage, recording: "record.jsonl", finish: "ok" } })),
      usage, servedModel: "reported-model",
    }, { ...request, resultJson: true }, 0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.result).toBe(" \n");
    expect(envelope.note).toBe("tools completed");
    expect(envelope.codemux).toMatchObject({ empty_answer: true, finish: "empty-answer", usage, recording: "record.jsonl" });
    expect(result.usage).toEqual(usage);
    expect(result.servedModel).toBe("reported-model");
  });

  test("nonempty JSON answers pass through unchanged", () => {
    const result = ok(JSON.stringify({ result: "The answer." }));
    expect(enforceNonEmptyResult(result, { ...request, resultJson: true }, 0)).toBe(result);
  });

  test.each([{}, { result: null }, { result: 2 }, { result: [] }])("missing or nontext answer fails closed: %j", (envelope) => {
    const result = enforceNonEmptyResult(ok(JSON.stringify(envelope)), { ...request, resultJson: true }, 0);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ result: "", codemux: { empty_answer: true } });
  });

  test.each(["", "  ", "[]", "null", "invalid"])("an unparsed successful JSON result fails closed: %j", (stdout) => {
    const result = enforceNonEmptyResult(ok(stdout), { ...request, resultJson: true }, 0);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).codemux.empty_answer).toBe(true);
  });

  test("malformed nonempty JSON that already failed keeps its parser error", () => {
    const result = { ...ok("broken wire"), success: false, exitCode: 1, stderr: "invalid wire\n" };
    expect(enforceNonEmptyResult(result, { ...request, resultJson: true }, 0)).toBe(result);
  });

  test("an undeclared answer field cannot turn metadata into a result", () => {
    const result = enforceNonEmptyResult(ok('{"metadata":"present"}'), { ...request, agent: "aider", resultJson: true }, 0);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).codemux.empty_answer).toBe(true);
  });

  test("an oversized failure envelope still obeys the capture bound", () => {
    const result = enforceNonEmptyResult(ok(JSON.stringify({ result: "", metadata: "x".repeat(MAX_CAPTURE_BYTES) })),
      { ...request, resultJson: true }, 0);
    expect(result.exitCode).toBe(OUTPUT_LIMIT_EXIT_CODE);
    expect(result.stdout).toBe("");
    expect(emptyAnswerFinish(result)).toBe("empty-answer");
  });

  test("a later cleanup failure keeps the empty-answer ledger finish", () => {
    const result = enforceNonEmptyResult(ok(), request, 0);
    appendFailedLaunchReceipt("default", request, { sandbox: false, requestedAutonomy: "high" }, {},
      Date.now(), new Error("cleanup failed"), true, result);
    const receipt = JSON.parse(readFileSync(process.env.CODEMUX_TEST_LEDGER!, "utf8").trim().split("\n").at(-1)!);
    expect(receipt).toMatchObject({ agent: "cursor", exit_code: 1, finish: "empty-answer" });
  });
});
