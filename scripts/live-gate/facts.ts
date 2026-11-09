/** The harness facts the live gate's probe matrix is built from, split
 * from scripts/live-gate/probes.ts: what a probe needs to know about one
 * harness, derived from the adapter's declared capabilities plus the
 * session and experiment sets. probes.ts re-exports everything here, so
 * its importers keep their paths. */

import type { AgentId } from "../../src/types.js";
import { EXPERIMENT_MCP_HARNESSES } from "../../src/experiment-mcp.js";
import { SERVED_MODEL_EVIDENCE_HARNESSES } from "../../src/result-envelope/index.js";
import { SESSION_AGENTS } from "../../src/session/cli-agents.js";
import { HERMETIC_CHECK_CHANNELS, type HermeticCheckChannel } from "../../src/hermetic-check-channels.js";
import type { ParityFeature } from "../../src/parity/features.js";

export type CandidateLimitations = Partial<Record<ParityFeature, { reason: string; evidence: string }>>;

// What a probe needs to know about one harness. Derived from the adapter's
// declared capabilities plus the session and experiment sets, so the report's
// UNSUPPORTED rows quote the same facts the capability matrix documents.
export interface HarnessFacts {
  id: AgentId;
  hermetic: boolean;
  resultJson: boolean;
  /** `--tools none` works only inside a hermetic run (opencode): probe E
   * carries `--hermetic` for exactly these adapters. */
  toolsNoneRequiresHermetic: boolean;
  sessions: boolean;
  /** Session isolation has a separate declaration from one-shot runs. */
  sessionHermetic?: boolean;
  /** A paired canary needs an instruction channel for its plain control. */
  checkHermetic?: boolean;
  declarationSource?: "checkout" | "candidate";
  limitations?: CandidateLimitations;
  experiment: boolean;
  experimentPrefixes: readonly string[];
  providerOverride: boolean;
  servedModelEvidence: boolean;
  /** The adapter declares `--tools none` (supportsToolSelection): probe E
   * runs wherever this is true, plain except where the hermetic form above
   * is required. */
  toolsNone: boolean;
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

// Unconditional provider-reported model evidence in result envelopes.
// Probe H also requires provider overrides and result JSON. The envelope
// builders own this table; tests compare it with the parity declaration.
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
  capabilities: { supportsHermetic?: boolean; supportsResultJson?: boolean; budgetLimit?: boolean; toolsNoneRequiresHermetic?: boolean; supportsToolSelection?: boolean; supportsProviderOverride?: boolean; supportsModel?: boolean; supportsEffort?: boolean },
  sessions: boolean,
  candidate?: CandidateExperimentFacts & { model?: boolean; effort?: boolean; toolsNone?: boolean; binaryName?: string;
    sessionHermetic?: boolean; checkHermetic?: boolean; limitations?: CandidateLimitations }
): HarnessFacts {
  const experimentPrefixes = EXPERIMENT_HARNESSES[id];
  const checkChannels: Readonly<Partial<Record<AgentId, HermeticCheckChannel>>> = HERMETIC_CHECK_CHANNELS;
  return {
    id,
    declarationSource: candidate === undefined ? "checkout" : "candidate",
    ...(candidate?.limitations === undefined ? {} : { limitations: candidate.limitations }),
    hermetic: capabilities.supportsHermetic === true,
    resultJson: capabilities.supportsResultJson === true,
    // A candidate that declares its own tools-none fact (a newer listing)
    // gets its own E probe matrix; an older listing without it is refused
    // by candidate.ts before facts are built, the same rule as model and
    // effort.
    toolsNone: candidate?.toolsNone ?? capabilities.supportsToolSelection === true,
    toolsNoneRequiresHermetic: capabilities.toolsNoneRequiresHermetic === true,
    sessions,
    sessionHermetic: candidate === undefined
      ? sessions && SESSION_AGENTS[id]?.hermetic === true
      : candidate.sessionHermetic,
    checkHermetic: candidate === undefined
      ? checkChannels[id]?.kind === "channel"
      : candidate.checkHermetic,
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
