import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { getDefaultConfig } from "../src/config.js";
import { registerInfoCommands } from "../src/info-commands.js";
import { getAllAdapters } from "../src/adapters/index.js";
import { SESSION_AGENTS } from "../src/session/cli.js";
import { AGENT_IDS } from "../src/types.js";
import { EXPERIMENT_MCP_HARNESSES } from "../src/experiment-mcp.js";
import { SERVED_MODEL_EVIDENCE_HARNESSES } from "../src/result-envelope/index.js";
import { createFakeBinaryEnv, minimalPath } from "./helpers/cli.js";
import { cleanupFixtureHomes, fakeScodeHelp, fakeUsagemux, fixtureHome, runDoctor } from "./helpers/doctor.js";

afterAll(() => cleanupFixtureHomes(homes));

async function runInfoCommand(
  args: string[],
  configError?: Error
): Promise<{ output: string; exitCode: number | undefined }> {
  const command = new Command();
  command.exitOverride();
  let exitCode: number | undefined;
  registerInfoCommands(command, getDefaultConfig(), configError, (code) => {
    exitCode = code;
  });
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  try {
    await command.parseAsync(["node", "codemux", ...args]);
    return { output: lines.join("\n"), exitCode };
  } finally {
    console.log = originalLog;
  }
}

// The machine-check table itself is tested in tests/doctor-*.test.ts; the
// homes here serve the one doctor test that stays in this file (the
// capabilities block this module renders).
const homes: string[] = [];

