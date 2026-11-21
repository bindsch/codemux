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
import { agyToolsNoneRefusal } from "../../src/adapters/agy.js";
import type { ProbeResult } from "./runner.js";

/** A provider or gate quota refusal seen in a probe's captured stderr.
 * Evidenced spellings from the live gates of 2026-11-08 and 2026-11-12:
 * - codemux's own pre-spawn refusal, exit 64, printed as
 *   `Error: quota gate: <agent>: ... below the ...% ceiling`;
 * - agy's `Individual quota reached` and `RESOURCE_EXHAUSTED (code 429)`;
 * - kimi's `provider.api_error: You've reached your weekly (7-day) usage
 *   limit. ...`. The runner decides on the run's final failure diagnostic
 *   (the `quotaRefusal` field), independently of its bounded first-line
 *   preview. Older callers can still pass that preview.
 * Anything else is a behavior failure and stays a FAIL. */
export function quotaRefusalIn(result: ProbeResult): string | null {
  if (result.status !== "FAIL") return null;
  return result.quotaRefusal !== undefined ? result.quotaRefusal : providerQuotaRefusal(result.stderr);
}

/** Match diagnostics before the runner truncates them for the report. */
export function providerQuotaRefusal(stderr: string): string | null {
  if (/^warning:/i.test(stderr.trim())) return null;
  const patterns: [RegExp, string][] = [
    [/Error: quota gate: .* below the \d+% ceiling/, "the codemux quota gate refused the launch"],
    [/Individual quota reached\b/, "the provider refused the run: individual quota reached"],
    [/RESOURCE_EXHAUSTED\s*\(code 429\)/, "the provider refused the run: RESOURCE_EXHAUSTED (code 429)"],
    [/reached your weekly \(7-day\) usage limit/, "the provider refused the run: weekly usage limit reached"],
  ];
  for (const [pattern, label] of patterns) {
    if (pattern.test(stderr)) return label;
  }
  return null;
}

/**
 * The only lines that may follow a quota refusal without ending it,
 * matched exactly (review round 5). Each is printed by codemux about the
 * refused run itself and adds no independent failure:
 * - agy's `--tools none` refusal when the one attempted action is the
 *   refusal's own `error_message` step. A trailer that lists any other
 *   action reports real tool activity and is a behavior failure.
 * - the agy isolation check's summary of a failed probe whose only
 *   non-text steps were `error_message`, and its verdict line when both
 *   the probe and the control failed.
 * Any other line after a refusal makes the run a behavior failure.
 */
export function isQuotaRefusalTrailer(line: string): boolean {
  if (line === `codemux: agy ${agyToolsNoneRefusal(["error_message"])}`) return true;
  if (/^(?:HERMETIC|TOOLS) agy: FAIL \(probe failed, control failed\)$/.test(line)) return true;
  const summary = /^probe summary: (\{.*\})$/.exec(line);
  if (summary === null) return false;
  try {
    const parsed = JSON.parse(summary[1]!) as { passed?: unknown; attemptedActions?: unknown };
    return parsed.passed === false && Array.isArray(parsed.attemptedActions) &&
      parsed.attemptedActions.every((action) => action === "error_message");
  } catch { return false; }
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
 * decides nothing either: its probes spawn, and
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
