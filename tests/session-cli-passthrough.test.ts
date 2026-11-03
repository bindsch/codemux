/** The session command's harness-home passthrough refusals, split from
 * tests/session-cli-command.test.ts: a --pass-env home variable that is
 * empty, relative, or padded refuses before any spawn, because the
 * harness reads the variable without trimming or resolving it. */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSessionCommand } from "./helpers/session-command.js";

const fakeWithVersion = (version: string): string =>
  `if [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; exit 0; fi`;

describe("CLI - session home passthrough", () => {
  test("a KIMI_CODE_HOME passthrough that is empty is refused", async () => {
    const outcome = await runSessionCommand(
      ["-a", "kimi", "--pass-env", "KIMI_CODE_HOME"],
      { kimi: fakeWithVersion("0.31.1"), scode: "exit 9" },
      { env: { KIMI_CODE_HOME: "" } }
    );
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("KIMI_CODE_HOME must not be empty when passed through");
  });

  test("a KIMI_CODE_HOME passthrough that is relative is refused", async () => {
    const outcome = await runSessionCommand(
      ["-a", "kimi", "--pass-env", "KIMI_CODE_HOME"],
      { kimi: fakeWithVersion("0.31.1"), scode: "exit 9" },
      { env: { KIMI_CODE_HOME: "relative/path" } }
    );
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("KIMI_CODE_HOME must be an absolute path");
  });

  test("a padded CODEX_HOME passthrough is refused", async () => {
    const outcome = await runSessionCommand(
      ["-a", "codex", "--pass-env", "CODEX_HOME"],
      { codex: fakeWithVersion("codex-cli 0.159.3"), scode: "exit 9" },
      { env: { CODEX_HOME: `${join(tmpdir(), "padded")} ` } }
    );
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("CODEX_HOME must not be whitespace-padded when passed through");
  });
});
