import { describe, expect, test } from "bun:test";
import { codexPlainResult } from "../src/plain-unwrap.js";

describe("codexPlainResult", () => {
  // A plain run keeps human mode (review ul3): stdout is the reply verbatim
  // and the usage is the `tokens used` figure codex prints on stderr at the
  // run's end. The stream-reduction tests live with codexResult in
  // result-envelope.test.ts; these pin the plain path.
  const stderrWithFigure = (figure: string): string =>
    `working...\ntokens used\n${figure}\n`;

  test("passes human-mode stdout through verbatim and records the stderr figure", () => {
    const out = codexPlainResult({
      stdout: "the reply\n",
      stderr: stderrWithFigure("2,048"),
      exitCode: 0,
      success: true,
    });
    expect(out.stdout).toBe("the reply\n");
    expect(out.success).toBe(true);
    // The figure is blended — (input − cached) + output — so it lands in
    // total_tokens alone; the parts cannot be recovered and stay null.
    expect(out.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: 2048,
      cost_usd: null,
    });
    expect(out.servedModel).toBeNull();
  });

  test("a stderr without the figure records nothing", () => {
    const raw = { stdout: "the reply\n", stderr: "no summary here\n", exitCode: 0, success: true };
    expect(codexPlainResult(raw)).toEqual(raw);
    expect(codexPlainResult(raw).usage).toBeUndefined();
  });

  test("the label matches after ANSI styling and locale separators parse", () => {
    const styled = {
      stdout: "the reply\n",
      stderr: `\x1b[90mtokens used\x1b[0m\n\x1b[90m2'048\x1b[0m\n`,
      exitCode: 0,
      success: true,
    };
    expect(codexPlainResult(styled).usage!.total_tokens).toBe(2048);
    const narrow = {
      stdout: "the reply\n",
      stderr: `tokens used\n2 048\n`,
      exitCode: 0,
      success: true,
    };
    expect(codexPlainResult(narrow).usage!.total_tokens).toBe(2048);
  });

  test("the figure must be a separated number, else nothing is recorded", () => {
    const words = {
      stdout: "the reply\n",
      stderr: stderrWithFigure("2,048 tokens"),
      exitCode: 0,
      success: true,
    };
    expect(codexPlainResult(words).usage).toBeUndefined();
  });

  test("the last label wins when stderr repeats it", () => {
    const chatty = {
      stdout: "the reply\n",
      stderr: `tokens used\n999\nharness chatter\ntokens used\n515\n`,
      exitCode: 0,
      success: true,
    };
    // The scan runs from the end: the run's own trailing figure, not an
    // earlier line the transcript embedded.
    expect(codexPlainResult(chatty).usage!.total_tokens).toBe(515);
  });
});
