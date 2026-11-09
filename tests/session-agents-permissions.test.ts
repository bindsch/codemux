import { describe, expect, test } from "bun:test";
import { AUTONOMY_EQUIVALENCE } from "../src/autonomy.js";
import { SESSION_AGENTS } from "../src/session/cli-agents.js";
import type { AgentId } from "../src/types.js";
import { claudeSessionCapabilities } from "../src/session/claude-session.js";
import { zaiSessionCapabilities } from "../src/session/zai-session.js";
import { codexSessionCapabilities } from "../src/session/codex-session.js";
import { kimiSessionCapabilities } from "../src/session/kimi-session.js";
import { opencodeSessionCapabilities } from "../src/session/opencode-session.js";
import { agySessionCapabilities } from "../src/session/agy-session.js";
import { aiderSessionCapabilities } from "../src/session/aider-session.js";
import { cursorSessionCapabilities } from "../src/session/cursor-session.js";
import { droidSessionCapabilities } from "../src/session/droid-session.js";
import { piSessionCapabilities } from "../src/session/pi-session.js";
import { qwenSessionCapabilities } from "../src/session/qwen-session.js";
import { geminiSessionCapabilities } from "../src/session/gemini-session.js";
import { copilotSessionCapabilities } from "../src/session/copilot-session.js";
import { gooseSessionCapabilities } from "../src/session/goose-session.js";
import { clineSessionCapabilities } from "../src/session/cline-session.js";
import { openhandsSessionCapabilities } from "../src/session/openhands-session.js";

const capabilities = {
  claude: claudeSessionCapabilities,
  zai: zaiSessionCapabilities,
  codex: codexSessionCapabilities,
  kimi: kimiSessionCapabilities,
  opencode: opencodeSessionCapabilities,
  agy: agySessionCapabilities,
  aider: aiderSessionCapabilities,
  cursor: cursorSessionCapabilities,
  droid: droidSessionCapabilities,
  pi: piSessionCapabilities,
  qwen: qwenSessionCapabilities,
  gemini: geminiSessionCapabilities,
  copilot: copilotSessionCapabilities,
  goose: gooseSessionCapabilities,
  cline: clineSessionCapabilities,
  openhands: openhandsSessionCapabilities,
};

describe("session approval declarations", () => {
  test("every session driver has one declaration", () => {
    expect(Object.keys(SESSION_AGENTS).sort()).toEqual(Object.keys(capabilities).sort());
  });

  for (const [agent, getCapabilities] of Object.entries(capabilities)) {
    test(`${agent} publishes its wire capability and evidence through autonomy`, () => {
      const support = SESSION_AGENTS[agent as AgentId]!;
      expect(support.approvals === "ask").toBe(getCapabilities().permissions);
      const note = AUTONOMY_EQUIVALENCE[agent as keyof typeof capabilities].notes!;
      if (support.approvals === "ask") {
        expect(support.approvalsNote).toBeNull();
        expect(note).toContain("sessions: approval requests use permission_request and permission_decision");
      } else {
        expect(support.approvalsNote).toContain("no permission channel:");
        expect(support.approvalsNote).toMatch(/\d+\.\d+\.\d+/);
        expect(note).toContain(`sessions: ${support.approvalsNote}`);
      }
    });
  }
});
