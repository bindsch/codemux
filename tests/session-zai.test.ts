/**
 * Unit tests for the zai session wiring (design §4.7, plan step 7):
 * the Z.AI mode of the claude-family path. Zai is the same `claude`
 * binary against the Z.AI endpoint, so what is pinned here is exactly
 * that identity discipline: the capability matrix equals claude's, the
 * floor equals claude's, the spawn argv is the claude argv (no zai
 * binary exists), and the harness home is the shared claude store —
 * the registry's agent match, not a split path, is the cross-agent
 * guard. The round-trips themselves are the claude-family e2e suite;
 * the CLI-level zai tests (key check, cross-agent resume refusal, the
 * happy path) live in tests/session-cli.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  CLAUDE_SESSION_FLOOR,
  buildClaudeSessionCommand,
  claudeSessionCapabilities,
} from "../src/session/claude-session.js";
import {
  ZAI_SESSION_FLOOR,
  buildZaiSessionCommand,
  zaiSessionCapabilities,
} from "../src/session/zai-session.js";

const CWD = "/tmp/codemux-zai-scope";

describe("zai session - identity", () => {
  test("the floor is the claude floor: one binary, one gate", () => {
    expect(ZAI_SESSION_FLOOR).toBe(CLAUDE_SESSION_FLOOR);
    expect(ZAI_SESSION_FLOOR).toBe("2.1.280");
  });

  test("the capability matrix equals claude's, deviations included", () => {
    expect(zaiSessionCapabilities()).toEqual(claudeSessionCapabilities());
    expect(zaiSessionCapabilities().user_during_turn).toBe(false);
    expect(zaiSessionCapabilities().file_changes).toBe("derived");
  });

  test("the spawn argv is the claude-family argv — there is no zai binary", () => {
    const zai = buildZaiSessionCommand({
      resumeId: "11111111-2222-3333-4444-555555555555",
      model: "opus",
      autonomy: "high",
      cwd: CWD,
    });
    const claude = buildClaudeSessionCommand({
      agent: "claude",
      resumeId: "11111111-2222-3333-4444-555555555555",
      model: "opus",
      autonomy: "high",
      cwd: CWD,
    });
    expect(zai.argv).toEqual(claude.argv);
    expect(zai.argv[0]).toBe("claude");
    expect(zai.argv).toContain("--permission-prompt-tool");
    expect(zai.argv.join(" ")).not.toContain("dangerously");
  });
});
