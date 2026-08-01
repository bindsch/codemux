import { describe, test, expect } from "bun:test";
import { AGENT_IDS, getAdapter } from "../src/adapters/index.js";
import { AUTONOMY_EQUIVALENCE } from "../src/autonomy.js";
import {
  AUTONOMY_LEVELS,
  isAutonomyLevel,
  isReasoningEffort,
} from "../src/types.js";

describe("Autonomy equivalence matrix", () => {
  test("runtime type guards reject unsupported values", () => {
    expect(isAutonomyLevel("read-only")).toBe(true);
    expect(isAutonomyLevel("root")).toBe(false);
    expect(isReasoningEffort("high")).toBe(true);
    expect(isReasoningEffort("extreme")).toBe(false);
  });

  test("covers every registered agent", () => {
    const matrixAgents = Object.keys(AUTONOMY_EQUIVALENCE).sort();
    const registeredAgents = [...AGENT_IDS].sort();
    expect(matrixAgents).toEqual(registeredAgents);
  });

  test("defines all normalized autonomy levels for each agent", () => {
    for (const agentId of AGENT_IDS) {
      const mapping = AUTONOMY_EQUIVALENCE[agentId];
      for (const level of AUTONOMY_LEVELS) {
        expect(mapping.byLevel[level]).toBeString();
        expect(mapping.byLevel[level].length).toBeGreaterThan(0);
      }
    }
  });

  test("contains entries for adapter-declared autonomy levels", () => {
    for (const agentId of AGENT_IDS) {
      const caps = getAdapter(agentId).capabilities();
      if (!caps.supportsAutonomy) {
        continue;
      }

      const mapping = AUTONOMY_EQUIVALENCE[agentId];
      for (const level of caps.autonomyLevels) {
        expect(mapping.byLevel[level]).toBeString();
        expect(mapping.byLevel[level].length).toBeGreaterThan(0);
      }
    }
  });
});
