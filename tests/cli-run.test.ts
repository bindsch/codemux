import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakeBinaryEnv,
  minimalPath,
  runCli,
} from "./helpers/cli.js";

describe("CLI - Run validation", () => {
  test("run without prompt shows error", async () => {
    const { stderr, exitCode } = await runCli(
      ["run"],
      { PATH: minimalPath() }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("No prompt provided");
  });

  test("run with unknown agent shows error", async () => {
    const { stderr, exitCode } = await runCli(["run", "-a", "unknown", "-p", "test"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unknown agent");
  });

  test("run with unavailable agent shows error", async () => {
    const { stderr, exitCode } = await runCli(
      ["run", "-a", "goose", "-p", "test"],
      { PATH: minimalPath() }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("not installed");
  });

  test("run -a shows valid agents in error", async () => {
    const { stderr } = await runCli(["run", "-a", "invalid", "-p", "test"]);
    expect(stderr).toContain("claude");
    expect(stderr).toContain("droid");
    expect(stderr).toContain("codex");
  });

  test("run with invalid autonomy level shows error", async () => {
    const { stderr, exitCode } = await runCli(["run", "--auto", "banana", "-p", "test"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid value 'banana' for --auto");
    expect(stderr).toContain("read-only");
  });

  test("run with invalid effort level shows error", async () => {
    const { stderr, exitCode } = await runCli(["run", "--effort", "extreme", "-p", "test"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid value 'extreme' for --effort");
    expect(stderr).toContain("none, minimal, low, medium, high, xhigh, max, ultra");
  });

  test("run with invalid sandbox trust level shows error", async () => {
    const { stderr, exitCode } = await runCli(["run", "--sandbox-trust", "danger", "-p", "test"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid value 'danger' for --sandbox-trust");
    expect(stderr).toContain("trusted, standard, untrusted");
  });

  test("Gemini read-only mode requires a durable outer sandbox", async () => {
    const { stderr, exitCode } = await runCli(
      ["run", "-a", "gemini", "--auto", "read-only", "-p", "test"],
      { PATH: minimalPath() }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(
      "gemini cannot enforce 'read-only' autonomy without --sandbox"
    );
  });

  test("run forwards Goose model selection through its environment", async () => {
    const fake = createFakeBinaryEnv({
      goose: `printf '%s' "\${GOOSE_MODEL-unset}"`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["run", "-a", "goose", "-m", "provider/model", "-p", "test"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("provider/model");
      expect(stderr).not.toContain("does not support model selection");
    } finally {
      fake.cleanup();
    }
  });

  test("passes only explicitly granted sensitive variables and blocks loaders", async () => {
    const fake = createFakeBinaryEnv({
      claude: `printf '%s|%s|%s' "\${INTERNAL_TOKEN-unset}" "\${BASH_ENV-unset}" "\${CODEMUX_PASSTHROUGH_ENV-unset}"`,
    });
    try {
      const result = await runCli(
        ["run", "-a", "claude", "--pass-env", "INTERNAL_TOKEN", "-p", "test"],
        {
          ...fake.env,
          INTERNAL_TOKEN: "allowed",
          BASH_ENV: "/repo/owned.sh",
          CODEMUX_PASSTHROUGH_ENV: "BASH_ENV",
        }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("allowed|unset|unset");
    } finally {
      fake.cleanup();
    }
  });

  test("legacy environment grants cannot authorize secret passthrough", async () => {
    const fake = createFakeBinaryEnv({
      claude: `printf '%s' "\${INTERNAL_TOKEN-unset}"`,
    });
    try {
      const result = await runCli(["run", "-a", "claude", "-p", "test"], {
        ...fake.env,
        INTERNAL_TOKEN: "must-not-pass",
        CODEMUX_PASSTHROUGH_ENV: "INTERNAL_TOKEN",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("unset");
    } finally {
      fake.cleanup();
    }
  });

  test("Playwright MCP requires an explicit sandboxed CLI grant", async () => {
    const fake = createFakeBinaryEnv({
      claude: "exit 0",
      scode: "printf '%s\\n' \"$@\"",
      "playwright-mcp": "exit 0",
    });
    try {
      const result = await runCli([
        "run",
        "-a",
        "claude",
        "--sandbox",
        "--enable-playwright-mcp",
        "-p",
        "test",
      ], fake.env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--mcp-config");
      const rejected = await runCli([
        "run",
        "-a",
        "claude",
        "--enable-playwright-mcp",
        "-p",
        "test",
      ], fake.env);
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr).toContain("requires --sandbox");
    } finally {
      fake.cleanup();
    }
  });

  test("run surfaces adapter errors without stack traces", async () => {
    const fake = createFakeBinaryEnv({
      claude: "exit 0",
    });
    const homeDir = mkdtempSync(join(tmpdir(), "codemux-zai-home-"));
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "zai", "-p", "test"],
        {
          ...fake.env,
          HOME: homeDir,
          ZAI_API_KEY: "",
        }
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Z.AI API key not found.");
      expect(stderr).not.toContain("at getZaiApiKey");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  test("run enforces its configured timeout", async () => {
    const fake = createFakeBinaryEnv({ claude: "sleep 2" });
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "claude", "-p", "test", "--timeout", "0.02"],
        fake.env
      );
      expect(exitCode).toBe(124);
      expect(stderr).toContain("timed out");
    } finally {
      fake.cleanup();
    }
  });

  test("sandbox resolves a relative cwd exactly once", async () => {
    const fake = createFakeBinaryEnv({
      claude: "exit 0",
      scode: "printf '%s\\n' \"$PWD\"; printf '%s\\n' \"$@\"",
    });
    try {
      const { stdout, exitCode } = await runCli(
        ["run", "-a", "claude", "-s", "--cwd", "tests", "-p", "test"],
        fake.env
      );
      const expected = join(import.meta.dir, "..", "tests");
      expect(exitCode).toBe(0);
      expect(stdout).toContain(expected);
      expect(stdout).not.toContain(join(expected, "tests"));
    } finally {
      fake.cleanup();
    }
  });
});

describe("CLI - Run warnings (no actual execution)", () => {
  test("effort flag on unsupported agent fails explicitly", async () => {
    const fake = createFakeBinaryEnv({ goose: "exit 0" });
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "goose", "--effort", "high", "-p", "test"],
        fake.env
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("does not support reasoning effort 'high'");
    } finally {
      fake.cleanup();
    }
  });
});

describe("CLI - File input validation", () => {
  test("run with nonexistent file shows error", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codemux-missing-file-"));
    try {
      const { stderr, exitCode } = await runCli([
        "run",
        "-f",
        join(tempDir, "missing.txt"),
      ], { PATH: minimalPath() });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Could not read file");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("run with file forwards file content as prompt", async () => {
    const fake = createFakeBinaryEnv({
      claude: "cat",
    });
    const tempDir = mkdtempSync(join(tmpdir(), "codemux-file-input-"));
    const promptFile = join(tempDir, "prompt.txt");
    writeFileSync(promptFile, "Prompt from file\n");

    try {
      const { stdout, exitCode } = await runCli(
        ["run", "-a", "claude", "-f", promptFile],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("Prompt from file\n");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  test("run rejects ambiguous prompt and file input", async () => {
    const fake = createFakeBinaryEnv({ claude: "exit 0" });
    const tempDir = mkdtempSync(join(tmpdir(), "codemux-prompt-conflict-"));
    const promptFile = join(tempDir, "prompt.txt");
    writeFileSync(promptFile, "file prompt");
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "claude", "-p", "inline", "-f", promptFile],
        fake.env
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("--prompt and --file cannot be used together");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      fake.cleanup();
    }
  });
});

describe("CLI - Check probe", () => {
  test("accepts an exact OK response", async () => {
    const fake = createFakeBinaryEnv({ claude: "printf 'OK'" });
    try {
      const { stdout, exitCode } = await runCli(["check", "-a", "claude"], fake.env);
      expect(exitCode).toBe(0);
      expect(stdout).toBe("OK\n");
    } finally {
      fake.cleanup();
    }
  });

  test("accepts an isolated OK line from verbose harness output", async () => {
    const fake = createFakeBinaryEnv({
      claude: "printf 'status banner\\nOK.\\nusage summary\\n'",
    });
    try {
      const { stdout, exitCode } = await runCli(
        ["check", "-a", "claude"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("OK\n");
    } finally {
      fake.cleanup();
    }
  });

  test("can probe sandbox-required Cursor mode", async () => {
    const fake = createFakeBinaryEnv({
      agent: "cat >/dev/null; printf 'OK\\n'",
      scode: "while [ \"$1\" != \"--\" ]; do shift; done; shift; exec \"$@\"",
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["check", "-a", "cursor", "--sandbox"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("OK\n");
      expect(stderr).toContain("sandboxed");
    } finally {
      fake.cleanup();
    }
  });

  test("rejects unrelated exit-zero output", async () => {
    const fake = createFakeBinaryEnv({ claude: "printf 'NOT_OK'" });
    try {
      const { stderr, exitCode } = await runCli(["check", "-a", "claude"], fake.env);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("unexpected response");
      expect(stderr).toContain("NOT_OK");
    } finally {
      fake.cleanup();
    }
  });

  test("preserves stdout diagnostics from a failed harness", async () => {
    const fake = createFakeBinaryEnv({
      claude: "printf 'authentication required\\n'; exit 2",
    });
    try {
      const { stderr, exitCode } = await runCli(
        ["check", "-a", "claude"],
        fake.env
      );
      expect(exitCode).toBe(2);
      expect(stderr).toContain("authentication required");
    } finally {
      fake.cleanup();
    }
  });

  test("enforces a bounded probe timeout", async () => {
    const fake = createFakeBinaryEnv({
      claude: "sleep 2",
    });
    try {
      const { stderr, exitCode } = await runCli(
        ["check", "-a", "claude", "--timeout", "0.02"],
        fake.env
      );
      expect(exitCode).toBe(124);
      expect(stderr).toContain("timed out");
    } finally {
      fake.cleanup();
    }
  });
});
