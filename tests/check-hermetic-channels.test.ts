import { expect, test } from "bun:test";
import { getAdapter } from "../src/adapters/index.js";
import { assertHermeticCheckSupported } from "../src/check-hermetic-plan.js";
import { HERMETIC_CHECK_CHANNELS, HERMETIC_CHECK_MARKER } from "../src/hermetic-check-channels.js";
import { AGENT_IDS } from "../src/types.js";

const rows = [
  { agent: "cline", location: "home", files: [".agents/AGENTS.md"], homeEnv: "HOME" },
  { agent: "claude", location: "cwd", files: ["AGENTS.md", "CLAUDE.md"] },
  { agent: "zai", location: "cwd", files: ["AGENTS.md", "CLAUDE.md"] },
  { agent: "codex", location: "cwd", files: ["AGENTS.md"] },
  { agent: "opencode", location: "cwd", files: ["AGENTS.md"] },
  { agent: "pi", location: "cwd", files: ["AGENTS.md", "CLAUDE.md"] },
  { agent: "kimi", location: "home", files: [".kimi-code/AGENTS.md", ".agents/AGENTS.md"], custom: "kimi" },
  { agent: "agy", location: "home", files: [".gemini/GEMINI.md"], custom: "agy", homeEnv: "HOME" },
  { agent: "aider", location: "home", files: [".aider.conf.yml", ".aider/canary.md"], homeEnv: "HOME" },
  { agent: "copilot", location: "home", files: ["copilot-instructions.md"], homeEnv: "COPILOT_HOME" },
  { agent: "droid", location: "home", files: [".factory/AGENTS.md"], homeEnv: "HOME" },
  { agent: "gemini", location: "home", files: [".gemini/GEMINI.md"], homeEnv: "GEMINI_CLI_HOME" },
  { agent: "goose", location: "home", files: ["goose/.goosehints"], homeEnv: "XDG_CONFIG_HOME" },
  { agent: "openhands", location: "home", files: [".openhands/microagents/canary.md"], homeEnv: "HOME" },
] as const;

test("the channel table covers all 15 hermetic agents and no other agent", () => {
  const supported = AGENT_IDS.filter((agent) => getAdapter(agent, { PATH: "" }).capabilities().supportsHermetic);
  expect(supported).toHaveLength(15);
  expect(Object.keys(HERMETIC_CHECK_CHANNELS).sort()).toEqual([...supported].sort());
  expect([...rows.map((row) => row.agent), "qwen"].sort()).toEqual([...supported].sort());
});

test.each([...rows])("$agent names the native instruction channel and a precise control", (row) => {
  const channel = assertHermeticCheckSupported(row.agent);
  expect(channel.location).toBe(row.location);
  expect(Object.keys(channel.files).sort()).toEqual([...row.files].sort());
  expect(channel.homeEnv).toBe("homeEnv" in row ? row.homeEnv : undefined);
  expect(channel.custom).toBe("custom" in row ? row.custom : undefined);
  expect(channel.control.drop).toBe(row.agent === "copilot" ? "no-custom-instructions" : "hermetic");
  expect(Object.values(channel.files).join("\n")).toContain(HERMETIC_CHECK_MARKER);
  expect(channel.evidence).toContain("2026-11-09");
  expect(channel.evidence).not.toMatch(/\/(?:Users|home)\/[^/\s]+/);
});

test("Qwen documents why its positive control is impossible without weakening safe mode", () => {
  const channel = HERMETIC_CHECK_CHANNELS.qwen;
  expect(channel.kind).toBe("limitation");
  expect(channel.reason).toContain("--safe-mode");
  expect(channel.reason).toContain("never launches qwen outside safe mode");
  expect(channel.evidence).toContain("0.24.0");
  expect(() => assertHermeticCheckSupported("qwen")).toThrow("check --hermetic cannot run for qwen: Qwen 0.24.0's --safe-mode");
});

test.each(["cursor"] as const)("%s refuses a check without a declared channel", (agent) => {
  expect(() => assertHermeticCheckSupported(agent)).toThrow("does not support a hermetic instruction check");
});
