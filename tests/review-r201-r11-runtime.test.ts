import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { parseSinceOption, registerCallsCommand } from "../src/calls-command.js";
import { ResponseAccounting } from "../src/complete/response-accounting.js";
import { CompleteGovernor } from "../src/complete/governor.js";
import { upstreamFor } from "./helpers/complete-fakes.js";
import { parseQwenResultEnvelope, qwenResult, qwenPlainResult } from "../src/result-envelope/qwen.js";
import { StreamDropFold } from "../src/stream-drop-fold.js";
import { MAX_CAPTURE_BYTES, readBounded } from "../src/process-capture.js";

test.each([0, 0.01])("a complete reported charge of %s prices unsupported cache writes", (cost) => {
  const upstream = upstreamFor({ baseUrl: "http://127.0.0.1:1/v1" } as Parameters<typeof upstreamFor>[0], "openai", "openrouter");
  const accounting = new ResponseAccounting(upstream);
  accounting.observe({ model: "vendor/model", usage: {
    prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost,
    prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 10 },
  } });
  const governor = new CompleteGovernor({ budgetUsd: 10, maxRequests: 10, providerReportsCost: true,
    priceOverride: null, host: "openrouter.test", labels: null, cwd: process.cwd(), environment: { CODEMUX_CALL_LOG: "off" } });
  const ticket = governor.admit("vendor/model");
  expect(governor.settle(ticket, accounting.settlement("stop"))).toBe(cost);
  expect(governor.spentUsd).toBe(cost);
  expect(governor.capReached()).toBeNull();
  expect(() => governor.admit("vendor/model")).not.toThrow();
  expect(accounting.settlement("interrupted", false).costKnown).toBe(false);
  accounting.observe({ usage: { prompt_tokens: 101, completion_tokens: 21 } });
  expect(accounting.settlement("stop").costKnown).toBe(false);
});

test.each([null, false, 3, "failure", [], { message: null }].map((error) => ({ error })))("Qwen validates nullable error fields: %j", ({ error }) => {
  const stdout = JSON.stringify({ type: "result", subtype: "success", error, is_error: false,
    result: "answer", usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0 } });
  expect(parseQwenResultEnvelope(stdout)).toMatchObject({ answer: "answer", errorMessage: null,
    usage: { input_tokens: 10, output_tokens: 2 } });
  const result = { stdout, stderr: "", success: true, exitCode: 0 };
  expect(qwenResult(result, { agent: "qwen", prompt: "p" }).success).toBe(true);
  expect(qwenPlainResult(result).stdout).toBe("answer\n");
});

test("an unterminated retained line trips capture while the producer is still open", async () => {
  const fold = new StreamDropFold([]);
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"type":"assistant","text":"'));
      controller.enqueue(new TextEncoder().encode("é".repeat(MAX_CAPTURE_BYTES / 2)));
    },
    cancel() { canceled = true; },
  });
  await expect(readBounded(stream, "stdout", undefined, fold)).rejects.toThrow("capture limit");
  expect(canceled).toBe(true);
});

test("partial bytes join retained bytes, while streamed dropped payloads stay exempt", () => {
  const fold = new StreamDropFold([{ opening: '{"type":"tool"', marker: "tool" }]);
  fold.push("é\npar");
  expect(fold.keptBytes()).toBe(6);
  fold.push('tial\n{"type":"tool"');
  const before = fold.keptBytes();
  for (let i = 0; i < 20; i++) fold.push("x".repeat(1024 * 1024));
  expect(fold.keptBytes()).toBe(before);
  fold.push("}\nanswer");
  expect(fold.keptBytes()).toBe(Buffer.byteLength("é\npartial\ntool\nanswer"));
  expect(fold.finish()).toBe("é\npartial\ntool\nanswer");
});

test.each(["2026-02-30", "2025-02-29", "2026-04-31T12:30:00Z", "2026-02-30T00:00:00+02:00",
  "2026-01-01T24:00:00Z", "February 30, 2026 00:00:00 GMT", "30 Feb 2026 00:00:00 GMT", "02/30/2026"])(
  "calls refuses normalized cutoff %s with exit 64", async (value) => {
    expect(parseSinceOption(value)).toBeNull();
    const program = new Command();
    let code = 0;
    registerCallsCommand(program, (next) => { code = next; });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await program.parseAsync(["calls", "--since", value], { from: "user" });
      expect(code).toBe(64);
      expect(error.mock.calls.flat().join(" ")).toContain("--since");
    } finally { error.mockRestore(); }
  });

test.each(["2024-02-29", "2024-02-29T23:00:00-03:00", "0099-02-28T00:00:00Z",
  "February 29, 2024 00:00:00 GMT", "29 Feb 2024 00:00:00 GMT", "02/29/2024"])("calls preserves valid cutoff %s", (value) => {
  expect(parseSinceOption(value)?.getTime()).toBe(new Date(value).getTime());
});

test("completion introduction describes admission and overshoot", () => {
  const intro = readFileSync(new URL("../docs/complete.md", import.meta.url), "utf8").split("## The consumer contract")[0]!;
  expect(intro).toContain("spending check before admission");
  expect(intro).toContain("overshoot the budget");
  expect(intro).not.toContain("hard\nspend cap");
});

test("completion guide uses the package runtime pin", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(readFileSync(new URL("../docs/complete.md", import.meta.url), "utf8")).toContain(`On pinned Bun ${pkg.packageManager.split("@")[1]}`);
});
