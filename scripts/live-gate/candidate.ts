// Candidate-mode discovery for the live gate (review round 18, edges 4).
// `--codemux <path>` names the build under test; when it is not this
// checkout's own launcher, the gate must not read discovery or
// capabilities from this checkout's adapter registry — a candidate that
// added, removed, or re-capabilityed an agent would be probed against the
// wrong matrix. The candidate answers `list --json` (src/info-commands.ts,
// schema codemux-list-1) and the gate builds its facts from that listing.
import { runCapturedCommand } from "../../src/process-runner.js";
import { AGENT_IDS, type AgentId } from "../../src/types.js";
import { harnessFacts, type HarnessFacts } from "./probes.js";
import type { ContractHarness } from "./contracts.js";

export const CANDIDATE_LIST_SCHEMA = "codemux-list-1";

export interface CandidateDiscovery {
  /** The probe matrix rows: the agents the candidate lists as available,
   * with the capabilities the candidate declared for them. */
  facts: HarnessFacts[];
  /** The contract column's input, from the same listing: every id the
   * candidate lists as available, each with the candidate's own binary
   * name (round 19, edges 4). An id this checkout cannot resolve still
   * gets its entry — the row is UNREADABLE, never absent. */
  contractHarnesses: ContractHarness[];
  /** The report's NOTE line naming the source of the matrix. */
  note: string;
}

