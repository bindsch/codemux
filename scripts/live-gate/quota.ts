/** Quota outcomes for the live gate (parity pass, 2.0.0): the gate's own
 * pre-spawn decisions from one snapshot (one `usage --json` per gate, not
 * one per probe process), and the classification that separates a provider
 * quota refusal from a behavior failure. Lives beside the probe modules so
 * run.ts and the hub re-export it; the decision RULE itself is
 * src/quota-gate.ts's pure gateOutcomeOnResult, so the gate and the launch
 * path cannot disagree about what "below the ceiling" means. */
import type { AgentId, QuotaPolicy } from "../../src/types.js";
import type { UsageSnapshot } from "../../src/usage-protocol.js";
import { gateOutcomeOnResult, snapshotFreshnessIssue } from "../../src/quota-gate.js";
import type { ProbeResult } from "./runner.js";

/** A provider or gate quota refusal seen in a probe's captured stderr.
 * Exactly the three evidenced spellings from the live gate of 2026-11-08
 * (the saved report's agy, codex, and kimi rows):
 * - codemux's own pre-spawn refusal, exit 64, printed as
 *   `Error: quota gate: <agent>: ... below the ...% ceiling`;
 * - agy's provider line `error: Individual quota reached. ...`;
 * - kimi's `provider.api_error: You've reached your weekly (7-day) usage
 *   limit. ...`. Substring matches: the runner stores stderr's first
 *   ordinary line escaped and cut at 160 characters, so a sentence match
 *   would miss the truncated tail (kimi's line ends mid-word at "To co").
 * Anything else is a behavior failure and stays a FAIL. */
export function quotaRefusalIn(result: ProbeResult): string | null {
  if (result.status !== "FAIL") return null;
  const patterns: [RegExp, string][] = [
    [/Error: quota gate: .* below the \d+% ceiling/, "the codemux quota gate refused the launch"],
    [/Individual quota reached\./, "the provider refused the run: individual quota reached"],
    [/reached your weekly \(7-day\) usage limit/, "the provider refused the run: weekly usage limit reached"],
  ];
  for (const [pattern, label] of patterns) {
    if (pattern.test(result.stderr)) return label;
  }
  return null;
}

export interface GateQuotaDecision {
  /** The launch-path gate would refuse this harness (gateOutcomeOnResult
   * found a window below the ceiling): its probe cells skip instead of
   * spawning and burning the refusal. */
  refused: boolean;
  /** The refusal message from the shared rule, named in the SKIP cell. */
  reason: string;
}

/** One snapshot, every probed harness: for each agent the gate applies the
 * same pure rule a launch applies (src/quota-gate.ts gateOutcomeOnResult),
 * over the client the agent spends from. A snapshot that is stale by the
 * gate's own freshness rule decides nothing — the gate, like the launch
 * path, fails open on an unreadable reading. An agent with no result row
 * (agy is excluded from the gate's own `usage --json` query because its
 * probe can take 90 seconds) decides nothing either: its probes spawn, and
 * a provider refusal after the spawn is classified by quotaRefusalIn. */
export function gateQuotaDecisions(
  snapshot: UsageSnapshot,
  policy: QuotaPolicy,
  agents: readonly AgentId[]
): ReadonlyMap<AgentId, GateQuotaDecision> {
  const decisions = new Map<AgentId, GateQuotaDecision>();
  if (snapshotFreshnessIssue(snapshot) !== null) return decisions;
  for (const agent of agents) {
    const client = policy.spendsFrom?.[agent] ?? agent;
    const result = snapshot.results.find((entry) => entry.client === client);
    if (result === undefined) continue;
    const outcome = gateOutcomeOnResult(agent, result, policy);
    if (outcome.refusal !== null) {
      decisions.set(agent, { refused: true, reason: outcome.refusal });
    }
  }
  return decisions;
}
