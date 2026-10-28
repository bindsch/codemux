import { describe, expect, test } from "bun:test";
import { KimiAdapter } from "../src/adapters/kimi.js";
import type { RunRequest, RunResult } from "../src/types.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

const adapter = new KimiAdapter({});
const request: RunRequest = { agent: "kimi", prompt: "Reply with exactly: OK" };

describe("Kimi headless reply output", () => {
  test.each([
    ["observed single-line reply", "• OK\n\n", "OK\n"],
    ["CRLF single-line reply", "• OK\r\n\r\n", "OK\n"],
    ["observed two-line reply", "• A\n  B\n\n", "A\nB\n"],
    ["CRLF multiple blocks", "• A\r\n  B\r\n\r\n• C\r\n", "A\nB\n\nC\n"],
    ["list continuation", "• A\n  - x\n  - y\n", "A\n- x\n- y\n"],
    ["multiple blocks", "• A\n  B\n\n• C\n  D\n\n\n", "A\nB\n\nC\nD\n"],
    ["adjacent blocks", "• A\n• B\n", "A\n\nB\n"],
    ["missing final newline", "• OK", "OK\n"],
    ["first-line content indentation", "•   A\n    B\n", "  A\n  B\n"],
    ["observed paragraph break", "• Alpha\n\n  Beta\n\n", "Alpha\n\nBeta\n"],
    [
      "multiple blocks with empty continuation lines",
      "• Alpha\n\n  Beta\n\n• Gamma\n\n  Delta\n\n",
      "Alpha\n\nBeta\n\nGamma\n\nDelta\n",
    ],
    ["nested bullet continuation", "• A\n  • B\n", "A\n• B\n"],
    ["plain reply", "OK\n\n", "OK\n\n"],
    ["CRLF plain reply", "OK\r\n\r\n", "OK\r\n\r\n"],
    ["unindented continuation", "• A\nB\n\n", "• A\nB\n\n"],
    ["CRLF unindented continuation", "• A\r\nB\r\n\r\n", "• A\r\nB\r\n\r\n"],
    ["plain text before a block", "banner\n• OK\n\n", "banner\n• OK\n\n"],
    ["plain text after blocks", "• A\n\n• B\nplain\n", "• A\n\n• B\nplain\n"],
    ["empty stdout", "", ""],
  ])("%s", (_name, stdout, expected) => {
    const result: RunResult = {
      stdout,
      stderr: "• diagnostic\n  keep this indentation\n\n",
      exitCode: 0,
      success: true,
    };
    expect(adapter.processRunResult(result, request, { harnessVersion: "2.3.2" })).toEqual({
      ...result,
      stdout: expected,
    });
  });

  test("preserves a failed run's status and metadata", () => {
    const result: RunResult = {
      stdout: "• partial reply\n\n",
      stderr: "failure\n",
      exitCode: 1,
      success: false,
      servedModel: "kimi-test-model",
    };
    expect(adapter.processRunResult(result, request, { harnessVersion: "2.3.2" })).toEqual({
      ...result,
      stdout: "partial reply\n",
    });
  });

  test.each(["0.31.1", "1.0.0", null, undefined])(
    "preserves bullet replies at version %s",
    (harnessVersion) => {
      const result: RunResult = {
        stdout: "• A\n  B\n\n", stderr: "", exitCode: 0, success: true,
      };
      expect(adapter.processRunResult(result, request, { harnessVersion })).toBe(result);
    }
  );

  test("preserves bullet replies without a run context", () => {
    const result: RunResult = {
      stdout: "• OK\n\n", stderr: "", exitCode: 0, success: true,
    };
    expect(adapter.processRunResult(result, request)).toBe(result);
  });

  test("normalizes bullet replies above major version 2", () => {
    const result: RunResult = {
      stdout: "• OK\n\n", stderr: "", exitCode: 0, success: true,
    };
    expect(adapter.processRunResult(result, request, { harnessVersion: "3.0.0" }).stdout)
      .toBe("OK\n");
  });

  test.each([
    ["2.3.2", "OK\n"],
    ["0.31.1", "• OK\n\n"],
    ["1.0.0", "• OK\n\n"],
    [null, "• OK\n\n"],
  ] as const)("launches with the probed version %s", async (version, expected) => {
    const fake = createFakeBinaryEnv({
      kimi: `if [ "$1" = "--version" ]; then ${version === null ? "exit 1" : `printf '${version}\\n'; exit 0`}; fi
printf '• OK\\n\\n'`,
      scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
    });
    try {
      for (const mode of ["--no-sandbox", "--sandbox"]) {
        const result = await runCli([
          "run", "-a", "kimi", mode, "--auto", "high", "-p", request.prompt,
        ], fake.env);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(expected);
      }
    } finally {
      fake.cleanup();
    }
  });

  test.each(["--no-sandbox", "--sandbox"])(
    "check accepts a Kimi 2.3.2 bullet reply with %s",
    async (mode) => {
      const fake = createFakeBinaryEnv({
        kimi: `if [ "$1" = "--version" ]; then printf '2.3.2\\n'; exit 0; fi
printf '• OK\\n\\n'`,
        scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
      });
      try {
        const result = await runCli([
          "check", "-a", "kimi", mode, "--auto", "high",
        ], fake.env);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("OK\n");
      } finally {
        fake.cleanup();
      }
    }
  );
});
