import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IDS, type AgentId } from "../src/types.js";
import { getAdapter } from "../src/adapters/index.js";
import { PARITY, PARITY_FEATURES, agentsSupporting, type ParityFeature } from "../src/parity/index.js";
import { SESSION_AGENTS } from "../src/session/cli-agents.js";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
const harnesses = read("docs/harnesses.md");
const cli = read("docs/cli.md");
const sessions = read("docs/sessions.md");
const providers = read("docs/provider-overrides.md");
const releaseGate = read("docs/RELEASE-GATE.md");
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const section = (text: string, title: string) => {
  const body = text.split(`## ${title}\n`)[1];
  expect(body, title).toBeDefined();
  return body!.split("\n## ")[0]!;
};
const rows = (text: string) => text.split("\n").filter((line) => /^\| (?!-)/.test(line))
  .map((line) => line.split(/(?<!\\)\|/).slice(1, -1)
    .map((cell) => cell.trim().replaceAll("\\|", "|")));

function agentNames(text: string): AgentId[] {
  const normalized = text.toLowerCase().replaceAll("antigravity", "agy").replace(/z\.?a\.?i/g, "zai");
  return AGENT_IDS.filter((agent) => new RegExp(`\\b${agent}\\b`).test(normalized));
}

function declaredNames(text: string, feature: ParityFeature): void {
  expect(sorted(agentNames(text)), feature).toEqual(sorted(agentsSupporting(feature)));
}

test("Harness limitations exactly reproduces every declaration reason and evidence", () => {
  const actual = rows(section(harnesses, "Harness limitations")).slice(1);
  const expected = AGENT_IDS.flatMap((agent) => PARITY_FEATURES.flatMap((feature) => {
    const state = PARITY[agent][feature];
    return state.state === "supported" ? [] : [[agent, feature, state.reason, state.evidence]];
  }));
  expect(actual.length).toBe(expected.length);
  expect(actual.map((row) => JSON.stringify(row)).sort())
    .toEqual(expected.map((row) => JSON.stringify(row)).sort());
});

test("headless matrix spends and conditional cells agree with declarations", () => {
  for (const row of rows(section(harnesses, "Headless capabilities")).slice(1)) {
    const agent = row[0] as AgentId;
    const caps = getAdapter(agent, { PATH: "" }).capabilities();
    expect(row[8] === "yes", agent).toBe(PARITY[agent]["run.max-budget-usd"].state === "supported");
    // The tools-none cell's conditions come from the declarations, which
    // tests/parity-refusals.test.ts pins to what validateRunRequest does
    // (tools none at medium autonomy; tools none without --hermetic). The
    // advertised capability must agree with both (review 422 #24).
    const toolsNone = PARITY[agent]["run.tools-none"].state === "supported";
    const readOnlyOnly = toolsNone && PARITY[agent]["run.tools-none.writable-autonomy"].state !== "supported";
    const hermeticOnly = toolsNone && PARITY[agent]["run.tools-none.plain"].state !== "supported";
    expect(row[5] === "no", agent).toBe(!toolsNone);
    expect(row[5]!.includes("read-only only"), agent).toBe(readOnlyOnly);
    expect(caps.toolsNoneRequiresReadOnly === true, agent).toBe(readOnlyOnly);
    expect(row[5]!.includes("hermetic only"), agent).toBe(hermeticOnly);
    expect(caps.toolsNoneRequiresHermetic === true, agent).toBe(hermeticOnly);
    if (caps.supportsHermetic) {
      expect(/clean cwd|project restrictions|OPEN:/.test(row[4]!), agent)
        .toBe(PARITY[agent]["run.hermetic.any-cwd"].state !== "supported");
    }
  }
});

test("native none and TUI prose lists match the declared sets", () => {
  const native = harnesses.match(/native `none` \(([^)]+)\)/);
  expect(native).not.toBeNull();
  declaredNames(native![1]!, "run.effort.none-native");
  const tuiRows = rows(section(harnesses, "TUI restrictions")).slice(1);
  const effort = tuiRows.find((row) => row[1]!.startsWith("Supported effort values"));
  expect(effort).toBeDefined();
  declaredNames(effort![0]!, "tui.effort");
  const overridden = tuiRows.filter((row) => /[Pp]rovider override/.test(row[1]!))
    .filter((row) => !row[1]!.startsWith("Provider overrides refused"));
  declaredNames(overridden.map((row) => row[0]).join(", "), "tui.provider-override");
});