describe("information commands", () => {
  test("renders the autonomy matrix", async () => {
    const result = await runInfoCommand(["autonomy"]);
    expect(result.output).toContain("Autonomy equivalence matrix");
    expect(result.output).toContain("| codex |");
  });

  test("renders verifier warning details and scode previews", async () => {
    const result = await runInfoCommand(["verify", "-a", "codex", "--show-scode"]);
    expect(result.output).not.toContain("Warning details:");
    expect(result.output).toContain("Effective scode command preview");
    expect(result.output).toContain("--ro");
  });

  test("lists every registered adapter", async () => {
    const result = await runInfoCommand(["list"]);
    expect(result.output).toContain("Available agents:");
    for (const agentId of AGENT_IDS) {
      expect(result.output).toContain(` ${agentId}`);
    }
  });

  test("list labels equal the adapter capability set", async () => {
    // A property over every adapter: whatever the capabilities object
    // says, the printed label set says exactly that — no label without a
    // capability, no capability without a label (result-json and sessions
    // were the last two to be added by hand).
    const result = await runInfoCommand(["list"]);
    const printed = new Map(
      [...result.output.matchAll(/^  [✅❌] (\S+)(?: \[([^\]]*)\])?$/gm)]
        .map((match) => [match[1]!, match[2] ? match[2]!.split(", ") : []])
    );
    expect([...printed.keys()].sort()).toEqual([...AGENT_IDS].sort());
    for (const adapter of getAllAdapters()) {
      const caps = adapter.capabilities();
      const expected = [
        caps.supportsModel ? "model" : null,
        caps.supportsAutonomy ? "autonomy" : null,
        caps.supportsEffort ? "effort" : null,
        caps.supportsHermetic ? (caps.isolationRequiresReadOnly ? "hermetic(read-only)" : "hermetic") : null,
        caps.supportsToolSelection
          ? (caps.toolsNoneRequiresHermetic ? "tools(hermetic)"
            : caps.toolsNoneRequiresReadOnly || caps.isolationRequiresReadOnly ? "tools(read-only)" : "tools")
          : null,
        caps.supportsProviderOverride ? "provider" : null,
        caps.supportsResultJson ? "result-json" : null,
        SESSION_AGENTS[adapter.id] !== undefined ? "sessions" : null,
      ].filter((label): label is string => label !== null);
      expect(printed.get(adapter.id), adapter.id).toEqual(expected);
    }
  });

  test("list --json prints the machine-readable listing of the same facts", async () => {
    // The release gate reads this listing to build its probe matrix from a
    // candidate build (scripts/live-gate/candidate.ts), so the booleans
    // must mirror the adapter registry exactly — checked here as a
    // property over every adapter, same as the human label set above. The
    // experiment and served-model facts must mirror the src tables the
    // gate's own matrix uses, so the listing and this checkout's tables
    // cannot drift (round 20, edges 2).
    const result = await runInfoCommand(["list", "--json"]);
    const listing = JSON.parse(result.output) as {
      schema: string;
      agents: Array<{
        id: string;
        available: boolean;
        binary: string;
        capabilities: {
          hermetic: boolean; resultJson: boolean; budgetLimit: boolean; toolsNoneRequiresHermetic: boolean;
          toolsNoneRequiresReadOnly: boolean; isolationRequiresReadOnly: boolean; effortLevels: string[] | null;
          providerOverride: boolean; sessions: boolean; model: boolean; effort: boolean;
          experimentMcp: boolean; experimentPrefix: string | null; servedModelEvidence: boolean;
        };
      }>;
    };
    expect(listing.schema).toBe("codemux-list-1");
    expect(listing.agents.map((agent) => agent.id).sort()).toEqual([...AGENT_IDS].sort());
    for (const agent of listing.agents) {
      const adapter = getAllAdapters().find((candidate) => candidate.id === agent.id)!;
      const caps = adapter.capabilities();
      expect(agent.available, agent.id).toBe(adapter.isAvailable());
      // The binary name carries the candidate's own resolution into the
      // gate's contract column (round 19, edges 4).
      expect(agent.binary, agent.id).toBe(adapter.binaryName);
      expect(agent.capabilities, agent.id).toEqual({
        hermetic: caps.supportsHermetic === true,
        resultJson: caps.supportsResultJson === true,
        budgetLimit: caps.budgetLimit === true,
        toolsNoneRequiresHermetic: caps.toolsNoneRequiresHermetic === true,
        toolsNoneRequiresReadOnly: caps.toolsNoneRequiresReadOnly === true || caps.isolationRequiresReadOnly === true,
        isolationRequiresReadOnly: caps.isolationRequiresReadOnly === true,
        effortLevels: caps.supportsEffort === true ? [...caps.effortLevels] : null,
        providerOverride: caps.supportsProviderOverride === true,
        sessions: SESSION_AGENTS[adapter.id] !== undefined,
        experimentMcp: EXPERIMENT_MCP_HARNESSES[adapter.id] !== undefined,
        experimentPrefix: EXPERIMENT_MCP_HARNESSES[adapter.id]?.[0] ?? null,
        servedModelEvidence: SERVED_MODEL_EVIDENCE_HARNESSES.has(adapter.id),
        model: caps.supportsModel === true,
        effort: caps.supportsEffort === true,
      });
    }
    // The spend-limit capability is claude and zai only (Claude Code's own
    // --max-budget-usd, one binary): stated here so a new adapter that
    // gains a native cap shows up as a deliberate change to this test.
    const byId = new Map(listing.agents.map((agent) => [agent.id, agent.capabilities.budgetLimit]));
    expect(byId.get("claude")).toBe(true);
    expect(byId.get("zai")).toBe(true);
    expect([...byId.entries()].filter(([id]) => id !== "claude" && id !== "zai").every(([, value]) => value === false)).toBe(true);
  });

  test("doctor's trailing block prints result-json, sessions, and the version-contract verdict", async () => {
    // The capabilities block is this module's rendering, so its test stays
    // here; the machine-check table above it lives in tests/doctor-*.test.ts.
    // A fake claude binary serves both claude and zai (same binary name);
    // gemini has no contract, so its verdict is the no-contract label.
    const fake = createFakeBinaryEnv({
      scode: fakeScodeHelp(),
      usagemux: fakeUsagemux(),
      claude: `if [ "$1" = "--version" ]; then printf '2.1.300 (Claude Code)\\n'; exit 0; fi`,
      gemini: `if [ "$1" = "--version" ]; then printf 'gemini version 1.2.3\\n'; exit 0; fi`,
    });
    try {
      const result = await runDoctor(["--only", "claude,gemini"], {
        path: fake.env.PATH!,
        home: fixtureHome(
          {
            ".claude/.credentials.json": JSON.stringify({
              // A fresh expiry alone is no login since review round 331
              // (item 15): the mirror must carry an access token.
              claudeAiOauth: { accessToken: "synthetic-access-token", expiresAt: Date.now() + 3_600_000 },
            }),
            ".gemini/oauth_creds.json": "{}",
          },
          homes
        ),
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("claude (claude): ✅ installed");
      expect(result.output).toContain("  Result JSON: yes");
      expect(result.output).toContain("  Sessions: yes");
      expect(result.output).toContain("  Version contract: ok (2.1.300)");
      expect(result.output).toContain("gemini (gemini): ✅ installed");
      expect(result.output).toContain("  Result JSON: no");
      expect(result.output).toContain("  Sessions: no");
      expect(result.output).toContain("  Version contract: no contract");
      expect(result.output).toContain(`Default agent: ${getDefaultConfig().defaultAgent}`);
    } finally {
      fake.cleanup();
    }
  });
});

/** In-process `usage`/`doctor` against a swapped PATH, so the command
 * actions run inside the coverage process (spawned-CLI coverage does not
 * merge into this report). */
async function runInProcess(
  args: string[],
  path: string
): Promise<{ output: string; errors: string; exitCode: number | undefined }> {
  const command = new Command();
  command.exitOverride();
  let exitCode: number | undefined;
  registerInfoCommands(command, getDefaultConfig(), undefined, (code) => {
    exitCode = code;
  });
  const lines: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  console.log = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
  process.env.PATH = path;
  try {
    await command.parseAsync(["node", "codemux", ...args]);
    return { output: lines.join("\n"), errors: errors.join("\n"), exitCode };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.env.PATH = originalPath;
    process.exitCode = originalExitCode;
  }
}

// The one-result snapshot the fake usagemux prints: the same shape the
// protocol tests use (tests/usage.test.ts), for the single client the
// `-a codex` request names.
const USAGE_SNAPSHOT = JSON.stringify({
  schemaVersion: "1",
  generatedAt: "2026-08-03T12:00:00.000Z",
  results: [
    {
      client: "codex",
      provider: "codex",
      status: "ok",
      source: "codex-cli",
      plan: "plus",
      account: "user@example.com",
      windows: [
        {
          kind: "weekly",
          usedPercent: 39,
          remainingPercent: 61,
          windowMinutes: 10080,
          resetsAt: "2026-08-07T09:00:00.000Z",
        },
      ],
      credits: { remaining: 12.5, unit: "credits" },
      subscriptionRenewsAt: "2026-09-03T10:00:00.000Z",
      subscriptionExpiresAt: null,
      message: null,
    },
  ],
});

describe("the usage command in process", () => {
  test("prints the formatted snapshot over a fake usagemux", async () => {
    const fake = createFakeBinaryEnv({ usagemux: `printf '%s' '${USAGE_SNAPSHOT}'` });
    try {
      const result = await runInProcess(["usage", "-a", "codex"], fake.env.PATH!);
      expect(result.exitCode).toBeUndefined();
      expect(result.output).toContain("codex");
      expect(result.output).toContain("61% left");
    } finally {
      fake.cleanup();
    }
  });

  test("--json emits the validated snapshot document", async () => {
    const fake = createFakeBinaryEnv({ usagemux: `printf '%s' '${USAGE_SNAPSHOT}'` });
    try {
      const result = await runInProcess(["usage", "-a", "codex", "--json"], fake.env.PATH!);
      expect(result.exitCode).toBeUndefined();
      expect(JSON.parse(result.output)).toEqual(JSON.parse(USAGE_SNAPSHOT));
    } finally {
      fake.cleanup();
    }
  });

  test("an absent usagemux is the integration exit code 69", async () => {
    const result = await runInProcess(["usage", "-a", "codex"], minimalPath());
    expect(result.exitCode).toBe(69);
    expect(result.errors).toContain("Error: usagemux is not installed (optional usage integration); install it and ensure it is on PATH");
  });

  test("an untrusted usagemux is the same integration failure", async () => {
    const fake = createFakeBinaryEnv({ usagemux: "exit 0" });
    try {
      chmodSync(join(fake.env.PATH!.split(":")[0]!, "usagemux"), 0o775);
      const result = await runInProcess(["usage", "-a", "codex"], fake.env.PATH!);
      expect(result.exitCode).toBe(69);
      expect(result.errors).toContain("Error: usagemux binary is not a trusted executable: path must not be group- or world-writable");
    } finally {
      fake.cleanup();
    }
  });

  test("--agent with --all is a usage refusal", async () => {
    const result = await runInProcess(["usage", "-a", "codex", "--all"], minimalPath());
    expect(result.exitCode).toBe(64);
    expect(result.errors).toContain("Error: --agent and --all cannot be used together");
  });

  test("an unknown agent is a usage refusal listing the agents", async () => {
    const result = await runInProcess(["usage", "-a", "nope"], minimalPath());
    expect(result.exitCode).toBe(64);
    expect(result.errors).toContain("Error: Unknown agent 'nope'");
    expect(result.errors).toContain("Available agents:");
  });

  test("an out-of-range --timeout is a usage refusal with its bound", async () => {
    const result = await runInProcess(["usage", "--timeout", "0"], minimalPath());
    expect(result.exitCode).toBe(64);
    expect(result.errors).toContain("--timeout must be a number");
  });
});


test("the conditional list labels name the adapters that enforce them (audit A9)", () => {
  const caps = (id: string) => getAllAdapters().find((adapter) => adapter.id === id)!.capabilities();
  // codex refuses --tools none above read-only (codex-policy.ts); agy refuses
  // isolation without read-only scode and a clean --cwd (agy.ts); OpenCode
  // offers --tools none on hermetic runs only (opencode.ts).
  expect(caps("codex").toolsNoneRequiresReadOnly).toBe(true);
  expect(caps("agy").isolationRequiresReadOnly).toBe(true);
  expect(caps("opencode").toolsNoneRequiresHermetic).toBe(true);
  expect(caps("claude").toolsNoneRequiresReadOnly).toBeUndefined();
});