function booleanField(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${where} must be a boolean`);
  return value;
}

/** Turn one parsed listing into gate facts. Everything the gate needs is
 * checked here — a malformed entry, an unknown agent id, or a duplicate
 * row is a refusal, never a silently dropped or guessed capability. The
 * facts and the contract-column inputs come from the same pass, so the
 * two cannot disagree about which agents the candidate lists. */
export function candidateFacts(
  listing: unknown,
  source: string
): { facts: HarnessFacts[]; contractHarnesses: ContractHarness[] } {
  if (typeof listing !== "object" || listing === null || Array.isArray(listing)) {
    throw new Error(`${source}: the listing is not a JSON object`);
  }
  const schema = (listing as { schema?: unknown }).schema;
  if (schema !== CANDIDATE_LIST_SCHEMA) {
    throw new Error(`${source}: the listing's schema is ${JSON.stringify(schema) ?? "absent"}, not ${CANDIDATE_LIST_SCHEMA}`);
  }
  const agents = (listing as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) {
    throw new Error(`${source}: the listing's agents field is not an array`);
  }
  const seen = new Set<AgentId>();
  const facts: HarnessFacts[] = [];
  const contractHarnesses: ContractHarness[] = [];
  for (const entry of agents) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${source}: an agents entry is not an object`);
    }
    const agent = entry as Record<string, unknown>;
    const where = `${source}: agent ${JSON.stringify(agent.id) ?? "(no id)"}`;
    if (typeof agent.id !== "string") throw new Error(`${where}: id must be a string`);
    if (!AGENT_IDS.includes(agent.id as AgentId)) {
      throw new Error(`${where}: this codemux knows no such agent; the gate cannot probe a harness its own runner cannot name`);
    }
    const id = agent.id as AgentId;
    if (seen.has(id)) throw new Error(`${where}: listed twice`);
    seen.add(id);
    if (!booleanField(agent.available, `${where}: available`)) continue;
    // The binary name is the candidate's own; a listing without one (an
    // older build) leaves it undefined and the contract row says
    // UNREADABLE rather than guessing this checkout's spelling.
    if (agent.binary !== undefined && typeof agent.binary !== "string") {
      throw new Error(`${where}: binary must be a string`);
    }
    const binaryName = agent.binary as string | undefined;
    const caps = agent.capabilities;
    if (typeof caps !== "object" || caps === null || Array.isArray(caps)) {
      throw new Error(`${where}: capabilities must be an object`);
    }
    // The experiment-MCP and served-model facts come from the listing too
    // (review round 20, edges finding 2): a candidate that changed
    // experiment or served-model support must get its own G/H probe
    // matrix, not this checkout's. The fields are required — a listing
    // without them is an older build, and guessing this checkout's facts
    // is exactly the defect this closes.
    const experimentMcpField = (caps as Record<string, unknown>).experimentMcp;
    if (experimentMcpField === undefined) {
      throw new Error(`${where}: capabilities.experimentMcp is absent; the listing is from an older build`);
    }
    const servedModelField = (caps as Record<string, unknown>).servedModelEvidence;
    if (servedModelField === undefined) {
      throw new Error(`${where}: capabilities.servedModelEvidence is absent; the listing is from an older build`);
    }
    const experimentPrefixField = (caps as Record<string, unknown>).experimentPrefix;
    if (experimentPrefixField !== undefined && experimentPrefixField !== null && typeof experimentPrefixField !== "string") {
      throw new Error(`${where}: capabilities.experimentPrefix must be a string or null`);
    }
    // The -m and --effort facts (probe I, audit D7) follow the same rule:
    // required, so a candidate's alias+effort probe set is its own.
    const modelField = (caps as Record<string, unknown>).model;
    if (modelField === undefined) {
      throw new Error(`${where}: capabilities.model is absent; the listing is from an older build`);
    }
    const effortField = (caps as Record<string, unknown>).effort;
    if (effortField === undefined) {
      throw new Error(`${where}: capabilities.effort is absent; the listing is from an older build`);
    }
    // The spend-limit fact rides the listing too, but no probe keys on it,
    // so a listing without the field (an older build) is not refused: the
    // fact reads false, and a malformed value still is.
    const budgetLimitField = (caps as Record<string, unknown>).budgetLimit;
    if (budgetLimitField !== undefined && typeof budgetLimitField !== "boolean") {
      throw new Error(`${where}: capabilities.budgetLimit must be a boolean`);
    }
    facts.push(harnessFacts(id, {
      supportsHermetic: booleanField((caps as Record<string, unknown>).hermetic, `${where}: capabilities.hermetic`),
      supportsResultJson: booleanField((caps as Record<string, unknown>).resultJson, `${where}: capabilities.resultJson`),
      budgetLimit: budgetLimitField === true,
      toolsNoneRequiresHermetic: booleanField((caps as Record<string, unknown>).toolsNoneRequiresHermetic, `${where}: capabilities.toolsNoneRequiresHermetic`),
      supportsProviderOverride: booleanField((caps as Record<string, unknown>).providerOverride, `${where}: capabilities.providerOverride`),
      supportsModel: booleanField(modelField, `${where}: capabilities.model`),
      supportsEffort: booleanField(effortField, `${where}: capabilities.effort`),
    }, booleanField((caps as Record<string, unknown>).sessions, `${where}: capabilities.sessions`),
      {
        experiment: booleanField(experimentMcpField, `${where}: capabilities.experimentMcp`),
        experimentPrefix: experimentPrefixField as string | null,
        servedModelEvidence: booleanField(servedModelField, `${where}: capabilities.servedModelEvidence`),
        ...(binaryName === undefined ? {} : { binaryName }),
      }));
    contractHarnesses.push(binaryName === undefined ? { id } : { id, binaryName });
  }
  return { facts, contractHarnesses };
}

/** The candidate's `--version` stamp must equal this checkout's version:
 * a gate run by an older or newer checkout probes a candidate against a
 * contract table that does not describe it. Refused unless the operator
 * passes --allow-version-mismatch (round 18, edges 4). */
export function assertCandidateVersion(
  stamp: string,
  expected: string,
  codemux: string,
  allowMismatch: boolean
): void {
  if (stamp === expected || allowMismatch) return;
  throw new Error(
    `the candidate at ${codemux} reports version ${stamp}, but this checkout is ${expected}; ` +
      "a gate from a different checkout reads a different contract table — pass --allow-version-mismatch to test it anyway"
  );
}

/** Ask the candidate for its agent listing and build the matrix from the
 * answer. `run` is injectable for tests; the default spawns the candidate. */
export async function discoverCandidate(
  codemux: string,
  expectedVersion: string,
  allowMismatch: boolean,
  stamp: string,
  run: (command: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }> = (command) =>
    runCapturedCommand(command, {
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      timeoutMs: 60_000,
    })
): Promise<CandidateDiscovery> {
  assertCandidateVersion(stamp, expectedVersion, codemux, allowMismatch);
  let captured: { exitCode: number; stdout: string; stderr: string };
  try {
    captured = await run([codemux, "list", "--json"]);
  } catch (error) {
    throw new Error(`could not run '${codemux} list --json': ${error instanceof Error ? error.message : String(error)}`);
  }
  if (captured.exitCode !== 0) {
    throw new Error(`'${codemux} list --json' exited ${captured.exitCode}: ${captured.stderr.trim().slice(0, 120)}`);
  }
  let listing: unknown;
  try {
    listing = JSON.parse(captured.stdout);
  } catch {
    throw new Error(`'${codemux} list --json' stdout does not parse: ${captured.stdout.trim().slice(0, 80)}`);
  }
  const { facts, contractHarnesses } = candidateFacts(listing, `${codemux} list --json`);
  return {
    facts,
    contractHarnesses,
    note: `NOTE: the probe matrix comes from the candidate (${codemux} list --json), not this checkout's adapters`,
  };
}
