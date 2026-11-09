import { describe, expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IDS, AUTONOMY_LEVELS } from "../src/types.js";
import { getAdapter } from "../src/adapters/index.js";
import * as adapters from "../src/adapters/index.js";
import { registerInfoCommands } from "../src/info-commands.js";
import { getDefaultConfig } from "../src/config.js";
import { PARITY, PARITY_FEATURES, agentsSupporting, type ParityFeature } from "../src/parity/index.js";
import { SESSION_AGENTS } from "../src/session/cli-agents.js";
import { FEATURE_FLOORS } from "../src/harness-contracts.js";
import { PROJECT_SETTINGS_AGENTS } from "../src/claude-project-settings.js";
import { PLAYWRIGHT_MCP_AGENTS } from "../src/mcp.js";
import { EXPERIMENT_MCP_HARNESSES } from "../src/experiment-mcp.js";
import { RESULT_ANSWER_FIELD, SERVED_MODEL_EVIDENCE_HARNESSES } from "../src/result-envelope/index.js";
import { HERMETIC_CHECK_CHANNELS, type HermeticCheckChannel } from "../src/hermetic-check-channels.js";
import { RUN_OPTION_FEATURE, SESSION_OPTION_FEATURE, TUI_OPTION_FEATURE } from "../src/parity/option-features.js";

const root = join(import.meta.dir, "..");
const sorted = (values: Iterable<string>) => [...values].sort();

test("option maps contain only declared features or the every-agent scope", () => {
  for (const mapping of [RUN_OPTION_FEATURE, SESSION_OPTION_FEATURE, TUI_OPTION_FEATURE]) {
    for (const value of Object.values(mapping)) {
      expect(value === "every-agent" || (PARITY_FEATURES as readonly string[]).includes(value)).toBe(true);
    }
  }
  expect(RUN_OPTION_FEATURE.web).toBe("run.no-web");
  expect(SESSION_OPTION_FEATURE.final).toBe("session.final");
  expect(TUI_OPTION_FEATURE.model).toBe("tui.model");
});

test("parity exhaustively names every adapter and feature", () => {
  expect(sorted(Object.keys(PARITY))).toEqual(sorted(AGENT_IDS));
  expect(new Set(PARITY_FEATURES).size).toBe(PARITY_FEATURES.length);
  for (const agent of AGENT_IDS) expect(sorted(Object.keys(PARITY[agent]))).toEqual(sorted(PARITY_FEATURES));
});

describe.each([...AGENT_IDS])("%s declarations", (agent) => {
  const supports = (feature: ParityFeature) => PARITY[agent][feature].state === "supported";

  test("match adapter flags, including conditional and TUI support", () => {
    const adapter = getAdapter(agent, { PATH: "" });
    const caps = adapter.capabilities();
    const facts: Partial<Record<ParityFeature, boolean>> = {
      "run.model": caps.supportsModel,
      "run.autonomy.all-four": AUTONOMY_LEVELS.every((level) => caps.autonomyLevels.includes(level)),
      "run.effort": caps.supportsEffort,
      "run.effort.none-native": caps.effortLevels.includes("none"),
      "run.hermetic": caps.supportsHermetic === true,
      "run.tools-none": caps.supportsToolSelection === true,
      "run.tools-none.writable-autonomy": caps.supportsToolSelection === true && !caps.toolsNoneRequiresReadOnly,
      "run.tools-none.plain": caps.supportsToolSelection === true && !caps.toolsNoneRequiresHermetic,
      "run.result-json": caps.supportsResultJson === true,
      "run.provider-override": caps.supportsProviderOverride === true,
      "run.max-budget-usd": caps.budgetLimit === true,
      "tui.model": adapter.supportsTuiModel(),
      "tui.effort": adapter.supportsTuiEffort(),
      "run.prompt-stdin": !adapter.promptInArgv({ agent, prompt: "synthetic" }),
    };
    for (const [feature, value] of Object.entries(facts)) {
      expect(supports(feature as ParityFeature), `${agent} ${feature}`).toBe(value);
    }
    if (caps.hermeticRequiresProviderOverride) {
      const state = PARITY[agent]["run.hermetic"];
      expect(state.state).toBe("supported");
      if (state.state === "supported") expect(state.note).toContain("provider override");
    }
  });

  test("match the session table and driver capabilities", async () => {
    const support = SESSION_AGENTS[agent];
    expect(supports("session.driver")).toBe(support !== undefined);
    expect(supports("session.interrupt")).toBe(support?.interrupt === true);
    expect(supports("session.tools")).toBe(support?.tools === true);
    expect(supports("session.hermetic")).toBe(support?.hermetic === true);
    expect(supports("session.final")).toBe(support?.hermetic === true);
    expect(supports("session.private-home")).toBe(support?.hermetic === true);
    expect(supports("session.permission-policy-deny"))
      .toBe(support !== undefined && (support.approvals === "ask" || support.denyRules === "hermetic" ||
        support.denyRules === "native" || agent === "aider"));
    if (support === undefined) return;
    const driver = await import(`../src/session/${agent}-session.ts`);
    const caps = driver[`${agent}SessionCapabilities`]();
    expect(caps.interrupt).toBe(support.interrupt);
    expect(caps.permissions).toBe(support.approvals === "ask");
    expect(caps.resume).toBe(supports("session.resume"));
  });

  test("cite existing agent-specific tests for every supported cell", () => {
    for (const feature of PARITY_FEATURES) {
      const state = PARITY[agent][feature];
      expect(existsSync(join(root, state.test)), `${agent} ${feature}: ${state.test}`).toBe(true);
      if (state.state === "supported") {
        expect(readFileSync(join(root, state.test), "utf8"), `${agent} ${feature}: ${state.test}`)
          .toMatch(new RegExp(`\\b${agent}\\b`));
      }
    }
  });

  test("have no OPEN cells or unsupported claims without evidence", () => {
    const gaps: string[] = [];
    for (const feature of PARITY_FEATURES) {
      const state = PARITY[agent][feature];
      if (state.state === "supported") continue;
      if (state.reason.startsWith("OPEN:")) gaps.push(`${feature}: ${state.reason}`);
      expect(state.reason).not.toMatch(/not verified|codemux has not implemented/i);
      expect(state.reason.trim().length).toBeGreaterThan(0);
      expect(state.evidence.trim().length).toBeGreaterThan(0);
      expect(state.evidence).toMatch(/\d+\.\d+|20\d\d-\d\d-\d\d/);
      if (!state.reason.startsWith("OPEN:")) expect(state.refusal.length, `${agent} ${feature}`).toBeGreaterThan(0);
    }
    expect(gaps, `${agent} unresolved parity cells`).toEqual([]);
  });
});

