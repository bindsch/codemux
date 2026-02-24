import { describe, test, expect } from "bun:test";
import { AGENT_IDS } from "../src/adapters/index.js";
import {
  buildEffectiveScodeCommands,
  verifyAgentWiring,
  verifyAgentsWiring,
} from "../src/verify.js";

describe("Verifier", () => {
  test("verifyAgentsWiring returns one result per agent", () => {
    const rows = verifyAgentsWiring(AGENT_IDS);
    expect(rows.length).toBe(AGENT_IDS.length);
  });

  test("verifyAgentsWiring has no FAIL rows for current adapters", () => {
    const rows = verifyAgentsWiring(AGENT_IDS);
    for (const row of rows) {
      expect(row.mappingOk).toBe(true);
      expect(row.runBuildOk).toBe(true);
      expect(row.tuiBuildOk).toBe(true);
      expect(row.status).not.toBe("FAIL");
    }
  });

  test("verifyAgentWiring supports single-agent validation", () => {
    const row = verifyAgentWiring("codex");
    expect(row.agentId).toBe("codex");
    expect(row.mappingOk).toBe(true);
    expect(row.runBuildOk).toBe(true);
    expect(row.tuiBuildOk).toBe(true);
  });

  test("buildEffectiveScodeCommands returns run+tui rows for each autonomy level", () => {
    const rows = buildEffectiveScodeCommands(["codex"]);
    expect(rows.length).toBe(8);
    expect(rows[0]?.agentId).toBe("codex");
    expect(rows.some((row) => row.mode === "run")).toBe(true);
    expect(rows.some((row) => row.mode === "tui")).toBe(true);
    expect(rows.some((row) => row.autonomy === "read-only")).toBe(true);
    expect(rows.every((row) => row.command[0] === "scode")).toBe(true);
  });

  test("buildEffectiveScodeCommands applies override options", () => {
    const rows = buildEffectiveScodeCommands(["codex"], {
      trust: "trusted",
      noNet: true,
      scrubEnv: true,
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.command).toContain("--trust");
      expect(row.command).toContain("trusted");
      expect(row.command).toContain("--no-net");
      expect(row.command).toContain("--scrub-env");
    }
  });

  test("buildEffectiveScodeCommands reflects per-harness strict trust defaults", () => {
    const rows = buildEffectiveScodeCommands(["codex", "opencode"]);
    const codexLowRun = rows.find(
      (row) => row.agentId === "codex" && row.autonomy === "low" && row.mode === "run"
    );
    const opencodeMediumRun = rows.find(
      (row) => row.agentId === "opencode" && row.autonomy === "medium" && row.mode === "run"
    );

    expect(codexLowRun).toBeDefined();
    expect(codexLowRun?.command).toContain("--trust");
    expect(codexLowRun?.command).toContain("untrusted");

    expect(opencodeMediumRun).toBeDefined();
    expect(opencodeMediumRun?.command).toContain("--trust");
    expect(opencodeMediumRun?.command).toContain("untrusted");
  });
});
