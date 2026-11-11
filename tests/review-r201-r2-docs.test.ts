import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IDS } from "../src/types.js";
import { agentsSupporting } from "../src/parity/index.js";
import { SESSION_AGENTS } from "../src/session/cli-agents.js";
import { SESSION_SERVED_MODEL, SERVED_MODEL_EVIDENCE_HARNESSES } from "../src/result-envelope/index.js";
import { EXPERIMENT_MCP_HARNESSES } from "../src/experiment-mcp.js";
import { getConfigPath } from "../src/config.js";
import { copilotResult } from "../src/result-envelope/copilot.js";
import { emptyUsage } from "../src/result-envelope/common.js";
import { piSessionEffortFlags, parsePiSessionTurn } from "../src/session/pi-session.js";
import { engineSession, fakeTurnProcess, wireProfile } from "./helpers/session-turn-engine.js";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
const flat = (path: string) => read(path).replace(/\s+/g, " ");
const names = (text: string): string[] => AGENT_IDS.filter((agent) => new RegExp(`\\b${agent}\\b`).test(
  text.toLowerCase().replaceAll("antigravity", "agy").replace(/z\.?a\.?i/g, "zai"))).sort();
const row = (path: string, name: string) => read(path).split("\n").findLast((line) => line.startsWith(`| ${name} |`))!;

test("session tool-selection prose equals both capability declarations", () => {
  const selection = flat("docs/isolation.md").match(/Session tool selection is supported by (.*?); (.*?) refuse it/)!;
  expect(selection).not.toBeNull();
  const supported = agentsSupporting("session.tools").sort();
  expect(names(selection[1]!)).toEqual(supported);
  expect(names(selection[2]!)).toEqual(AGENT_IDS.filter((agent) => !supported.includes(agent)).sort());
  expect(Object.entries(SESSION_AGENTS).filter(([, caps]) => caps.tools).map(([agent]) => agent).sort()).toEqual(supported);
});

test.each(["Codex", "Qwen"])("%s isolation tool-removal row agrees with writable support", (agent) => {
  expect(agentsSupporting("run.tools-none.writable-autonomy")).toContain(agent.toLowerCase() as "codex" | "qwen");
  expect(row("docs/isolation.md", agent)).not.toMatch(/Accepted only at read-only|\| Refused\./);
  expect(row("docs/isolation.md", agent)).toContain(agent === "Codex" ? "private model catalog" : "--exclude-tools");
});

test("isolation experiment list and paired-check prose match the implemented set", () => {
  const isolation = flat("docs/isolation.md");
  const list = isolation.match(/([^.]+) accept an explicitly supplied experiment MCP server/)!;
  expect(list).not.toBeNull();
  // Z.AI contains a period, so capture from the section boundary instead.
  const paragraph = isolation.split("### Experiment MCP exception ")[1]!.split(" accept an explicitly")[0]!;
  expect(names(paragraph)).toEqual(Object.keys(EXPERIMENT_MCP_HARNESSES).sort());
  expect(Object.keys(EXPERIMENT_MCP_HARNESSES).sort()).toEqual(agentsSupporting("check.experiment-mcp").sort());
  expect(isolation).toContain("Codex supports both experiment `run` and paired `check`");
  expect(flat("docs/experiment-mcp.md")).toContain("both spend model quota");
  expect(isolation).not.toContain("Every other adapter still refuses");
});

test("native effort omission is qualified in both command references", () => {
  expect(agentsSupporting("run.effort.none-native")).toContain("codex");
  expect(piSessionEffortFlags("none")).toEqual(["--thinking", "off"]);
  expect(flat("docs/cli.md")).toContain("Pi `off`");
  expect(flat("docs/sessions.md")).toContain('Codex sends `effort: "none"`');
  for (const path of ["docs/cli.md", "docs/sessions.md"]) {
    expect(flat(path)).not.toMatch(/none.*?(always means "send no effort flag"|sends no effort field on every)/);
  }
});

test("ordinary result IDs and failure codes do not imply resumable sessions or experiments", () => {
  const native = copilotResult({ success: true, exitCode: 0, stderr: "", stdout: [
    { type: "result", sessionId: "native-session", exitCode: 0 },
    { type: "assistant.message", data: { content: "reply" } },
    { type: "session.error", data: { message: "failed" } },
  ].map((event) => JSON.stringify(event)).join("\n") }, { agent: "copilot", prompt: "p", resultJson: true });
  const block = JSON.parse(native.stdout).codemux;
  expect(block.session_id).toBe("native-session");
  expect(block.failure_code).toBe("harness-error");
  expect(flat("docs/results-and-usage.md")).toContain("Run `codemux.session_id` is adapter-specific");
  for (const path of ["docs/results-and-usage.md", "docs/experiment-mcp.md"]) {
    expect(flat(path)).toContain("`harness-error`");
    expect(flat(path)).not.toMatch(/success and non-experiment runs report null|null for success and non-experiment/);
  }
});

