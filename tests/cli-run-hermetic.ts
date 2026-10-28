import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakeBinaryEnv,
  runCli,
} from "./helpers/cli.js";

describe("CLI - Hermetic runs", () => {
  test("run --hermetic is refused for a harness without a verified mechanism", async () => {
    const fake = createFakeBinaryEnv({ droid: "exit 0", copilot: "exit 0" });
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "droid", "--no-sandbox", "--auto", "high", "--hermetic", "-p", "test"],
        fake.env
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("no verified hermetic mode");
      const tools = await runCli(
        ["run", "-a", "copilot", "--no-sandbox", "--auto", "high", "--tools", "none", "-p", "test"],
        fake.env
      );
      expect(tools.exitCode).not.toBe(0);
      expect(tools.stderr).toContain("cannot remove its built-in tools");
    } finally {
      fake.cleanup();
    }
  });

  test("run --hermetic --tools none reaches claude as --safe-mode and an empty --tools", async () => {
    const fake = createFakeBinaryEnv({ claude: "cat >/dev/null; printf '[%s]' \"$@\"" });
    try {
      const { stdout, exitCode } = await runCli(
        ["run", "-a", "claude", "--no-sandbox", "--auto", "high", "--hermetic", "--tools", "none", "-p", "test"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("[--safe-mode][--setting-sources][user]");
      expect(stdout).toContain("[--tools][]");
    } finally {
      fake.cleanup();
    }
  });

  test("run rejects an unknown --tools value", async () => {
    const { stderr, exitCode } = await runCli(["run", "--tools", "some", "-p", "test"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid value 'some' for --tools");
  });

  // A stand-in harness: with --safe-mode it answers OK, otherwise it repeats
  // the code word planted in the working directory's CLAUDE.md.
  const canaryAwareClaude =
    "cat >/dev/null; for a in \"$@\"; do [ \"$a\" = --safe-mode ] && { printf 'OK\\n'; exit 0; }; done; " +
    "grep -o 'CODEMUX-CANARY-[A-Z0-9]*' CLAUDE.md";

  test("check --hermetic passes when the hermetic probe is clean and the control leaks", async () => {
    const fake = createFakeBinaryEnv({ claude: canaryAwareClaude });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["check", "-a", "claude", "--no-sandbox", "--auto", "high", "--hermetic"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("HERMETIC claude: OK\n");
      expect(stderr).toContain("planted code word CODEMUX-CANARY-");
      expect(stderr).toContain("control: planted code word reached the model");
    } finally {
      fake.cleanup();
    }
  });

  test("check --hermetic fails when the planted code word reaches a hermetic run", async () => {
    const fake = createFakeBinaryEnv({
      claude: "cat >/dev/null; grep -o 'CODEMUX-CANARY-[A-Z0-9]*' CLAUDE.md",
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["check", "-a", "claude", "--no-sandbox", "--auto", "high", "--hermetic"],
        fake.env
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("NOT hermetic");
      expect(stderr).toContain("the planted code word reached the model");
    } finally {
      fake.cleanup();
    }
  });

  test("check --hermetic reports a name the model answered instead of OK", async () => {
    const fake = createFakeBinaryEnv({ claude: "cat >/dev/null; printf 'Some Owner\\n'" });
    try {
      const { stderr, exitCode } = await runCli(
        ["check", "-a", "claude", "--no-sandbox", "--auto", "high", "--hermetic"],
        fake.env
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("the model answered 'Some Owner'");
    } finally {
      fake.cleanup();
    }
  });

  test("check --hermetic fails when the control request fails", async () => {
    const fake = createFakeBinaryEnv({
      claude: "cat >/dev/null; for a in \"$@\"; do [ \"$a\" = --safe-mode ] && { printf 'OK\\n'; exit 0; }; done; echo boom >&2; exit 23",
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["check", "-a", "claude", "--no-sandbox", "--auto", "high", "--hermetic"],
        fake.env
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("proved nothing: the request failed (exit 23)");
      expect(stderr).toContain("boom");
    } finally {
      fake.cleanup();
    }
  });

  test("check --hermetic fails when the control is clean too", async () => {
    const fake = createFakeBinaryEnv({ claude: "cat >/dev/null; printf 'OK\\n'" });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["check", "-a", "claude", "--no-sandbox", "--auto", "high", "--hermetic"],
        fake.env
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("proved nothing: clean too");
    } finally {
      fake.cleanup();
    }
  });

  test("check --hermetic fails when the control answers without the planted code word", async () => {
    const fake = createFakeBinaryEnv({
      claude: "cat >/dev/null; for a in \"$@\"; do [ \"$a\" = --safe-mode ] && { printf 'OK\\n'; exit 0; }; done; printf 'I cannot determine that\\n'",
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["check", "-a", "claude", "--no-sandbox", "--auto", "high", "--hermetic"],
        fake.env
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("proved nothing: answered 'I cannot determine that' without the planted code word");
    } finally {
      fake.cleanup();
    }
  });

  test("check --hermetic hands the planted directory to claude as --add-dir", async () => {
    const fake = createFakeBinaryEnv({
      claude: "cat >/dev/null; d=''; while [ $# -gt 0 ]; do [ \"$1\" = --safe-mode ] && { printf 'OK\\n'; exit 0; }; [ \"$1\" = --add-dir ] && d=$2; shift; done; grep -o 'CODEMUX-CANARY-[A-Z0-9]*' \"$d/CLAUDE.md\"",
    });
    try {
      const { stdout, exitCode } = await runCli(
        ["check", "-a", "claude", "--no-sandbox", "--auto", "high", "--hermetic"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("HERMETIC claude: OK\n");
    } finally {
      fake.cleanup();
    }
  });

  // A stand-in opencode: under the hermetic run's permission deny it answers
  // OK; on a plain run (no deny in the environment) it leaks the code word
  // planted in the working directory.
  const canaryAwareOpencode =
    'if [ "$1" = --version ]; then printf "opencode 1.18.18\\n"; exit 0; fi\n' +
    "cat >/dev/null\n" +
    'case "$OPENCODE_PERMISSION" in *"deny"*) printf "OK\\n"; exit 0;; esac\n' +
    "grep -ho 'CODEMUX-CANARY-[A-Z0-9]*' AGENTS.md CLAUDE.md";

  test("check --hermetic --tools none runs the control with the same --tools none", async () => {
    // The control varies --hermetic alone (h7 review): with --tools none
    // given, both probes carry it, so a leaking control proves the planted
    // files reached the model without any tool — the attribution that makes
    // the hermetic probe's clean OK mean isolation, not tool removal. The
    // stand-in claude logs its arguments so the control's own command is
    // asserted, not just the verdict lines.
    const tempDir = mkdtempSync(join(tmpdir(), "codemux-control-argv-"));
    const argvLog = join(tempDir, "argv.log");
    const fake = createFakeBinaryEnv({
      claude:
        'if [ "$1" = --version ]; then printf "2.1.280\\n"; exit 0; fi; ' +
        `cat >/dev/null; printf '%s\\n' "$@" >> ${argvLog}; printf '===\\n' >> ${argvLog}; ` +
        'for a in "$@"; do [ "$a" = --safe-mode ] && { printf "OK\\n"; exit 0; }; done; ' +
        "grep -o 'CODEMUX-CANARY-[A-Z0-9]*' CLAUDE.md",
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["check", "-a", "claude", "--no-sandbox", "--auto", "high", "--hermetic", "--tools", "none"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("HERMETIC claude: OK\n");
      expect(stderr).toContain("control: planted code word reached the model");
      const invocations = readFileSync(argvLog, "utf8")
        .split("===\n")
        .filter((block) => block.trim().length > 0);
      expect(invocations).toHaveLength(2);
      const control = invocations.find((block) => !block.includes("--safe-mode\n"));
      expect(control).toBeDefined();
      const args = control!.split("\n");
      const toolsIndex = args.indexOf("--tools");
      expect(toolsIndex).toBeGreaterThanOrEqual(0);
      expect(args[toolsIndex + 1]).toBe("");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  test("check --hermetic --tools none refuses opencode before probing", async () => {
    // opencode scopes --tools none to hermetic runs, so the control cannot
    // carry the same selection without --hermetic; the check refuses the
    // combination up front instead of running an armed control (h7 review).
    const fake = createFakeBinaryEnv({ opencode: canaryAwareOpencode });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["check", "-a", "opencode", "--no-sandbox", "--auto", "high", "--hermetic", "--tools", "none"],
        fake.env
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("check --hermetic --tools none cannot run for opencode");
      expect(stderr).toContain("plain --tools none run, which opencode refuses");
      expect(stderr).not.toContain("Checking opencode hermetically");
    } finally {
      fake.cleanup();
    }
  });

  test("run --tools none refuses the Playwright MCP", async () => {
    const fake = createFakeBinaryEnv({ claude: "exit 0", scode: "exit 0", "playwright-mcp": "exit 0" });
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "claude", "--sandbox", "--enable-playwright-mcp", "--tools", "none", "-p", "test"],
        fake.env
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("cannot be combined with --enable-playwright-mcp");
    } finally {
      fake.cleanup();
    }
  });

  test("check --hermetic refuses an unsupported harness before probing", async () => {
    const fake = createFakeBinaryEnv({ droid: "printf 'OK\\n'" });
    try {
      const { stderr, exitCode } = await runCli(
        ["check", "-a", "droid", "--no-sandbox", "--auto", "high", "--hermetic"],
        fake.env
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("no verified hermetic mode");
      expect(stderr).not.toContain("Checking");
    } finally {
      fake.cleanup();
    }
  });
});
