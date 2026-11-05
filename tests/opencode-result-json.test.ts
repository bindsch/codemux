import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import type { RunRequest, RunResult } from "../src/types.js";
import { OpenCodePlainFold, openCodeResultData } from "../src/plain-unwrap.js";
import { MAX_CAPTURE_BYTES } from "../src/process-runner.js";
import { opencodeResult } from "../src/result-envelope/opencode.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

const success: RunResult = { stdout: "", stderr: "", exitCode: 0, success: true };
const wire = (lines: string[]) => `${lines.join("\n")}\n`;
const part = (text: string): string =>
  JSON.stringify({ type: "text", sessionID: "ses_0123456789abcdef", part: { text } });
const stepFinish = (tokens: Record<string, unknown>, cost: number | null = null): string =>
  JSON.stringify({ type: "step_finish", sessionID: "ses_0123456789abcdef", part: { tokens, cost } });
const toolUse = (output: string): string =>
  JSON.stringify({
    type: "tool_use",
    sessionID: "ses_0123456789abcdef",
    part: { id: "cal_1", tool: "read", state: { status: "completed", input: {}, output } },
  });
const errorLine = (message: string): string =>
  JSON.stringify({ type: "error", sessionID: "ses_0123456789abcdef", error: { message } });

function fixture() {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "opencode-result-"));
  const adapter = new OpencodeAdapter({ HOME: home }, home);
  const request: RunRequest = {
    agent: "opencode",
    prompt: "hello",
    model: "test-model",
    resultJson: true,
    labels: { wf: "synthetic" },
  };
  // The captured arm (no sink on the context) and the streaming arm (the
  // sink prepareRun hangs) must answer identically.
  const captured = (stdout: string) => adapter.processRunResult({ ...success, stdout }, request);
  const streamed = (stdout: string, chunks: string[] = [stdout]) => {
    const context = adapter.prepareRun(request);
    const sink = context.stdoutSink as OpenCodePlainFold;
    for (const chunk of chunks) sink.push(chunk);
    return adapter.processRunResult({ ...success, stdout }, request, context);
  };
  return { home, adapter, request, captured, streamed, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const replyWire = wire([
  part("Working"),
  part("A\nB\n\n"),
  toolUse("file contents"),
  stepFinish({ input: 8, output: 3, total: 11 }, 0),
]);
const foldedUsage = { input_tokens: 8, output_tokens: 3, cached_input_tokens: null, total_tokens: 11, cost_usd: 0 };

describe("OpenCode result-json", () => {
  test.each([
    ["captured", (f: ReturnType<typeof fixture>) => f.captured(replyWire)],
    ["streamed", (f: ReturnType<typeof fixture>) => f.streamed(replyWire)],
  ])("the envelope carries the folded reply and step usage: %s arm", (_arm, run) => {
    const f = fixture();
    try {
      const result = run(f);
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
      expect(JSON.parse(result.stdout)).toEqual({
        reply: "Working\nA\nB\n",
        usage: foldedUsage,
        codemux: {
          agent: "opencode", model: "test-model", labels: { wf: "synthetic" },
          served_model: null,
          usage: foldedUsage, session_id: null, recording: null, failure_code: null,
        },
      });
      expect(result.usage).toEqual(foldedUsage);
    } finally { f.cleanup(); }
  });

  test("step usage accumulates across steps and sums reported costs", () => {
    const f = fixture();
    try {
      const stdout = wire([
        part("Working"),
        stepFinish({ input: 8, output: 3, total: 11 }, 0.25),
        stepFinish({ input: 2, output: 1, total: 3 }, 0.75),
      ]);
      const result = f.captured(stdout);
      expect(result.exitCode).toBe(0);
      // The inputs, outputs, and costs sum; the total does not, because
      // each step's reported total cannot be added and the cache count
      // no step reported is missing — the never-guess rule.
      expect(JSON.parse(result.stdout).usage).toEqual({
        input_tokens: 10, output_tokens: 4, cached_input_tokens: null, total_tokens: null, cost_usd: 1,
      });
    } finally { f.cleanup(); }
  });

  test("no step_finish reports null usage fields, not zeros", () => {
    const f = fixture();
    try {
      const result = f.captured(wire([part("Working")]));
      expect(JSON.parse(result.stdout).usage).toEqual({
        input_tokens: null, output_tokens: null, cached_input_tokens: null, total_tokens: null, cost_usd: null,
      });
    } finally { f.cleanup(); }
  });

  test("an error line fails the run after a zero exit but keeps the reply, usage, and envelope", () => {
    const f = fixture();
    try {
      const result = f.captured(wire([part("Working"), stepFinish({ input: 8, output: 3, total: 11 }, 0), errorLine("provider down")]));
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("provider down");
      const envelope = JSON.parse(result.stdout);
      expect(envelope.reply).toBe("Working\n");
      expect(envelope.usage).toEqual(foldedUsage);
    } finally { f.cleanup(); }
  });

  test("a stream with no assistant text fails with an empty-reply envelope", () => {
    const f = fixture();
    try {
      const result = f.captured(wire([toolUse("output"), stepFinish({ input: 8, output: 3, total: 11 })]));
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("no assistant text");
      expect(JSON.parse(result.stdout)).toMatchObject({
        reply: "",
        usage: { input_tokens: 8, output_tokens: 3, cached_input_tokens: null, total_tokens: 11, cost_usd: null },
      });
    } finally { f.cleanup(); }
  });

  test("stdout that never used the wire fails loudly with the raw text kept", () => {
    const f = fixture();
    try {
      const result = f.captured("just text\n");
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("no wire events");
      expect(result.stdout).toBe("just text\n");
    } finally { f.cleanup(); }
  });

  test("a broken line beside wire evidence still yields the envelope and a stderr note", () => {
    const f = fixture();
    try {
      const result = f.captured(`${replyWire}{"type":"step_finish","timestamp":1`);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("were not the wire");
      expect(JSON.parse(result.stdout)).toMatchObject({ reply: "Working\nA\nB\n", usage: foldedUsage });
    } finally { f.cleanup(); }
  });

  test("a nonzero harness exit is preserved with the envelope still emitted", () => {
    const f = fixture();
    try {
      const result = f.adapter.processRunResult(
        { ...success, stdout: replyWire, exitCode: 7, success: false }, f.request);
      expect(result.exitCode).toBe(7);
      expect(result.success).toBe(false);
      expect(JSON.parse(result.stdout)).toMatchObject({ reply: "Working\nA\nB\n" });
    } finally { f.cleanup(); }
  });

  test("a stream that latches the capture bound never reaches the envelope: the runner fails at 125", () => {
    // The fold-level pin (plain-unwrap's tests carry the same one): a line
    // past the capture bound latches the fold, keptBytes answers over the
    // bound, and the runner fails the run at exit 125 before
    // processRunResult — so no envelope is built, exactly as no plain
    // verdict is.
    const fold = new OpenCodePlainFold();
    fold.push(part("the reply") + "\n");
    fold.push("x".repeat(MAX_CAPTURE_BYTES + 1));
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    const data = fold.resultData();
    expect(data.sawWire).toBe(true);
    expect(data.brokenCount).toBe(1);
    expect(data.broken[0]).toContain("capture bound");
  });

  test("openCodeResultData and the streaming fold answer identically for the same stream", () => {
    const fold = new OpenCodePlainFold();
    fold.push(replyWire);
    expect(openCodeResultData(replyWire)).toEqual(fold.resultData());
  });

  test("an override run without --model reports the model the adapter selected", () => {
    // Review round 3, contracts-2 finding 5: the adapter selects
    // CODEMUX_OPENCODE_PROVIDER_MODEL when the request carries no model,
    // and the envelope must report that selection, not null.
    const scratch = join(import.meta.dir, "../scratch");
    mkdirSync(scratch, { recursive: true });
    const home = mkdtempSync(join(scratch, "opencode-result-override-"));
    const adapter = new OpencodeAdapter({
      HOME: home,
      CODEMUX_OPENCODE_PROVIDER_BASE_URL: "https://api.example.test/v4",
      CODEMUX_OPENCODE_PROVIDER_API_KEY: "test-key-do-not-print",
      CODEMUX_OPENCODE_PROVIDER_MODEL: "glm-5.3",
    }, home);
    const request: RunRequest = {
      agent: "opencode",
      prompt: "hello",
      resultJson: true,
    };
    let context: ReturnType<typeof adapter.prepareRun> | undefined;
    try {
      // The launch the adapter builds carries the selected model...
      expect(adapter.buildRunCommand(request).join(" ")).toContain("--model codemux/glm-5.3");
      // ...and so does the envelope, streamed through prepareRun's fold.
      context = adapter.prepareRun(request);
      const sink = context.stdoutSink as OpenCodePlainFold;
      sink.push(replyWire);
      const result = adapter.processRunResult({ ...success, stdout: replyWire }, request, context);
      expect(JSON.parse(result.stdout).codemux.model).toBe("glm-5.3");
    } finally {
      // The provider config is finalized before its root goes.
      adapter.cleanupRunSync(context);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("OpenCode result-json CLI", () => {
  test("a fake opencode run emits the envelope and records usage in the ledger", async () => {
    const f = fixture();
    const ledger = join(f.home, "calls.jsonl");
    const fake = createFakeBinaryEnv({
      opencode: `printf '%s\\n' '${part("the reply")}' '${stepFinish({ input: 8, output: 3, total: 11 }, 0)}'`,
    });
    try {
      const result = await runCli(
        ["run", "-a", "opencode", "--no-sandbox", "--auto", "high", "--result-json", "-p", "test"],
        { ...fake.env, CODEMUX_CALL_LOG: ledger }
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        reply: "the reply\n",
        usage: { total_tokens: 11 },
        codemux: { agent: "opencode", usage: { total_tokens: 11 } },
      });
      const lines = readFileSync(ledger, "utf8").split("\n").filter((line) => line.trim() !== "");
      const record = JSON.parse(lines.at(-1)!) as { agent: string; usage: { total_tokens: number } };
      expect(record.agent).toBe("opencode");
      expect(record.usage.total_tokens).toBe(11);
    } finally {
      fake.cleanup();
      f.cleanup();
    }
  });

  test("plain-text stdout under --result-json fails loudly and keeps the raw text", async () => {
    const fake = createFakeBinaryEnv({ opencode: "printf 'just text\\n'" });
    try {
      const result = await runCli(
        ["run", "-a", "opencode", "--no-sandbox", "--auto", "high", "--result-json", "-p", "test"],
        fake.env
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("no wire events");
      expect(result.stdout).toBe("just text\n");
    } finally { fake.cleanup(); }
  });
});

describe("the envelope's own size", () => {
  test("a reply whose JSON escaping carries the envelope past the capture bound fails the run (review round 47)", () => {
    // Nine MiB of quotes escape to eighteen: under the bound raw, over it
    // in the envelope. The verdict must not read as a success the caller
    // cannot hold.
    const text = '"'.repeat(9 * 1024 * 1024);
    const request: RunRequest = { agent: "opencode", prompt: "hello", resultJson: true };
    const result = opencodeResult(success, request, { sawWire: true, text, usage: null, errorMessage: null, broken: [], brokenCount: 0 });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(125);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("exceeds the");
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_CAPTURE_BYTES);
    const small = opencodeResult(success, request, { sawWire: true, text: "OK", usage: null, errorMessage: null, broken: [], brokenCount: 0 });
    expect(small.success).toBe(true);
  });
});
