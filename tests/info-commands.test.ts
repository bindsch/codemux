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
import { AUTONOMY_EQUIVALENCE } from "../src/autonomy.js";
import { HERMETIC_CHECK_CHANNELS } from "../src/hermetic-check-channels.js";
import { PARITY, agentsSupporting } from "../src/parity/index.js";
import { SERVED_MODEL_EVIDENCE_HARNESSES, SESSION_SERVED_MODEL } from "../src/result-envelope/index.js";
import { createFakeBinaryEnv, minimalPath } from "./helpers/cli.js";
import { cleanupFixtureHomes, fakeScodeHelp, fakeUsagemux, fixtureHome, runDoctor } from "./helpers/doctor.js";
import { withVerifyExecutables } from "./helpers/verify.js";

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
    // The carrier-class block (design P4): one row per agent, the class
    // per level, and the session mapping note, so a caller reads the
    // declared limitations (scode) and the claude-family session
    // difference from the same command.
    expect(result.output).toContain("Carrier classes");
    expect(result.output).toContain("| kimi | scode | scode | scode | scode |");
    expect(result.output).toContain("| openhands | scode | scode | scode | default |");
    expect(result.output).toContain("| aider | native | stdin | native | native |");
    expect(result.output).toContain("| goose | env | env | env | env |");
    // Every agent has a session driver now, so every Sessions cell names
    // the session mapping and none reads "no sessions".
    expect(result.output).toContain("| openhands | scode | scode | scode | default | same flags as run |");
    expect(result.output).not.toContain("no sessions");
    expect(result.output).toContain("session mapping differs by design");
  });

  test("renders verifier warning details and scode previews", async () => {
    const result = await withVerifyExecutables(() => runInfoCommand(["verify", "-a", "codex", "--show-scode"]));
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
        caps.supportsModel ? (adapter.supportsTuiModel() ? "model" : "model(run)") : null,
        caps.supportsAutonomy ? "autonomy" : null,
        caps.supportsEffort ? (adapter.supportsTuiEffort() ? "effort" : "effort(run)") : null,
        caps.supportsHermetic ? (caps.isolationRequiresReadOnly ? "hermetic(read-only)" : "hermetic") : null,
        caps.supportsToolSelection
          ? (caps.toolsNoneRequiresHermetic ? "tools(hermetic)"
            : caps.toolsNoneRequiresReadOnly || caps.isolationRequiresReadOnly ? "tools(read-only)" : "tools")
          : null,
        caps.supportsProviderOverride ? "provider" : null,
        caps.supportsResultJson ? "result-json" : null,
        caps.budgetLimit ? "budget" : null,
        SESSION_AGENTS[adapter.id] === undefined ? null
          : SESSION_AGENTS[adapter.id]?.approvals === "ask" ? "sessions(permissions)" : "sessions(no-permissions)",
      ].filter((label): label is string => label !== null);
      expect(printed.get(adapter.id), adapter.id).toEqual(expected);
    }
    // The (run) qualifiers follow the TUI declarations (tui.model,
    // tui.effort): droid, opencode, and qwen gained the interactive form of
    // -m and --effort in the parity pass, so every model or effort adapter
    // now carries both flags in its TUI and no "(run)" label is printed.
    // Exact label membership, because a substring check reads "model(run)"
    // as "model".
    const labels = (id: string): string[] => {
      const line = [...result.output.matchAll(/^  [✅❌] (\S+)(?: \[([^\]]*)\])?$/gm)]
        .find((match) => match[1] === id);
      return line?.[2] ? line[2].split(", ") : [];
    };
    for (const id of ["droid", "opencode", "qwen"]) {
      expect(labels(id)).toContain("model");
      expect(labels(id)).toContain("effort");
      expect(labels(id)).not.toContain("model(run)");
      expect(labels(id)).not.toContain("effort(run)");
    }
    expect([...printed.values()].flat().filter((label) => label.endsWith("(run)"))).toEqual([]);
    expect(labels("claude")).toContain("model");
    expect(labels("claude")).not.toContain("model(run)");
    expect(labels("claude")).toContain("budget");
    expect(labels("zai")).toContain("budget");
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
          providerOverride: boolean; sessions: boolean; model: boolean; effort: boolean; toolsNone: boolean;
          sessionPermissions: boolean; sessionPermissionsNote: string | null;
          sessionHermetic: boolean; checkHermetic: boolean;
          limitations: Record<string, { reason: string; evidence: string }>;
          tui: { model: boolean; effort: boolean };
          experimentMcp: boolean; experimentPrefix: string | null; servedModelEvidence: boolean;
          sessionServedModel: string[];
          autonomyCarrier: Record<string, string>;
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
        sessionPermissions: SESSION_AGENTS[adapter.id]?.approvals === "ask",
        sessionPermissionsNote: SESSION_AGENTS[adapter.id]?.approvalsNote ?? null,
        sessionHermetic: SESSION_AGENTS[adapter.id]?.hermetic === true,
        checkHermetic: Object.entries(HERMETIC_CHECK_CHANNELS)
          .some(([id, channel]) => id === adapter.id && channel.kind === "channel"),
        limitations: Object.fromEntries(Object.entries(PARITY[adapter.id]).flatMap(([feature, state]) =>
          state.state === "harness-limitation"
            ? [[feature, { reason: state.reason, evidence: state.evidence }]] : [])),
        experimentMcp: EXPERIMENT_MCP_HARNESSES[adapter.id] !== undefined,
        experimentPrefix: EXPERIMENT_MCP_HARNESSES[adapter.id]?.[0] ?? null,
        servedModelEvidence: SERVED_MODEL_EVIDENCE_HARNESSES.has(adapter.id),
        // The session wire's served-model sources mirror the src table
        // exactly (design P5): empty means the driver reports none yet.
        sessionServedModel: SESSION_SERVED_MODEL[adapter.id] ?? [],
        // The carrier classes mirror src/autonomy.ts exactly (design P4).
        autonomyCarrier: { ...AUTONOMY_EQUIVALENCE[adapter.id].carrier },
        model: caps.supportsModel === true,
        effort: caps.supportsEffort === true,
        toolsNone: caps.supportsToolSelection === true,
        // The TUI block mirrors the human labels' (run) qualifiers.
        tui: { model: adapter.supportsTuiModel(), effort: adapter.supportsTuiEffort() },
      });
    }
    // The spend-limit capability is the run.max-budget-usd declaration
    // (Claude Code's own --max-budget-usd for claude and zai, and pi's
    // native cap): stated here so a new adapter that gains a native cap
    // shows up as a deliberate change to this test.
    const byId = new Map(listing.agents.map((agent) => [agent.id, agent.capabilities.budgetLimit]));
    expect(agentsSupporting("run.max-budget-usd").sort()).toEqual(["claude", "pi", "zai"]);
    expect([...byId.entries()].filter(([, value]) => value).map(([id]) => id).sort())
      .toEqual(agentsSupporting("run.max-budget-usd").sort());
  });

  test("doctor's trailing block prints result-json, sessions, and the version-contract verdict", async () => {
    // The capabilities block is this module's rendering, so its test stays
    // here; the machine-check table above it lives in tests/doctor-*.test.ts.
    // A fake claude binary serves both claude and zai (same binary name);
    // gemini has no contract, so its verdict is the no-contract label.
    // openhands is installed-only-here; it and gemini gained session
    // drivers in the parity passes, so every Sessions line reads yes.
    const fake = createFakeBinaryEnv({
      scode: fakeScodeHelp(),
      usagemux: fakeUsagemux(),
      claude: `if [ "$1" = "--version" ]; then printf '2.1.300 (Claude Code)\\n'; exit 0; fi`,
      gemini: `if [ "$1" = "--version" ]; then printf 'gemini version 1.2.3\\n'; exit 0; fi`,
      // The version banner reports the SDK version first; the contract's
      // pattern reads the CLI version after "OpenHands CLI" (1.16.0).
      openhands: `if [ "$1" = "--version" ]; then printf 'openhands-sdk 1.2.3\\nOpenHands CLI 1.16.0\\n'; exit 0; fi`,
    });
    try {
      const result = await runDoctor(["--only", "claude,gemini,openhands"], {
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
        // openhands authenticates with a credential variable (LLM_API_KEY,
        // src/environment.ts): without one the row's state is NO-LOGIN, a
        // broken state, and the exit code is 1.
        env: { LLM_API_KEY: "test-key-123" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("claude (claude): ✅ installed");
      expect(result.output).toContain("  Result JSON: yes");
      expect(result.output).toContain("  Sessions: yes");
      expect(result.output).toContain("  Version contract: ok (2.1.300)");
      expect(result.output).toContain("gemini (gemini): ✅ installed");
      // gemini declares result JSON in the 2.0.0 parity pass and sessions
      // in the session-surface pass, so its Sessions row reads yes.
      expect(result.output).toContain("  Result JSON: yes");
      expect(result.output).toContain("  Sessions: yes");
      expect(result.output).toContain("  Version contract: no contract");
      expect(result.output).toContain("openhands (openhands): ✅ installed");
      // openhands gained its session driver, so its own block reads yes.
      const openhandsBlock = result.output.slice(result.output.indexOf("openhands (openhands): ✅ installed"));
      expect(openhandsBlock.slice(0, openhandsBlock.indexOf("\n\n"))).toContain("  Sessions: yes");
      expect(result.output).toContain("  Version contract: ok (1.16.0)");
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
  // OpenCode offers --tools none on hermetic runs only (opencode.ts, the
  // run.tools-none.plain limitation). Codex carries --tools none at every
  // autonomy since the parity pass (run.tools-none.writable-autonomy), and
  // agy's isolation-requires-read-only constraint is gone too (its
  // isolation probes carry their own read-only request,
  // src/adapters/agy.ts), so no adapter declares a read-only condition.
  expect(PARITY.codex["run.tools-none.writable-autonomy"].state).toBe("supported");
  expect(caps("codex").toolsNoneRequiresReadOnly).toBe(false);
  expect(PARITY.opencode["run.tools-none.plain"].state).toBe("harness-limitation");
  expect(caps("opencode").toolsNoneRequiresHermetic).toBe(true);
  expect(getAllAdapters().filter((adapter) => adapter.capabilities().toolsNoneRequiresReadOnly === true)).toEqual([]);
  expect(caps("claude").toolsNoneRequiresReadOnly).toBeUndefined();
  expect(caps("agy").isolationRequiresReadOnly).toBeUndefined();
});