test("accounting prose preserves supported run and session measurements", () => {
  const metrics = { ...emptyUsage(), input_tokens: 10, output_tokens: 13, total_tokens: 23 };
  const result = copilotResult({ success: true, exitCode: 0, stderr: "", stdout:
    JSON.stringify({ type: "assistant.message", data: { content: "reply" } }) },
  { agent: "copilot", prompt: "p", resultJson: true }, { usage: metrics });
  expect(JSON.parse(result.stdout).codemux.usage.total_tokens).toBe(23);
  expect(agentsSupporting("run.cost")).toContain("codex");
  expect(row("docs/results-and-usage.md", "Codex")).toContain("account/usage/read");
  expect(flat("docs/results-and-usage.md")).not.toContain("(copilot, openhands)");
  const protocol = flat("docs/session-protocol.md");
  for (const agent of ["aider", "kimi"] as const) expect(agentsSupporting("session.usage")).toContain(agent);
  expect(protocol).toContain("Aider reports output tokens and positive cost from local analytics");
  expect(protocol).toContain("Kimi reports turn token deltas from its wire log");
});

test("Pi plain provider sessions and final caller-home retention are documented", () => {
  expect(agentsSupporting("session.provider-override")).toContain("pi");
  const sessions = flat("docs/sessions.md");
  expect(sessions).toContain("A Pi override session supports both plain and hermetic mode");
  expect(sessions).not.toMatch(/override (works only hermetic|session requires `--hermetic`)/);
  expect(flat("docs/cli.md")).toContain("requires `--hermetic` or `--harness-home`");
  expect(flat("docs/cli.md")).toContain("preserves a caller-owned `--harness-home`");
});

test("Qwen context-cap prose names its implemented run settings carrier", () => {
  expect(agentsSupporting("run.provider-override.max-context-tokens")).toContain("qwen");
  expect(row("docs/provider-overrides.md", "Qwen")).toContain("model.generationConfig.contextWindowSize");
});

test("configuration precedence documents relative HOME before USERPROFILE", () => {
  expect(getConfigPath({ HOME: "relative", USERPROFILE: "/chosen/profile" }, "/fallback"))
    .toBe("/fallback/.config/codemux/config.yaml");
  expect(getConfigPath({ HOME: "", USERPROFILE: "/chosen/profile" }, "/fallback"))
    .toBe("/chosen/profile/.config/codemux/config.yaml");
  expect(flat("docs/configuration.md")).toContain("even when USERPROFILE is absolute");
});

test("OpenCode persistence and Qwen's disposable-canary limitation stay distinct", () => {
  const isolation = flat("docs/isolation.md");
  expect(isolation).toContain("Agy, and OpenCode homes included; Qwen keeps no session-keyed home");
  expect(isolation).toContain("including `--session`, refuses with exit 64");
  expect(flat("CHANGELOG.md")).not.toMatch(/opencode rides.*?keeps no session-keyed home/);
  expect(isolation).not.toContain("OpenCode keeps no session-keyed home");
  expect(flat("docs/architecture.md")).toContain("Qwen uses safe mode and keeps no session-keyed home");
});

test("sibling documentation qualifies provider evidence, project settings, and check applicability", () => {
  const usage = flat("docs/results-and-usage.md");
  expect(names(usage.match(/Provider-reported run evidence is available from (.*?)\.(?:\s|$)/)![1]!))
    .toEqual([...SERVED_MODEL_EVIDENCE_HARNESSES].sort());
  const projects = flat("docs/isolation.md").split("### Experiment project settings ")[1]!;
  expect(names(projects.match(/It is supported by (.*?);/ )![1]!))
    .toEqual(agentsSupporting("run.experiment-project-settings").sort());
  expect(projects).not.toContain("Every other run suppresses repository settings");
  expect(flat("docs/session-protocol.md")).toContain("the caller-owned `--harness-home` directory");
  expect(row("docs/RELEASE-GATE.md", "D")).toContain("`check.hermetic`");
  expect(row("docs/RELEASE-GATE.md", "F")).toContain("orderly draining of accepted work");
  expect(row("docs/isolation.md", "Cline")).not.toContain("awaits");
});

test("Pi served-model discovery matches parsed session events", async () => {
  const parsed = parsePiSessionTurn(JSON.stringify({ type: "message_end", message: {
    role: "assistant", model: "served-pi", stopReason: "stop", content: [{ type: "text", text: "reply" }],
  } }), { knownSessionId: null });
  expect(parsed.servedModel).toBe("served-pi");
  const child = fakeTurnProcess();
  const h = engineSession({ options: { profile: wireProfile({ modelEffective: parsed.servedModel }, { agent: "pi" }),
    spawnTurn: async () => child } });
  try {
    h.user(); await Promise.resolve(); await Promise.resolve(); child.exit(0);
    const completed = await h.wait("turn_completed");
    expect(SESSION_SERVED_MODEL.pi).toContain(completed.model_served_source as "provider");
    expect(completed.model_served).toBe("served-pi");
  } finally { child.exit(0); h.close(); await h.code(); h.dispose(); }
});
