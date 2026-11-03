import { describe, expect, test } from "bun:test";
import { claudeFamilyPlainResult } from "../src/plain-unwrap.js";
import { emptyUsage } from "../src/result-envelope.js";
import { finished } from "./helpers/plain-unwrap.js";

const CLAUDE_ENVELOPE = JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: null,
  result: "OK",
  usage: { input_tokens: 24114, output_tokens: 98, cache_read_input_tokens: 300, cache_creation_input_tokens: 20 },
  total_cost_usd: 0.12735,
  modelUsage: { "claude-opus-5": {} },
});

describe("claudeFamilyPlainResult", () => {
  test("unwraps the envelope to the reply, byte for byte", () => {
    const out = claudeFamilyPlainResult(finished(`${CLAUDE_ENVELOPE}\n`), "claude");
    expect(out.stdout).toBe("OK\n");
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.usage).toEqual({
      input_tokens: 24114,
      output_tokens: 98,
      cached_input_tokens: 320,
      total_tokens: 24532,
      cost_usd: 0.12735,
    });
    expect(out.servedModel).toBe("claude-opus-5");
  });

  test("a multi-line result keeps its embedded newlines and gains only the trailing one", () => {
    const out = claudeFamilyPlainResult(
      finished(JSON.stringify({ type: "result", result: "line one\nline two" })),
      "zai"
    );
    expect(out.stdout).toBe("line one\nline two\n");
  });

  test("stdout that is not the envelope passes through verbatim with no usage", () => {
    // An older binary or a wrapper that strips --output-format json: the
    // run is unchanged and the ledger gets nothing rather than a guess.
    const out = claudeFamilyPlainResult(finished("OK\n"), "claude");
    expect(out).toEqual(finished("OK\n"));
    expect(out.usage).toBeUndefined();
    expect(out.servedModel).toBeUndefined();
  });

  test("a truncated envelope never passes through: failed run, empty stdout (ul3)", () => {
    // The envelope is one write at the end, so a timeout or the capture
    // cap can cut it mid-object. Before ul3 the JSON fragment passed
    // through verbatim as a successful reply.
    const cut = `{"type":"result","subtype":"success","is_error":false,"result":"the rea`;
    const out = claudeFamilyPlainResult({ stdout: cut, stderr: "", exitCode: 124, success: false }, "claude");
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(124);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("truncated or unrecognized");
    expect(out.usage).toBeUndefined();
  });

  test("a complete JSON object that is not the envelope fails the same way (ul3)", () => {
    const out = claudeFamilyPlainResult(finished('{"foo":1}\n'), "zai");
    expect(out.success).toBe(false);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("truncated or unrecognized");
  });

  test("a JSON array, or any JSON that is not the envelope, never passes through as the reply (ul7)", () => {
    // The ul7 defect: the escape hatch checked only for a leading `{`, so
    // stdout starting with `[` was returned verbatim as a successful reply
    // with no usage — JSON on a launch that asked for JSON output is the
    // wire's grammar, a structured stream that broke, never a plain reply.
    for (const stdout of ['[{"items":[]}]\n', "42\n", '"quoted"\n', "true\n"]) {
      const claude = claudeFamilyPlainResult(finished(stdout), "claude");
      expect(claude.success, stdout).toBe(false);
      expect(claude.stdout, stdout).toBe("");
      expect(claude.stderr, stdout).toContain("truncated or unrecognized");
      expect(claude.usage, stdout).toBeUndefined();
    }
    const zai = claudeFamilyPlainResult(finished("[1,2,3]\n"), "zai");
    expect(zai.success).toBe(false);
    expect(zai.stdout).toBe("");
    expect(zai.stderr).toContain("truncated or unrecognized");
  });

  test("stdout that opens with '[' but is not JSON keeps the escape hatch (ul7)", () => {
    // The ul7 line is JSON, not a leading bracket: an argv echo like
    // `[--safe-mode][--tools][]` is not a JSON array — not anything a
    // --output-format json launch would print — so it passes through like
    // any other plain text (cli-run.test.ts pins the same shape through
    // the real CLI), while a real array does not (the test above).
    const echo = finished("[--safe-mode][--tools][]\n");
    const out = claudeFamilyPlainResult(echo, "claude");
    expect(out).toEqual(echo);
    expect(out.usage).toBeUndefined();
  });

  test("an error result fails the run but still records its usage", () => {
    const out = claudeFamilyPlainResult(
      finished(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "" })),
      "claude"
    );
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("error_during_execution");
    expect(out.usage).toEqual(emptyUsage());
  });

  test("an error result prints the harness's error text, never the JSON wire (ul2)", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "the tool run failed after three retries",
      usage: { input_tokens: 10, output_tokens: 2 },
      total_cost_usd: 0.01,
    });
    const out = claudeFamilyPlainResult(finished(envelope), "claude");
    expect(out.success).toBe(false);
    // The stdout contract holds on failure: the error text plain mode
    // would have printed, and nothing else — the envelope never leaks.
    expect(out.stdout).toBe("the tool run failed after three retries\n");
    expect(out.stdout).not.toContain('"type"');
    expect(out.stderr).toContain("error_during_execution");
    expect(out.usage!.input_tokens).toBe(10);
  });

  test("a result with no text is a failed run, not an empty success", () => {
    const out = claudeFamilyPlainResult(
      finished(JSON.stringify({ type: "result", result: "   " })),
      "zai"
    );
    expect(out.success).toBe(false);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("no result text");
  });

  test("multiple served models report no single effective model", () => {
    const out = claudeFamilyPlainResult(
      finished(
        JSON.stringify({
          type: "result",
          result: "OK",
          modelUsage: { "claude-opus-5": {}, "claude-haiku-4": {} },
        })
      ),
      "claude"
    );
    expect(out.stdout).toBe("OK\n");
    expect(out.servedModel).toBeNull();
  });
});