test("all per-agent tables equal the declared sets", () => {
  const channels: Readonly<Partial<Record<(typeof AGENT_IDS)[number], HermeticCheckChannel>>> = HERMETIC_CHECK_CHANNELS;
  const tables: [ParityFeature, Iterable<string>][] = [
    ["session.driver", Object.keys(SESSION_AGENTS)],
    ["run.experiment-mcp", Object.keys(EXPERIMENT_MCP_HARNESSES)],
    ["run.experiment-project-settings", PROJECT_SETTINGS_AGENTS],
    ["run.playwright-mcp", PLAYWRIGHT_MCP_AGENTS],
    ["run.result-json", Object.keys(RESULT_ANSWER_FIELD)],
    ["run.served-model-evidence", SERVED_MODEL_EVIDENCE_HARNESSES],
    ["check.hermetic", AGENT_IDS.filter((agent) => channels[agent]?.kind === "channel")],
  ];
  for (const [feature, agents] of tables) expect(sorted(agents), feature).toEqual(sorted(agentsSupporting(feature)));
  for (const [kind, feature] of [
    ["sessions", "session.driver"], ["experiment-mcp", "run.experiment-mcp"],
    ["project-settings", "run.experiment-project-settings"],
  ] as const) {
    expect(sorted(AGENT_IDS.filter((agent) => FEATURE_FLOORS[agent]?.[kind] !== undefined)), kind)
      .toEqual(sorted(agentsSupporting(feature)));
  }
});

test("no-web and session-print validation derive their agent sets from parity", () => {
  const run = readFileSync(join(root, "src/run-command.ts"), "utf8");
  expect(run).toMatch(/options\.web === false && !agentsSupporting\("run\.no-web"\)\.includes\(agentId\)/);
  const request = readFileSync(join(root, "src/session/cli-request.ts"), "utf8");
  const block = request.slice(request.indexOf("if (options.printSandbox)"), request.indexOf("const sessionTimeoutMs"));
  expect(block).toMatch(/if \(!agentsSupporting\("session\.print-sandbox"\)\.includes\(agentId\)\)/);
});

test("listing publishes session approval labels and candidate isolation facts", async () => {
  const output: string[] = [];
  const adapterList = AGENT_IDS.map((agent) => getAdapter(agent, { PATH: "" }));
  const mocks = [
    spyOn(adapters, "getAllAdapters").mockReturnValue(adapterList),
    spyOn(console, "log").mockImplementation((value) => { output.push(String(value)); }),
    spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("parity listing must not spawn"); }),
    spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("parity listing must not spawn"); }),
  ];
  try {
    const command = new Command();
    registerInfoCommands(command, getDefaultConfig());
    await command.parseAsync(["list", "--json"], { from: "user" });
    const listing = JSON.parse(output.pop()!) as { agents: {
      id: (typeof AGENT_IDS)[number]; capabilities: Record<string, unknown>;
    }[] };
    expect(listing.agents).toHaveLength(AGENT_IDS.length);
    for (const row of listing.agents) {
      const support = SESSION_AGENTS[row.id];
      expect(row.capabilities.sessionPermissions, row.id).toBe(support?.approvals === "ask");
      expect(row.capabilities.sessionPermissionsNote, row.id).toBe(support?.approvalsNote ?? null);
      expect(row.capabilities.sessionHermetic, row.id).toBe(support?.hermetic === true);
      expect(row.capabilities.checkHermetic, row.id).toBe(PARITY[row.id]["check.hermetic"].state === "supported");
      expect(row.capabilities.limitations, row.id).toBeDefined();
    }
    await command.parseAsync(["list"], { from: "user" });
    for (const [agent, support] of Object.entries(SESSION_AGENTS)) {
      const line = output.find((value) => value.includes(` ${agent} [`));
      expect(line).toContain(support.approvals === "ask" ? "sessions(permissions)" : "sessions(no-permissions)");
    }
  } finally {
    for (const mock of mocks.reverse()) mock.mockRestore();
  }
});
