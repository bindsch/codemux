import { expect, test } from "bun:test";
import { AGENT_IDS } from "../src/types.js";
import { getAdapter } from "../src/adapters/index.js";
import { SESSION_AGENTS } from "../src/session/cli-agents.js";
import { PARITY, type ParityFeature } from "../src/parity/index.js";
import { PROBE_FEATURE } from "../src/parity/probe-features.js";
import { harnessFacts } from "../scripts/live-gate/facts.js";
import { PROBE_LETTERS, probeApplies, unsupportedNote } from "../scripts/live-gate/probes.js";
import { candidateFacts } from "../scripts/live-gate/candidate.js";

test("every probe names its capability or explicitly applies to all agents", () => {
  expect(Object.keys(PROBE_FEATURE).sort()).toEqual([...PROBE_LETTERS].sort());
  expect(PROBE_FEATURE.D).toBe("check.hermetic");
  expect(PROBE_FEATURE.K).toBe("session.hermetic");
  expect(PROBE_FEATURE.I).toBe("run.model");
  expect(PROBE_FEATURE.I2).toBe("run.effort");
});

for (const agent of AGENT_IDS) {
  test(`${agent} probe applicability and UNSUPPORTED reasons match parity`, () => {
    const facts = harnessFacts(agent, getAdapter(agent, { PATH: "" }).capabilities(), SESSION_AGENTS[agent] !== undefined);
    for (const letter of PROBE_LETTERS) {
      const feature = PROBE_FEATURE[letter];
      const state = feature === null ? undefined : PARITY[agent][feature];
      expect(probeApplies(letter, facts), `${agent} ${letter} ${feature}`)
        .toBe(state === undefined || state.state === "supported");
      if (state?.state === "harness-limitation") expect(unsupportedNote(letter, facts)).toBe(state.reason);
    }
    const fields = {
      hermetic: "run.hermetic", resultJson: "run.result-json", toolsNone: "run.tools-none",
      sessions: "session.driver", sessionHermetic: "session.hermetic", checkHermetic: "check.hermetic",
      experiment: "run.experiment-mcp", providerOverride: "run.provider-override",
      servedModelEvidence: "run.served-model-evidence", budgetLimit: "run.max-budget-usd",
      model: "run.model", effort: "run.effort",
    } as const satisfies Partial<Record<keyof typeof facts, ParityFeature>>;
    for (const [field, feature] of Object.entries(fields)) {
      expect(facts[field as keyof typeof fields], `${agent} ${field}`)
        .toBe(PARITY[agent][feature].state === "supported");
    }
  });
}

test("candidate isolation facts never fall back to this checkout's session or run claims", () => {
  const caps = { supportsHermetic: true, supportsResultJson: true, supportsToolSelection: true };
  const candidate = { experiment: false, experimentPrefix: null, servedModelEvidence: false };
  const old = harnessFacts("claude", caps, true, candidate);
  expect(() => probeApplies("D", old)).toThrow("checkHermetic declaration");
  expect(() => probeApplies("K", old)).toThrow("sessionHermetic declaration");
  const current = harnessFacts("claude", caps, true, {
    ...candidate, checkHermetic: false, sessionHermetic: false, toolsNone: false, model: false, effort: false,
  });
  for (const letter of ["D", "K", "E", "I", "I2"] as const) expect(probeApplies(letter, current)).toBe(false);
  expect(probeApplies("P", current)).toBe(true);
  expect(unsupportedNote("K")).toContain("session driver and a hermetic capability");
  expect(unsupportedNote("A", current)).toContain("headless");
  expect(() => unsupportedNote("C", current)).toThrow("must declare the reason and evidence");
  const limited = { ...current, limitations: {
    "run.result-json": { reason: "Synthetic candidate has no JSON mode", evidence: "Synthetic fixture 1.0.0" },
  } };
  expect(unsupportedNote("C", limited)).toBe("Synthetic candidate has no JSON mode");
  expect(unsupportedNote("C", { ...current, declarationSource: "checkout" }))
    .toContain("supports run.result-json");
});

test("candidate discovery preserves isolation declarations and limitation evidence", () => {
  const limitations = { "run.provider-override": {
    reason: "Synthetic candidate has no provider routing", evidence: "Synthetic fixture 1.0.0",
  } };
  const listing = { schema: "codemux-list-1", agents: [{ id: "claude", available: true, binary: "synthetic",
    capabilities: {
      hermetic: true, checkHermetic: true, sessionHermetic: true, sessions: true,
      resultJson: true, budgetLimit: true, toolsNoneRequiresHermetic: false, toolsNone: true,
      providerOverride: false, experimentMcp: false, experimentPrefix: null,
      servedModelEvidence: true, model: true, effort: true, limitations,
    },
  }] };
  const fact = candidateFacts(listing, "synthetic candidate").facts[0]!;
  expect(fact.checkHermetic).toBe(true);
  expect(fact.sessionHermetic).toBe(true);
  expect(fact.limitations).toEqual(limitations);
  expect(probeApplies("D", fact)).toBe(true);
  expect(probeApplies("K", fact)).toBe(true);
  expect(unsupportedNote("H2", fact)).toBe(limitations["run.provider-override"].reason);
});
