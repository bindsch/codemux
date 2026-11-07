/** The harness facts the live gate's probe matrix is built from, split
 * from scripts/live-gate/probes.ts: what a probe needs to know about one
 * harness, derived from the adapter's declared capabilities plus the
 * session and experiment sets. probes.ts re-exports everything here, so
 * its importers keep their paths. */

import type { AgentId } from "../../src/types.js";
import { EXPERIMENT_MCP_HARNESSES } from "../../src/experiment-mcp.js";
import { SERVED_MODEL_EVIDENCE_HARNESSES } from "../../src/result-envelope/index.js";

// What a probe needs to know about one harness. Derived from the adapter's
// declared capabilities plus the session and experiment sets, so the report's
// UNSUPPORTED rows quote the same facts the capability matrix documents.
export interface HarnessFacts {
  id: AgentId;
  hermetic: boolean;
  resultJson: boolean;
  toolsNoneRequiresHermetic: boolean;
  sessions: boolean;
  experiment: boolean;
  experimentPrefixes: readonly string[];
  providerOverride: boolean;
  servedModelEvidence: boolean;
  /** The harness carries `run --max-budget-usd` (Claude Code's own spend
   * cap; claude and zai). No probe keys on it yet — carried so the report
   * can state the fact the listing declared. */
  budgetLimit: boolean;
  /** The adapter declares -m model selection and --effort — the pair
   * probe I runs together (audit D7). */
  model: boolean;
  effort: boolean;
  /** The harness binary the build under test runs (the candidate's own in
   * candidate mode): probe P verifies the printed argv against it. */
  binaryName?: string;
}

// The experiment set and prefixes are the src table the validator itself
// reads (EXPERIMENT_MCP_HARNESSES, src/experiment-mcp.ts): the gate's
// probe G set must be exactly the set that validator accepts, or the
// matrix reports UNSUPPORTED for a harness the run path would happily
// take. tests/live-gate.test.ts pins the lockstep against the validator
// and the listing.
export const EXPERIMENT_HARNESSES: Readonly<Partial<Record<AgentId, readonly string[]>>> =
  EXPERIMENT_MCP_HARNESSES;

// The harnesses whose result envelope carries provider-reported model
// evidence (`codemux.served_model`, from claude's and zai's modelUsage key
// or codex's reroute). OpenCode's pinned 1.18.18 run wire and kimi's
// stream-json and wire log expose no served-model field (their envelopes
// report `served_model: null`), so probe H cannot verify an override for
// them in-band and reports UNSUPPORTED instead. Derived from the envelope
// builders' own table (SERVED_MODEL_EVIDENCE_HARNESSES,
// src/result-envelope/index.ts); tests/live-gate-verify.test.ts pins the
// lockstep.
export const SERVED_MODEL_EVIDENCE: ReadonlySet<AgentId> = SERVED_MODEL_EVIDENCE_HARNESSES;

/** The experiment and served-model facts a candidate build declared for
 * one harness through its `list --json` listing
 * (scripts/live-gate/candidate.ts). This checkout's own launches pass
 * nothing and the src tables answer; a candidate's facts override them,
 * so the G and H probe sets describe the build under test, not the
 * probing checkout (review round 20, edges finding 2). */
export interface CandidateExperimentFacts {
  experiment: boolean;
  experimentPrefix: string | null;
  servedModelEvidence: boolean;
}

export function harnessFacts(
  id: AgentId,
  capabilities: { supportsHermetic?: boolean; supportsResultJson?: boolean; budgetLimit?: boolean; toolsNoneRequiresHermetic?: boolean; supportsProviderOverride?: boolean; supportsModel?: boolean; supportsEffort?: boolean },
  sessions: boolean,
  candidate?: CandidateExperimentFacts & { model?: boolean; effort?: boolean; binaryName?: string }
): HarnessFacts {
  const experimentPrefixes = EXPERIMENT_HARNESSES[id];
  return {
    id,
    hermetic: capabilities.supportsHermetic === true,
    resultJson: capabilities.supportsResultJson === true,
    toolsNoneRequiresHermetic: capabilities.toolsNoneRequiresHermetic === true,
    sessions,
    experiment: candidate?.experiment ?? experimentPrefixes !== undefined,
    experimentPrefixes: candidate === undefined
      ? experimentPrefixes ?? []
      : candidate.experimentPrefix === null ? [] : [candidate.experimentPrefix],
    providerOverride: capabilities.supportsProviderOverride === true,
    servedModelEvidence: candidate?.servedModelEvidence ?? SERVED_MODEL_EVIDENCE.has(id),
    // A candidate declares its own spend-limit fact; an older listing
    // without the field answers false, the same default an absent
    // capability means everywhere else.
    budgetLimit: capabilities.budgetLimit === true,
    // A candidate that declares its own model/effort facts (a newer
    // listing) gets its own I probe matrix; an older listing without them
    // is refused by candidate.ts before facts are built.
    model: candidate?.model ?? capabilities.supportsModel === true,
    effort: candidate?.effort ?? capabilities.supportsEffort === true,
    ...(candidate?.binaryName === undefined ? {} : { binaryName: candidate.binaryName }),
  };
}