test("provider delivery table and unsupported prose equal run and TUI sets", () => {
  const table = rows(section(providers, "Delivery and wire formats")).slice(1);
  declaredNames(table.map((row) => row[0]).join(", "), "run.provider-override");
  declaredNames(table.filter((row) => row[3] === "Yes").map((row) => row[0]).join(", "), "tui.provider-override");
  const refused = providers.match(/([^\n]+) do not support this override group\./);
  expect(refused).not.toBeNull();
  expect(sorted(agentNames(refused![1]!))).toEqual(sorted(AGENT_IDS.filter((agent) =>
    PARITY[agent]["run.provider-override"].state !== "supported")));
});

test("CLI project-settings and experiment prose equal declared agent sets", () => {
  const project = cli.split("\n").find((line) => line.startsWith("| `--experiment-project-settings`"));
  expect(project).toBeDefined();
  declaredNames(project!, "run.experiment-project-settings");
  const experiment = cli.split("\n").filter((line) => line.startsWith("| `--experiment-mcp <spec.json>`"));
  expect(experiment).toHaveLength(2);
  declaredNames(experiment[0]!, "run.experiment-mcp");
  declaredNames(experiment[1]!.split("; ")[0]!, "check.experiment-mcp");
});

test("CLI prompt transport prose equals the current-binary declaration", () => {
  const stdin = cli.match(/fallback\. ([\s\S]*?) use stdin for prompt text\./);
  const argv = cli.match(/This applies to ([\s\S]*?), and the legacy/);
  expect(stdin).not.toBeNull();
  expect(argv).not.toBeNull();
  declaredNames(stdin![1]!, "run.prompt-stdin");
  expect(sorted(agentNames(argv![1]!))).toEqual(sorted(AGENT_IDS.filter((agent) =>
    PARITY[agent]["run.prompt-stdin"].state !== "supported")));
});

test("session availability equals the session table and declarations", () => {
  const documented = rows(section(sessions, "Supported agents")).slice(1).map((row) => row[0]!).join(", ");
  expect(sorted(agentNames(documented))).toEqual(sorted(Object.keys(SESSION_AGENTS)));
  declaredNames(documented, "session.driver");
});

test("session interrupt and provider prose equal the session surface", () => {
  const timeout = sessions.split("\n").find((line) => line.startsWith("| `--turn-timeout"));
  expect(timeout).toBeDefined();
  declaredNames(timeout!, "session.interrupt");
  const overrides = sessions.match(/Provider overrides via[^.]+?spawns for ([\s\S]*?)\. ([\s\S]*?) refuse\s+overrides\./);
  expect(overrides).not.toBeNull();
  declaredNames(overrides![1]!, "session.provider-override");
  expect(sorted(agentNames(overrides![2]!))).toEqual(sorted(agentsSupporting("session.driver")
    .filter((agent) => PARITY[agent]["session.provider-override"].state !== "supported")));
});

test("harnesses hermetic prose equals the declared session surface", () => {
  const hermetic = harnesses.match(/Hermetic sessions exist on ([^(]+)\(/);
  expect(hermetic).not.toBeNull();
  declaredNames(hermetic![1]!, "session.hermetic");
});

test("session guide hermetic lists equal the session table and declarations", () => {
  const option = sessions.split("\n").find((line) => line.startsWith("| `--hermetic`"));
  expect(option).toBeDefined();
  const accepted = option!.match(/Accepted by ([^.]+)\./);
  expect(accepted).not.toBeNull();
  expect(sorted(agentNames(accepted![1]!)))
    .toEqual(sorted(AGENT_IDS.filter((agent) => SESSION_AGENTS[agent]?.hermetic)));
  declaredNames(accepted![1]!, "session.hermetic");
  const prose = sessions.match(/`--hermetic` is accepted by ([^.]+)\./);
  expect(prose).not.toBeNull();
  declaredNames(prose![1]!, "session.hermetic");
});

test("session print-sandbox prose equals the declared session surface", () => {
  const option = sessions.split("\n").find((line) => line.startsWith("| `--print-sandbox`"));
  expect(option).toBeDefined();
  const available = option!.match(/Available for ([^.]+)\./);
  expect(available).not.toBeNull();
  declaredNames(available![1]!, "session.print-sandbox");
});

test("provider override probe prose equals the evidence declaration", () => {
  const probe = releaseGate.split("\n").find((line) => line.startsWith("| H |"));
  expect(probe).toBeDefined();
  const available = probe!.match(/Probe H applies to ([^,]+),/);
  expect(available).not.toBeNull();
  declaredNames(available![1]!, "check.provider-override.served-model");
});

test("CLI print-sandbox prose states the session process restriction", () => {
  const print = cli.slice(cli.indexOf("`--print-sandbox`"), cli.indexOf("`--enable-playwright-mcp`"));
  expect(print).toMatch(/session[\s\S]*(?:long-lived|per-turn|turn-per-process)/);
});
