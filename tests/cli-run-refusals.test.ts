import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createFakeBinaryEnv,
  minimalPath,
  runCli,
} from "./helpers/cli.js";

// A valid codex experiment spec: the flag-combination refusals below fire
// only after the spec's header opt-in passes (the spec read is first).
const codexSpec = (() => {
  const directory = mkdtempSync(join(resolve("scratch"), "exit64-spec-"));
  const path = join(directory, "spec.json");
  writeFileSync(path, JSON.stringify({
    name: "experiment", command: process.execPath, args: [], env: [],
    accept_harness_prefix: ["codex-wall-time"],
  }));
  return path;
})();
process.on("exit", () => rmSync(codexSpec, { recursive: true, force: true }));

// Specs refused by their own content, not by the flag combinations: a file
// that does not parse, and a codex spec missing its harness-prefix opt-in.
const badSpecs = (() => {
  const directory = mkdtempSync(join(resolve("scratch"), "exit64-spec-"));
  const unparseable = join(directory, "unparseable.json");
  writeFileSync(unparseable, "{\"name\": ");
  const noPrefix = join(directory, "no-prefix.json");
  writeFileSync(noPrefix, JSON.stringify({ name: "experiment", command: process.execPath, args: [], env: [] }));
  const unknownField = join(directory, "unknown-field.json");
  writeFileSync(unknownField, JSON.stringify({
    name: "experiment", command: process.execPath, args: [], env: [], surprise: true,
  }));
  return { unparseable, noPrefix, unknownField, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
})();
process.on("exit", badSpecs.cleanup);

// A working tree carrying harness execution configuration (copilot's
// .mcp.json): the project-safety walk refuses it before any spawn.
const projectTree = (() => {
  const directory = mkdtempSync(join(resolve("scratch"), "exit64-tree-"));
  writeFileSync(join(directory, ".mcp.json"), "{}");
  return directory;
})();
process.on("exit", () => rmSync(projectTree, { recursive: true, force: true }));

// A working tree carrying project scode policy: sandboxed execution in it
// is refused before scode resolves (review round 17, contracts-2 2).
const scodePolicyTree = (() => {
  const directory = mkdtempSync(join(resolve("scratch"), "exit64-scode-"));
  writeFileSync(join(directory, ".scode.yaml"), "allowed:\n  - /tmp\n");
  return directory;
})();
process.on("exit", () => rmSync(scodePolicyTree, { recursive: true, force: true }));

describe("CLI - run pre-launch usage refusals exit 64", () => {
  // One exit code (64) for every pre-launch refusal of a caller mistake,
  // so a script can tell a request only the caller can fix from a run
  // that failed. Each row needs its agent installed (a fake binary),
  // except the unknown-agent gate, which fires first.
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
      argv: ["run", "-a", "nope", "-p", "test"],
      message: "Unknown agent 'nope'",
    },
    {
      label: "autonomy below high without --sandbox",
      binaries: { opencode: "exit 0" },
      argv: ["run", "-a", "opencode", "--no-sandbox", "--auto", "read-only", "-p", "test"],
      message: "opencode cannot enforce 'read-only' autonomy without --sandbox",
    },
    {
      label: "unsupported hermetic request",
      binaries: { droid: "exit 0" },
      argv: ["run", "-a", "droid", "--no-sandbox", "--auto", "high", "--hermetic", "-p", "test"],
      message: "droid has no verified hermetic mode",
    },
    {
      label: "unsupported tools none request",
      binaries: { cline: "exit 0" },
      argv: ["run", "-a", "cline", "--no-sandbox", "--auto", "high", "--tools", "none", "-p", "test"],
      message: "cline cannot remove its built-in tools",
    },
    {
      label: "unsupported result-json request",
      binaries: { droid: "exit 0" },
      argv: ["run", "-a", "droid", "--no-sandbox", "--auto", "high", "--result-json", "-p", "test"],
      message: "droid cannot return a structured result envelope",
    },
    {
      label: "provider override on an agent that cannot carry one",
      binaries: { gemini: "exit 0" },
      argv: ["run", "-a", "gemini", "--no-sandbox", "--auto", "high", "-p", "test"],
      env: { CODEMUX_GEMINI_PROVIDER_MODEL: "glm" },
      message: "gemini does not support a provider override",
    },
    {
      label: "relative CODEX_HOME passed through",
      binaries: { codex: "exit 0" },
      argv: ["run", "-a", "codex", "--no-sandbox", "--auto", "high", "--pass-env", "CODEX_HOME", "-p", "test"],
      env: { CODEX_HOME: "relative/path" },
      message: "CODEX_HOME must be an absolute path",
    },
    {
      label: "relative CLAUDE_CONFIG_DIR passed through",
      binaries: { claude: "exit 0" },
      argv: ["run", "-a", "claude", "--no-sandbox", "--auto", "high", "--pass-env", "CLAUDE_CONFIG_DIR", "-p", "test"],
      env: { CLAUDE_CONFIG_DIR: "relative/path" },
      message: "CLAUDE_CONFIG_DIR must be an absolute path when passed through",
    },
    {
      label: "an empty --pass-env list",
      binaries: { claude: "exit 0" },
      argv: ["run", "-a", "claude", "-p", "test", "--pass-env", ","],
      message: "--pass-env requires 1 to 64 comma-separated names",
    },
    {
      label: "a relative --sandbox-block path",
      binaries: { claude: "exit 0" },
      argv: ["run", "-a", "claude", "-p", "test", "--sandbox", "--sandbox-block", "relative/path"],
      message: "--sandbox-block requires absolute paths",
    },
    {
      label: "a relative --sandbox-account path",
      binaries: { claude: "exit 0" },
      argv: ["run", "-a", "claude", "-p", "test", "--sandbox", "--sandbox-account", "sink.json"],
      message: "--sandbox-account requires an absolute path",
    },
    {
      label: "a --sandbox-account-id outside the scode charset",
      binaries: { claude: "exit 0" },
      argv: ["run", "-a", "claude", "-p", "test", "--sandbox", "--sandbox-account", "/tmp/sink.json", "--sandbox-account-id", "crew/job-42"],
      message: "--sandbox-account-id accepts 1-128 characters of letters, digits, and '. _ : -'",
    },
    {
      label: "a --sandbox-account-id without --sandbox-account",
      binaries: { claude: "exit 0" },
      argv: ["run", "-a", "claude", "-p", "test", "--sandbox", "--sandbox-account-id", "job-42"],
      message: "--sandbox-account-id without --sandbox-account",
    },
    {
      label: "playwright MCP on an agent that cannot carry it",
      binaries: { codex: "exit 0" },
      argv: ["run", "-a", "codex", "-p", "test", "--enable-playwright-mcp"],
      message: "--enable-playwright-mcp is supported only by claude and zai",
    },
    {
      label: "playwright MCP with --tools none",
      binaries: { claude: "exit 0" },
      argv: ["run", "-a", "claude", "-p", "test", "--hermetic", "--tools", "none", "--enable-playwright-mcp"],
      message: "--hermetic and --tools none cannot be combined with --enable-playwright-mcp",
    },
    {
      label: "--print-sandbox without --sandbox",
      binaries: { claude: "exit 0" },
      argv: ["run", "-a", "claude", "-p", "test", "--no-sandbox", "--auto", "high", "--print-sandbox"],
      message: "--print-sandbox requires --sandbox",
    },
    {
      label: "project settings without hermetic mode",
      binaries: { claude: "exit 0" },
      argv: ["run", "-a", "claude", "-p", "test", "--experiment-project-settings", "--auto", "low"],
      message: "--experiment-project-settings requires --hermetic",
    },
    {
      // Review round 4, contracts-2 finding 1: the same bad model name
      // run once exited 1 for; the validator is a usage refusal now.
      label: "a model name with padding",
      binaries: { claude: "exit 0" },
      argv: ["run", "-a", "claude", "-m", " bad ", "--no-sandbox", "--auto", "high", "-p", "test"],
      message: "invalid model name",
    },
    {
      // Review round 21, contracts-2: an alias the agent has no mapping for
      // is the caller's mistake, refused 64, not a config error exit 1.
      label: "a model alias the agent has no mapping for",
      binaries: { codex: "exit 0" },
      argv: ["run", "-a", "codex", "-m", "sonnet", "--no-sandbox", "--auto", "high", "-p", "test"],
      message: "model alias 'sonnet' is not configured for agent 'codex'",
    },
    {
      // Review round 4, contracts-2 finding 1: an inaccessible --cwd is
      // the caller's mistake whatever the command, refused 64 pre-spawn.
      label: "a --cwd that does not exist",
      binaries: { claude: "exit 0" },
      argv: ["run", "-a", "claude", "-p", "test", "--cwd", "/definitely/not/a/dir", "--no-sandbox", "--auto", "high"],
      message: "cwd is not accessible",
    },
    {
      // Review round 5, contracts-2 finding 2: the plain-run --tools none
      // refusal used to be a plain Error (exit 1); every pre-launch
      // refusal of the request is 64.
      label: "opencode plain-run tools none",
      binaries: { opencode: "exit 0" },
      argv: ["run", "-a", "opencode", "--no-sandbox", "--auto", "high", "--tools", "none", "-p", "test"],
      message: "opencode --tools none requires --hermetic",
    },
    {
      // Review round 5, contracts-2 finding 2 sweep: opencode's
      // project-settings combination refusal.
      label: "opencode project settings without hermetic mode",
      binaries: { opencode: "exit 0" },
      argv: ["run", "-a", "opencode", "--no-sandbox", "--auto", "high", "--experiment-project-settings", "-p", "test"],
      message: "--experiment-project-settings requires --hermetic",
    },
    {
      // Review round 5, contracts-2 finding 2 sweep: a half-configured
      // provider override is the caller's environment mistake.
      label: "a provider override with only a model set",
      binaries: { codex: "exit 0" },
      argv: ["run", "-a", "codex", "--no-sandbox", "--auto", "high", "-p", "test"],
      env: { CODEMUX_CODEX_PROVIDER_MODEL: "glm-5.3" },
      message: "provider override is missing",
    },
    {
      // Review round 8, contracts-2 finding 1: a model-less claude
      // provider override used to exit 1; every provider-override
      // refusal is 64.
      label: "a claude provider override without a model",
      binaries: { claude: "exit 0" },
      argv: ["run", "-a", "claude", "--no-sandbox", "--auto", "high", "-p", "test"],
      env: {
        CODEMUX_CLAUDE_PROVIDER_BASE_URL: "https://provider.test/v1",
        CODEMUX_CLAUDE_PROVIDER_API_KEY: "sk-test",
      },
      message: "claude needs a model for the provider override",
    },
    {
      // Review round 8, contracts-2 finding 1 sweep: the same refusal on
      // another adapter that shares the throw.
      label: "a kimi provider override without a model",
      binaries: { kimi: "exit 0" },
      argv: ["run", "-a", "kimi", "--no-sandbox", "--auto", "high", "-p", "test"],
      env: {
        CODEMUX_KIMI_PROVIDER_BASE_URL: "https://provider.test/v1",
        CODEMUX_KIMI_PROVIDER_API_KEY: "sk-test",
      },
      message: "kimi needs a model for the provider override",
    },
    {
      // Review round 5, contracts-2 finding 2 sweep: a model the config
      // file cannot carry verbatim.
      label: "a brace model name under an opencode provider override",
      binaries: { opencode: "exit 0" },
      argv: ["run", "-a", "opencode", "--no-sandbox", "--auto", "high", "-m", "{bad}", "-p", "test"],
      env: {
        CODEMUX_OPENCODE_PROVIDER_BASE_URL: "https://provider.test/v1",
        CODEMUX_OPENCODE_PROVIDER_API_KEY: "sk-test",
        CODEMUX_OPENCODE_PROVIDER_MODEL: "glm-5.3",
      },
      message: "must not contain '{' or '}'",
    },
    {
      // Review round 5, contracts-2 finding 2 sweep: agy's isolation
      // combination refusals.
      label: "agy isolation without read-only scode",
      binaries: { agy: "exit 0" },
      argv: ["run", "-a", "agy", "--no-sandbox", "--auto", "high", "--tools", "none", "-p", "test"],
      message: "agy isolation requires read-only scode (--auto read-only)",
    },
    {
      // Review round 3, contracts-2 finding 6: every refusal of the
      // request is 64, the experiment flag combinations included.
      label: "experiment MCP without the required isolation bundle",
      binaries: { claude: "exit 0" },
      argv: ["run", "-a", "claude", "-p", "test", "--hermetic", "--experiment-mcp", "/does/not/exist.json"],
      message: "--experiment-mcp requires --hermetic --tools none --auto read-only with scode",
    },
    {
      label: "experiment MCP with --sandbox-no-net on codex",
      binaries: { codex: "exit 0" },
      argv: ["run", "-a", "codex", "-p", "test", "--hermetic", "--tools", "none",
        "--auto", "read-only", "--experiment-mcp", codexSpec, "--sandbox-no-net"],
      message: "uses a loopback HTTP relay and refuses --sandbox-no-net",
    },
    {
      label: "experiment MCP with --sandbox-trust untrusted on codex",
      binaries: { codex: "exit 0" },
      argv: ["run", "-a", "codex", "-p", "test", "--hermetic", "--tools", "none",
        "--auto", "read-only", "--experiment-mcp", codexSpec, "--sandbox-trust", "untrusted"],
      message: "uses a loopback HTTP relay and refuses --sandbox-trust untrusted",
    },
    {
      // The spec's own content is a caller mistake too, so the whole
      // experiment-mcp feature refuses with one code.
      label: "an experiment MCP spec that does not parse",
      binaries: { claude: "exit 0" },
      argv: ["run", "-a", "claude", "-p", "test", "--hermetic", "--tools", "none",
        "--auto", "read-only", "--experiment-mcp", badSpecs.unparseable],
      message: "experiment MCP spec does not parse as JSON",
    },
    {
      label: "an experiment MCP spec with an unknown field",
      binaries: { claude: "exit 0" },
      argv: ["run", "-a", "claude", "-p", "test", "--hermetic", "--tools", "none",
        "--auto", "read-only", "--experiment-mcp", badSpecs.unknownField],
      message: "experiment MCP spec requires name, absolute command",
    },
    {
      label: "experiment MCP on a harness with no mechanism",
      binaries: { droid: "exit 0" },
      argv: ["run", "-a", "droid", "--no-sandbox", "--auto", "high", "-p", "test",
        "--experiment-mcp", badSpecs.noPrefix],
      message: "--experiment-mcp is unavailable: droid",
    },
    {
      label: "experiment MCP on codex without the wall-time opt-in",
      binaries: { codex: "exit 0" },
      argv: ["run", "-a", "codex", "--no-sandbox", "--auto", "high", "-p", "test",
        "--experiment-mcp", badSpecs.noPrefix],
      message: '--experiment-mcp on codex requires accept_harness_prefix: ["codex-wall-time"]',
    },
    {
      // Review round 10, contracts 7: the project-execution walk's refusal
      // used to be a plain Error (exit 1); it is a caller-mistake
      // refusal, 64.
      label: "a project tree with executable harness configuration",
      binaries: { copilot: "exit 0" },
      argv: ["run", "-a", "copilot", "--no-sandbox", "--auto", "high", "-p", "test", "--cwd", projectTree],
      message: "refuses repository executable configuration",
    },
    {
      // Review round 10, contracts 7: an invalid multi-agent knob value
      // used to be a plain Error (exit 1); it is 64 like every other
      // knob mistake.
      label: "a codex multi-agent knob that is neither on nor off",
      binaries: { codex: "exit 0" },
      argv: ["run", "-a", "codex", "--no-sandbox", "--auto", "high", "-p", "test"],
      env: { CODEMUX_CODEX_PROVIDER_MULTI_AGENT: "maybe" },
      message: 'CODEMUX_CODEX_PROVIDER_MULTI_AGENT must be "on" or "off"',
    },
    {
      // Review round 17, contracts-2 2: the .scode.yaml project-policy
      // refusal used to be a plain Error (exit 1); project-execution
      // configuration is a caller mistake, 64.
      label: "a working directory carrying .scode.yaml",
      binaries: { claude: "exit 0", scode: "exit 0" },
      argv: ["run", "-a", "claude", "-p", "test", "--auto", "low", "--cwd", scodePolicyTree],
      message: "can alter scode policy",
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

  test("the prompt/file clash is a usage refusal too, not a parser error", async () => {
    // review round 2, contracts 1: every refusal decided before a harness
    // spawns is 64 — the prompt gates included, so the OS-level exit for
    // -p with -f matches the in-process suite's.
    const { stderr, exitCode } = await runCli(
      ["run", "-a", "claude", "-p", "test", "-f", "other.txt"],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--prompt and --file cannot be used together");
  });
});
