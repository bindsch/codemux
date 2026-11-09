/**
 * Agent lists and counts in prose, pinned to the tables they describe
 * (review round 422): every list here drifted once while the capability
 * tables stayed right, so each is now derived from its table.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IDS, type AgentId } from "../src/types.js";
import { PARITY, PARITY_FEATURES, agentsSupporting, type ParityFeature } from "../src/parity/index.js";
import { SESSION_AGENTS } from "../src/session/cli-agents.js";
import { RESULT_ANSWER_FIELD } from "../src/result-envelope/index.js";
import { EXPERIMENT_MCP_HARNESSES } from "../src/experiment-mcp.js";
import { PLAYWRIGHT_MCP_AGENTS } from "../src/mcp.js";
import { CLINE_ACP_DRIVER_PROFILE } from "../src/session/cline-session.js";
import { COPILOT_DRIVER_PROFILE } from "../src/session/copilot-driver.js";
import { CURSOR_DRIVER_PROFILE } from "../src/session/cursor-driver.js";
import { DROID_DRIVER_PROFILE } from "../src/session/droid-driver.js";
import { GEMINI_ACP_DRIVER_PROFILE } from "../src/session/gemini-acp-driver.js";
import { GEMINI_DRIVER_PROFILE } from "../src/session/gemini-driver.js";
import { GOOSE_DRIVER_PROFILE } from "../src/session/goose-driver.js";
import { OPENHANDS_DRIVER_PROFILE } from "../src/session/openhands-driver.js";
import { PI_DRIVER_PROFILE } from "../src/session/pi-driver.js";
import { QWEN_DRIVER_PROFILE } from "../src/session/qwen-driver.js";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const flat = (text: string) => text.replace(/\s+/g, " ");
const cli = flat(read("docs/cli.md"));
const sessions = flat(read("docs/sessions.md"));

function agentNames(text: string): AgentId[] {
  const normalized = text.toLowerCase().replaceAll("antigravity", "agy").replace(/z\.?a\.?i/g, "zai");
  return AGENT_IDS.filter((agent) => new RegExp(`\\b${agent}\\b`).test(normalized));
}

function captured(text: string, pattern: RegExp): string {
  const match = text.match(pattern);
  expect(match, String(pattern)).not.toBeNull();
  return match![1]!;
}

const sessionAgents = Object.keys(SESSION_AGENTS) as AgentId[];
const notSupporting = (feature: ParityFeature) => AGENT_IDS.filter((agent) => !agentsSupporting(feature).includes(agent));

test("README counts equal the agent, result-JSON, and session tables", () => {
  const readme = flat(read("README.md"));
  expect(Number(captured(readme, /Launches (\d+) harnesses/))).toBe(AGENT_IDS.length);
  expect(Number(captured(readme, /; (\d+) adapters \(every harness but/))).toBe(Object.keys(RESULT_ANSWER_FIELD).length);
  const without = AGENT_IDS.filter((agent) => RESULT_ANSWER_FIELD[agent] === undefined);
  expect(sorted(agentNames(captured(readme, /every harness but ([^)]+)\)/)))).toEqual(sorted(without));
  expect(Number(captured(readme, /Resumable JSONL sessions for (\d+) agents/))).toBe(sessionAgents.length);
});

test("CLI session list and hermetic exception equal SESSION_AGENTS", () => {
  expect(sorted(agentNames(captured(cli, /defines JSONL input and output\. It supports (.+?)\. Tool selection/))))
    .toEqual(sorted(sessionAgents));
  const refusing = sessionAgents.filter((agent) => !SESSION_AGENTS[agent]!.hermetic);
  expect(sorted(agentNames(captured(cli, /on every session agent except (\w+) \(/)))).toEqual(sorted(refusing));
  const isolation = flat(read("docs/isolation.md"));
  expect(sorted(agentNames(captured(isolation, /`--hermetic` on every session agent except (\w+),/)))).toEqual(sorted(refusing));
});

test("isolation and protocol name the one hermetic agent without a private home", () => {
  // turn-driver-homes.ts returns null for qwen; every other hermetic agent
  // keeps a session-lifetime home.
  const homes = flat(read("src/session/turn-driver-homes.ts"));
  const noHome = sessionAgents.filter((agent) => SESSION_AGENTS[agent]!.hermetic &&
    new RegExp(`case "${agent}":\\s*return null;`).test(homes));
  expect(noHome).toEqual(["qwen"]);
  const isolation = flat(read("docs/isolation.md"));
  const keeping = sessionAgents.filter((agent) => SESSION_AGENTS[agent]!.hermetic).length - noHome.length;
  expect(captured(isolation, /(\w+) of them keep a session-lifetime private home/)).toBe("Fourteen");
  expect(keeping).toBe(14);
  expect(sorted(agentNames(captured(isolation, /private home in place of the per-run one; (\w+) keeps no/)))).toEqual(noHome);
  const protocol = flat(read("docs/session-protocol.md"));
  expect(sorted(agentNames(captured(protocol, /keeps no session-keyed home \((\w+)\)/)))).toEqual(noHome);
});

test("Playwright MCP prose equals the run and session tables", () => {
  expect(sorted(agentNames(captured(cli, /On `run` it requires (.+?) and sandboxing\./))))
    .toEqual(sorted(PLAYWRIGHT_MCP_AGENTS));
  expect(sorted(agentsSupporting("session.playwright-mcp"))).toEqual(sorted(PLAYWRIGHT_MCP_AGENTS));
  expect(captured(cli, /Sessions support the same (\w+) agents\./)).toBe("eleven");
  expect(PLAYWRIGHT_MCP_AGENTS).toHaveLength(11);
  expect(sorted(agentNames(captured(sessions, /`--enable-playwright-mcp` is supported for ([^,]+),/))))
    .toEqual(sorted(PLAYWRIGHT_MCP_AGENTS));
});

test("spend-limit, web, and TUI effort prose equal the declarations", () => {
  const budget = read("docs/cli.md").split("\n").find((line) => line.startsWith("| `--max-budget-usd"))!;
  expect(sorted(agentNames(captured(budget, /two fraction digits \(`2\.5`, `0\.75`\), so the amount reaches the harness exactly as written\. (.+?) only\./)))).toEqual(sorted(agentsSupporting("run.max-budget-usd")));
  const web = read("docs/cli.md").split("\n").find((line) => line.startsWith("| `--no-web`"))!;
  expect(sorted(agentNames(captured(web, /its CLI mode has no web tools\. (.+?) refuse the flag\./)))).toEqual(sorted(notSupporting("run.no-web")));
  expect(sorted(agentNames(captured(cli, /([A-Z][\w, ]+?) have no effort carrier, so their TUI refuses/))))
    .toEqual(sorted(notSupporting("tui.effort")));
});

test("session protocol's argv bound names every argv-carried agent", () => {
  const profiles = [CLINE_ACP_DRIVER_PROFILE, COPILOT_DRIVER_PROFILE, CURSOR_DRIVER_PROFILE, DROID_DRIVER_PROFILE,
    GEMINI_ACP_DRIVER_PROFILE, GEMINI_DRIVER_PROFILE, GOOSE_DRIVER_PROFILE, OPENHANDS_DRIVER_PROFILE,
    PI_DRIVER_PROFILE, QWEN_DRIVER_PROFILE];
  // Aider and Kimi run their own drivers, which enforce the same bound.
  expect(read("src/session/aider-input.ts")).toContain("MAX_ARGV_PROMPT_BYTES");
  expect(read("src/session/kimi-machine/step.ts")).toContain("MAX_ARGV_PROMPT_BYTES");
  const argv = sorted(["aider", "kimi", ...profiles.filter((p) => p.promptCarrier === "argv").map((p) => p.agent)]);
  const protocol = flat(read("docs/session-protocol.md"));
  expect(sorted(agentNames(captured(protocol, /produce `text_too_long`\. (.+?) impose a stricter 32 KiB limit/))))
    .toEqual(argv);
  expect(sorted(agentNames(captured(read("docs/session-protocol.md"), /\| ([\w/]+) argv text \|/)))).toEqual(argv);
});

test("experiment MCP and recording prose equal EXPERIMENT_MCP_HARNESSES", () => {
  const harnesses = sorted(Object.keys(EXPERIMENT_MCP_HARNESSES));
  expect(harnesses).toEqual(sorted(agentsSupporting("run.experiment-mcp")));
  const experiment = flat(read("docs/experiment-mcp.md"));
  expect(sorted(agentNames(captured(experiment, /stdio MCP server with (.+?)\. It requires/)))).toEqual(harnesses);
  const usage = flat(read("docs/results-and-usage.md"));
  expect(sorted(agentNames(captured(usage, /JSONL path for every experiment run \(([^)]+)\)/)))).toEqual(harnesses);
  const prefixes = sorted(Object.values(EXPERIMENT_MCP_HARNESSES).flat() as string[]);
  const row = read("docs/experiment-mcp.md").split("\n").find((line) => line.startsWith("| `accept_harness_prefix`"))!;
  expect(sorted([...row.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!))).toEqual(prefixes);
  expect(read("docs/experiment-mcp.md")).toContain("| `accept_harness_schema` |");
});

test("limitation-shaped rows live only in the Harness limitations section", () => {
  const harnesses = read("docs/harnesses.md");
  const limitations = harnesses.split("## Harness limitations\n")[1]!.split("\n## ")[0]!;
  const outside = harnesses.replace(limitations, "").split("\n").filter((line) => {
    const cells = line.split("|").map((cell) => cell.trim());
    return AGENT_IDS.includes(cells[1] as AgentId) && PARITY_FEATURES.includes(cells[2] as ParityFeature);
  });
  expect(outside).toEqual([]);
  expect(Object.keys(PARITY).length).toBe(AGENT_IDS.length);
});
