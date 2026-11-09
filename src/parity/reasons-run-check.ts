import { HERMETIC_CHECK_CHANNELS, type HermeticAgentId } from "../hermetic-check-channels.js";
import type { AgentId } from "../types.js";
import { limitation, supported, type FeatureState, type ParityTest } from "./features.js";

/** The instruction-channel table owns paired-check applicability, separately from runs. */
export function hermeticCheckDeclaration(agent: AgentId, test: ParityTest): FeatureState {
  if (!Object.hasOwn(HERMETIC_CHECK_CHANNELS, agent)) {
    return limitation(
      `OPEN: ${agent} has no hermetic instruction-check channel; the current refusal has no evidence excluding every harness carrier.`,
      "2026-11-09: src/hermetic-check-channels.ts; src/check-hermetic-plan.ts assertHermeticCheckSupported",
      `${agent} does not support a hermetic instruction check`, test
    );
  }
  const channel = HERMETIC_CHECK_CHANNELS[agent as HermeticAgentId];
  if (channel.kind === "channel") return supported(test);
  // A limitation-kind entry carries its own closed reason: its evidence is
  // the dated upstream proof (the channel cannot be opened for a control
  // run), and the refusal is the check's own gate, verbatim. The entry's
  // reason reaches the operator unchanged through
  // assertHermeticCheckSupported's throw, so the declaration and the
  // runtime message cannot drift.
  return limitation(
    channel.reason,
    channel.evidence,
    `check --hermetic cannot run for ${agent}`, test
  );
}

/** Probe H needs every prerequisite; output model evidence alone is insufficient. */
export function providerEvidenceCheck(row: Record<
  "run.provider-override" | "run.result-json" | "run.served-model-evidence", FeatureState
>): FeatureState {
  for (const feature of ["run.provider-override", "run.result-json", "run.served-model-evidence"] as const) {
    if (row[feature].state === "harness-limitation") return row[feature];
  }
  return row["run.served-model-evidence"];
}
