// Agy probe result handling, split from tests/agy-isolation.test.ts for
// the file-size limit: a probe's verdict reads the same stream-json result
// envelope an ordinary agy run does.
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { markAgyIsolationProbe } from "../src/adapters/agy.js";
import type { RunResult } from "../src/types.js";
import { cleanupAgyIsolation, setup } from "./helpers/agy-isolation-setup.js";

afterEach(cleanupAgyIsolation);

test("an error-result envelope fails the probe even when agy exits 0", () => {
  const { adapter, request } = setup();
  markAgyIsolationProbe(request, "login");
  adapter.validateRunRequest(request);
  const context = adapter.prepareRun(request);
  try {
    const events = (frames: object[]) => frames.map((frame) => JSON.stringify(frame)).join("\n");
    const init = { event: "init", init: { tools: [] } };
    const base = { stderr: "", exitCode: 0, success: true };
    const failed = adapter.processRunResult({ ...base, stdout: events([init,
      { event: "result", result: { status: "ERROR", error: "quota", response: "" } }]) } as RunResult, request, context);
    expect(failed.exitCode).toBe(1);
    expect(failed.success).toBe(false);
    expect(failed.stderr).toContain('status "ERROR": quota');
    expect(failed.stderr).toContain("exited 0");
    const passed = adapter.processRunResult({ ...base, stdout: events([init,
      { event: "result", result: { status: "SUCCESS", response: "OK" } }]) } as RunResult, request, context);
    expect(passed.exitCode).toBe(0);
    expect(passed.success).toBe(true);
    const none = adapter.processRunResult({ ...base, stdout: events([init]) } as RunResult, request, context);
    expect(none.success).toBe(false);
    expect(none.stderr).toContain("not a result envelope");
    // The native evidence was written before the verdict was read from it.
    expect(existsSync(join(request.cwd!, "..", "native-events.jsonl"))).toBe(true);
  } finally {
    adapter.cleanupRun(context);
  }
});

test("empty and whitespace probe responses fail exactly like ordinary agy responses", () => {
  const { adapter, request } = setup();
  for (const response of ["", " \n\t "]) {
    const envelope = { status: "SUCCESS", response };
    const base = { stderr: "", exitCode: 0, success: true };
    // Every agy run is a stream-json run, so an ordinary response is the
    // same event stream read without the probe context.
    const stdout = JSON.stringify({ event: "init", init: { tools: [] } }) + "\n" +
      JSON.stringify({ event: "result", result: envelope });
    const plain = adapter.processRunResult({ ...base, stdout }, request);
    const probe = adapter.processRunResult({ ...base, stdout }, request, { agyProbe: { mode: "login", diagnostic: true } });
    expect(probe).toMatchObject({ success: false, exitCode: 1, stderr: plain.stderr, stdout });
    expect(probe.stderr).toContain("no result text");
  }
});

test("successful agy probes normalize usage exactly like ordinary responses", () => {
  const { adapter, request } = setup();
  const envelope = { status: "SUCCESS", response: "OK",
    usage: { input_tokens: 7, output_tokens: 3, cache_read_tokens: 2 } };
  const base = { stderr: "", exitCode: 0, success: true };
  const stdout = JSON.stringify({ event: "init", init: { tools: [] } }) + "\n" +
    JSON.stringify({ event: "result", result: envelope });
  const plain = adapter.processRunResult({ ...base, stdout }, request);
  const probe = adapter.processRunResult({ ...base, stdout }, request, { agyProbe: { mode: "login", diagnostic: true } });
  expect(probe.success).toBe(true);
  expect(probe.usage).toEqual(plain.usage);
  expect(probe.usage).toMatchObject({ input_tokens: 5, output_tokens: 3, cached_input_tokens: 2, total_tokens: 10 });
  expect(probe.stdout).toBe(stdout);
});
