// A length stop prints its one stderr line on every arm (merge review of
// lane AN1, finding 1): docs/results-and-usage.md promises the line
// whenever codemux.truncated is true, and a run can be cut by the length
// limit and fail at once (an error event beside it, or no answer at all).
// Goose, opencode, pi, and droid used to drop the line on failure arms.
import { describe, expect, test } from "bun:test";
import { GooseAdapter } from "../src/adapters/goose.js";
import { PiAdapter } from "../src/adapters/pi.js";
import { openCodeResultData, opencodePlainResult } from "../src/plain-unwrap.js";
import { opencodeResult } from "../src/result-envelope/opencode.js";
import { truncationLine } from "../src/answer-complete.js";
import type { RunResult } from "../src/types.js";

const ok = (stdout: string): RunResult => ({ stdout, stderr: "", exitCode: 0, success: true });
const lines = (events: unknown[]): string => events.map((event) => JSON.stringify(event)).join("\n") + "\n";

describe("goose: a length-stopped run that also reports an error", () => {
  const stream = lines([
    { type: "message", message: { id: "u0", role: "user", created: 0, content: [{ type: "text", text: "audit" }] } },
    { type: "message", message: { id: "a1", role: "assistant", created: 1, content: [{ type: "text", text: "Partial" }],
      metadata: { outputTokenLimitReached: true } } },
    { type: "error", error: "stream closed" },
  ]);
  const adapter = new GooseAdapter({});

  test("--result-json fails, reports truncated, and prints the truncation line", () => {
    const out = adapter.processRunResult(ok(stream), { agent: "goose", prompt: "p", resultJson: true });
    expect(out.success).toBe(false);
    expect(JSON.parse(out.stdout).codemux.truncated).toBe(true);
    expect(out.stderr).toContain(truncationLine("goose"));
  });

  test("a plain run fails and prints the truncation line", () => {
    const out = adapter.processRunResult(ok(stream), { agent: "goose", prompt: "p" });
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("stream closed");
    expect(out.stderr).toContain(truncationLine("goose"));
  });
});

describe("opencode: a length-stopped run that also reports an error", () => {
  const SESSION = "ses_0123456789abcdefABCDEFGHIJ";
  const event = (type: string, part: Record<string, unknown>) =>
    ({ type, timestamp: 1, sessionID: SESSION, part: { sessionID: SESSION, ...part } });
  const stream = lines([
    event("step_start", { type: "step-start" }),
    event("text", { type: "text", text: "Partial" }),
    event("step_finish", { type: "step-finish", reason: "length", tokens: { input: 1, output: 1, total: 2 } }),
    { type: "error", sessionID: SESSION, error: { message: "provider closed" } },
  ]);

  test("plain and --result-json runs fail and print the truncation line", () => {
    const plain = opencodePlainResult(ok(stream));
    expect(plain.success).toBe(false);
    expect(plain.stderr).toContain(truncationLine("opencode"));
    const json = opencodeResult(ok(""), { agent: "opencode", prompt: "p", resultJson: true }, openCodeResultData(stream));
    expect(json.success).toBe(false);
    expect(JSON.parse(json.stdout).codemux.truncated).toBe(true);
    expect(json.stderr).toContain(truncationLine("opencode"));
  });
});

describe("pi: a length stop with no answer text", () => {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
  const stream = lines([
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "audit" }], model: "m", usage, stopReason: "stop" } },
    { type: "message_end", message: { role: "assistant", content: [], model: "m", usage, stopReason: "length" } },
  ]);

  test("the run fails as empty and still prints the truncation line", () => {
    const adapter = new PiAdapter({});
    for (const resultJson of [false, true]) {
      const out = adapter.processRunResult(ok(stream), { agent: "pi", prompt: "p", resultJson });
      expect(out.success).toBe(false);
      expect(out.stderr).toContain("no assistant message");
      expect(out.stderr).toContain(truncationLine("pi"));
    }
  });
});
