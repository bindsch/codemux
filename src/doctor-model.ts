/**
 * The machine check's shared vocabulary: the states a row can carry, the
 * row shapes, and the two small pure helpers every stage uses. Kept in one
 * module so the environment, harness-row, and spend stages reference one
 * definition and never drift (and so no stage imports another stage).
 */

import type { BaseAdapter } from "./adapters/base.js";
import type { FeatureFloorKind } from "./harness-contracts.js";
import { remedyFor } from "./doctor-remedies.js";
import { AGENT_IDS, type AgentId } from "./types.js";
import { UsageRefusalError } from "./validation.js";

export type MachineCheckState =
  | "OK"
  | "NOT-INSTALLED"
  | "UNTRUSTED"
  | "VERSION-BELOW-MIN"
  | "VERSION-UNREADABLE"
  | "VERSION-ABOVE-CEILING"
  | "KNOWN-BREAK"
  | "FEATURE-FLOOR"
  | "NO-LOGIN"
  | "LOGIN-EXPIRED"
  | "LOGIN-UNKNOWN"
  | "QUOTA-LOW"
  | "QUOTA-UNREADABLE"
  | "SANDBOX-TOO-OLD"
  | "SANDBOX-MISSING"
  | "OVERRIDE-INVALID"
  | "USAGEMUX-STALE"
  | "USAGEMUX-MISSING"
  | "USAGEMUX-UNREADABLE"
  | "PROBE-FAILED";

export type RowSeverity = "ok" | "info" | "warn" | "broken";

export interface MachineCheckFlags {
  spend?: boolean;
  spendCap?: number;
  spendUnreadable?: boolean;
  only?: readonly string[];
  skip?: readonly string[];
  /** The per-probe bound, in seconds, for one version verdict. */
  timeoutSeconds?: number;
  strict?: boolean;
}

export interface HarnessRow {
  id: AgentId;
  installed: boolean;
  state: MachineCheckState;
  severity: RowSeverity;
  checks: {
    version: string | null;
    contract: string;
    floors: string;
    login: string;
    usage: string;
    sandbox: string;
    override: string | null;
  };
  remedy: string | null;
  /** Extra lines (configuration issues, gate warnings, probe stderr). */
  detail: string[];
  /** Which unmet feature floor produced FEATURE-FLOOR, for the remedy. */
  featureFloor: { feature: FeatureFloorKind; floor: string } | null;
  /** The gate's dry verdict over the usage row ("not-run" without one). */
  usageVerdict: "proceed" | "warn" | "refuse" | "disabled" | "not-run";
  /** A usage row was fetched and parsed. */
  usageReadable: boolean;
  /** A complete, adapter-accepted provider override: the native login and
   * usage columns are not this row's concern (review round 51). */
  overrideActive: boolean;
  /** A short hash prefix of the usagemux-reported account, `--format
   * json` only, so an operator with two accounts can tell them apart
   * without either being printable. Null when no account was reported. */
  accountFingerprint: string | null;
  /** Whether usagemux reported an account at all (human output prints
   * only this fact). */
  accountPresent: boolean;
  /** The spend probe's outcome, when stage 4 ran one. */
  spend: { ok: boolean; detail: string } | null;
}

export interface EnvironmentRow {
  state: string;
  severity: RowSeverity;
  detail: string;
  remedy: string | null;
}

export interface MachineCheckReport {
  schema: "codemux-doctor-1";
  codemux: { version: string };
  environment: Record<string, EnvironmentRow>;
  harnesses: HarnessRow[];
  summary: { ok: number; warn: number; broken: number; notInstalled: number };
  /** 0: every installed harness ok or warn. 1: any broken (any warn with
   * --strict). 2: the check itself could not run (config error). */
  exitCode: number;
}

/** Per-client usage timeouts (audit D6): claude's CodexBar answers in
 * about 31 s here, agy's probe is the slowest usagemux has, the rest
 * answer well inside 30 s. The machine check includes agy (audit D12);
 * `codemux usage` keeps excluding it by default. */
export const USAGE_CLIENT_TIMEOUT_SECONDS: Readonly<Partial<Record<AgentId, number>>> = {
  claude: 60,
  agy: 90,
};

export const usageClientTimeoutSeconds = (agent: AgentId): number =>
  USAGE_CLIENT_TIMEOUT_SECONDS[agent] ?? 30;

/** Validates `--only`/`--skip` and returns the selected agent ids in
 * adapter order. Throws a UsageRefusalError naming the valid ids. */
export function validateAgentFilter(
  only?: readonly string[],
  skip?: readonly string[]
): readonly AgentId[] {
  const parse = (values: readonly string[] | undefined): AgentId[] => {
    if (values === undefined) return [];
    const ids: AgentId[] = [];
    for (const value of values.flatMap((entry) => entry.split(","))) {
      const name = value.trim();
      // An empty entry (`--only ,`) is a malformed filter: with --spend it
      // would select every harness and pay for each (review round 50).
      if (name === "") throw new UsageRefusalError("--only and --skip take comma-separated agent names; an entry is empty");
      if (!AGENT_IDS.includes(name as AgentId)) {
        throw new UsageRefusalError(
          `Unknown agent '${name}'\nAvailable agents: ${AGENT_IDS.join(", ")}`
        );
      }
      ids.push(name as AgentId);
    }
    return ids;
  };
  const onlyIds = parse(only);
  const skipIds = parse(skip);
  const both = onlyIds.filter((id) => skipIds.includes(id));
  if (both.length > 0) {
    throw new UsageRefusalError(`--only and --skip both name ${both.join(", ")}`);
  }
  if (onlyIds.length > 0) return onlyIds;
  if (skipIds.length > 0) return AGENT_IDS.filter((id) => !skipIds.includes(id));
  return AGENT_IDS;
}

/** The row a harness with no installed binary gets: informational, never
 * an exit-code failure (an absent optional harness is a healthy machine). */
export const notInstalledRow = (adapter: BaseAdapter): HarnessRow => ({
  id: adapter.id,
  installed: false,
  state: "NOT-INSTALLED",
  severity: "info",
  checks: {
    version: null,
    contract: "-",
    floors: "-",
    login: "-",
    usage: "-",
    sandbox: "-",
    override: null,
  },
  remedy: remedyFor(adapter.id, "NOT-INSTALLED"),
  detail: [],
  featureFloor: null,
  usageVerdict: "not-run",
  usageReadable: false,
  overrideActive: false,
  accountFingerprint: null,
  accountPresent: false,
  spend: null,
});
