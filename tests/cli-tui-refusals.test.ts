import { describe, expect, test } from "bun:test";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

describe("CLI - tui pre-launch usage refusals exit 64", () => {
  // The same class run refuses: a caller mistake, refused before anything
  // launches. Each row's refusal fires before the TUI child would spawn,
  // so the fake binaries only satisfy the installation gate.
  const refusalCases: {
    label: string;
    binaries: Record<string, string>;
    argv: string[];
    env?: Record<string, string>;
    message: string;
  }[] = [
    {
      label: "unknown agent",
      binaries: {},
      argv: ["tui", "-a", "nope"],
      message: "Unknown agent 'nope'",
    },
    {
      label: "model selection the TUI cannot carry",
      binaries: { droid: "exit 0" },
      argv: ["tui", "-a", "droid", "-m", "gpt5", "--no-sandbox", "--auto", "high"],
      message: "droid does not support model selection in TUI mode",
    },
    {
      // Review round 4, contracts-2 finding 1: the model-name validator
      // is a usage refusal on tui too, not a run-only crash.
      label: "a model name with padding",
      binaries: { claude: "exit 0" },
      argv: ["tui", "-a", "claude", "-m", " bad ", "--no-sandbox", "--auto", "high"],
      message: "invalid model name",
    },
    {
      // Review round 4, contracts-2 finding 1: an inaccessible --cwd is
      // refused 64 before the TUI child spawns.
      label: "a --cwd that does not exist",
      binaries: { claude: "exit 0" },
      argv: ["tui", "-a", "claude", "--cwd", "/definitely/not/a/dir", "--no-sandbox", "--auto", "high"],
      message: "cwd is not accessible",
    },
    {
      label: "autonomy below high without --sandbox",
      binaries: { opencode: "exit 0" },
      argv: ["tui", "-a", "opencode", "--no-sandbox", "--auto", "read-only"],
      message: "opencode cannot enforce 'read-only' autonomy without --sandbox",
    },
    {
      label: "relative CLAUDE_CONFIG_DIR passed through",
      binaries: { claude: "exit 0" },
      argv: ["tui", "-a", "claude", "--no-sandbox", "--auto", "high", "--pass-env", "CLAUDE_CONFIG_DIR"],
      env: { CLAUDE_CONFIG_DIR: "relative/path" },
      message: "CLAUDE_CONFIG_DIR must be an absolute path when passed through",
    },
    {
      label: "playwright MCP without --sandbox",
      binaries: { claude: "exit 0" },
      argv: ["tui", "-a", "claude", "--no-sandbox", "--auto", "high", "--enable-playwright-mcp"],
      message: "--enable-playwright-mcp requires --sandbox",
    },
    {
      label: "playwright MCP on an agent that cannot carry it",
      binaries: { codex: "exit 0" },
      argv: ["tui", "-a", "codex", "--enable-playwright-mcp"],
      message: "--enable-playwright-mcp is supported only by claude and zai",
    },
    {
      // Review round 5, contracts-2 finding 2 sweep: the provider override
      // supports headless runs only, and the TUI refusal of it is a usage
      // refusal (exit 64), not a plain failure.
      label: "a droid provider override in TUI mode",
      binaries: { droid: "exit 0" },
      argv: ["tui", "-a", "droid", "--no-sandbox", "--auto", "high"],
      env: {
        CODEMUX_DROID_PROVIDER_BASE_URL: "https://provider.test/v1",
        CODEMUX_DROID_PROVIDER_API_KEY: "sk-test",
        CODEMUX_DROID_PROVIDER_MODEL: "glm-5.3",
      },
      message: "the droid provider override supports headless runs only",
    },
    {
      // Review round 8, contracts-2 finding 1: a model-less claude
      // provider override exits 64 in TUI mode too, not 1.
      label: "a claude provider override without a model",
      binaries: { claude: "exit 0" },
      argv: ["tui", "-a", "claude", "--no-sandbox", "--auto", "high"],
      env: {
        CODEMUX_CLAUDE_PROVIDER_BASE_URL: "https://provider.test/v1",
        CODEMUX_CLAUDE_PROVIDER_API_KEY: "sk-test",
      },
      message: "claude needs a model for the provider override",
    },
    {
      // The run command's refusal (audit round 2, A8): the argv print is a
      // property of the sandboxed spawn, so an unsandboxed TUI cannot
      // carry it and must refuse by name, not with a parse error.
      label: "print-sandbox without --sandbox",
      binaries: { claude: "exit 0" },
      argv: ["tui", "-a", "claude", "--no-sandbox", "--auto", "high", "--print-sandbox"],
      message: "--print-sandbox requires --sandbox",
    },
  ];
  test.each(refusalCases)("$label", async ({ binaries, argv, env, message }) => {
    const fake = createFakeBinaryEnv(binaries);
    try {
      const { stderr, exitCode } = await runCli(argv, { ...fake.env, ...env });
      expect(exitCode).toBe(64);
      expect(stderr).toContain(message);
    } finally {
      fake.cleanup();
    }
  });

  test("--sandbox-block rides the printed scode argv and nothing runs", async () => {
    // Audit round 2, A8: --sandbox-block and --print-sandbox used to be
    // run-only flags, so the same operator request was a parse error (exit
    // 1) on tui. Both are carried now: the print shows the scode argv a
    // real sandboxed TUI would exec, block path included.
    const fake = createFakeBinaryEnv({
      claude: `if [ "$1" = "--version" ]; then printf '2.1.220 (Claude Code)\\n'; exit 0; fi
exit 7`,
      scode: "exit 9",
    });
    try {
      const { stdout, exitCode } = await runCli(
        ["tui", "-a", "claude", "--print-sandbox", "--sandbox-block", "/secrets"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("--block");
      expect(stdout).toContain("/secrets");
      // One argument per line: the wrapped command is the resolved
      // absolute path, and an exit 7 claude / exit 9 scode never ran.
      expect(stdout).toContain("/claude\n");
    } finally {
      fake.cleanup();
    }
  });
});
