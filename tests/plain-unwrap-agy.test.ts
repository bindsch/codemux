import { describe, expect, test } from "bun:test";
import { agyPlainResult } from "../src/plain-unwrap.js";
import { finished } from "./helpers/plain-unwrap.js";

describe("agyPlainResult", () => {
  test("unwraps the response field to the reply with usage", () => {
    // agy's input_tokens includes the cache reads; the normalized block
    // splits them apart (result-envelope.ts's documented arithmetic).
    const out = agyPlainResult(
      finished(
        JSON.stringify({
          status: "SUCCESS",
          response: "done",
          usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 2 },
        })
      )
    );
    expect(out.stdout).toBe("done\n");
    expect(out.success).toBe(true);
    expect(out.usage).toEqual({
      input_tokens: 8,
      output_tokens: 4,
      cached_input_tokens: 2,
      total_tokens: 14,
      cost_usd: null,
    });
  });

  test("stdout that is not the agy envelope passes through verbatim", () => {
    const out = agyPlainResult(finished("done\n"));
    expect(out).toEqual({ ...finished("done\n"), reply: "" });
    expect(out.usage).toBeUndefined();
  });

  test("a zero-exit run that printed nothing is a failed run, not an empty success (round 259)", () => {
    // The claude family's empty-success rule (round 259) in agy's twin:
    // empty stdout took the escape hatch and kept a success with no reply.
    for (const stdout of ["", "  \n"]) {
      const out = agyPlainResult(finished(stdout));
      expect(out.success, JSON.stringify(stdout)).toBe(false);
      expect(out.exitCode, JSON.stringify(stdout)).toBe(1);
      expect(out.stdout, JSON.stringify(stdout)).toBe("");
      expect(out.stderr, JSON.stringify(stdout)).toContain("produced no output");
    }
    const failedRun = { stdout: "", stderr: "boom", exitCode: 2, success: false };
    expect(agyPlainResult(failedRun)).toEqual({ ...failedRun, reply: "" });
  });

  test("an error status fails the run", () => {
    const out = agyPlainResult(
      finished(JSON.stringify({ status: "ERROR", error: "quota", response: null }))
    );
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("quota");
  });

  test("an error status prints the response text, never the JSON wire; no response prints nothing (ul2)", () => {
    const withText = agyPlainResult(
      finished(
        JSON.stringify({ status: "ERROR", error: "quota", response: "the partial answer" })
      )
    );
    expect(withText.success).toBe(false);
    expect(withText.stdout).toBe("the partial answer\n");
    expect(withText.stdout).not.toContain('"status"');
    const withoutText = agyPlainResult(
      finished(JSON.stringify({ status: "ERROR", error: "quota", response: null }))
    );
    expect(withoutText.success).toBe(false);
    expect(withoutText.stdout).toBe("");
  });

  test("a truncated envelope never passes through: failed run, empty stdout (ul4)", () => {
    // The envelope is one JSON object, so a kill or the capture cap leaves
    // a `{`-shaped stdout the parser cannot take. Before ul4 it passed
    // through verbatim as a successful reply.
    const cut = `{"status":"SUCCESS","response":"the rea`;
    const out = agyPlainResult({ stdout: cut, stderr: "", exitCode: 124, success: false });
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(124);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("truncated or unrecognized");
    expect(out.usage).toBeUndefined();
  });

  test("a complete JSON object that is not the agy envelope fails the same way (ul4)", () => {
    const out = agyPlainResult(finished('{"foo":1}\n'));
    expect(out.success).toBe(false);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("truncated or unrecognized");
  });

  test("a JSON array on agy stdout fails like every other JSON non-envelope (ul7)", () => {
    // The claude family's ul7 defect, checked in agy's twin: the hatch
    // opened for any stdout without a leading `{`, so an array passed
    // through as the reply with no usage.
    const out = agyPlainResult(finished('[{"status":"SUCCESS"}]\n'));
    expect(out.success).toBe(false);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("truncated or unrecognized");
    expect(out.usage).toBeUndefined();
  });
});
