/**
 * Stage 3 of the machine check: one row per harness. Every check a row
 * names — trust, version contract, feature floors, scode floor, provider
 * override, login state, usage window — is free, and every credential
 * read is existence, mode, or expiry: a value, token, or account name
 * never enters a row. The state is the first broken candidate, else the
 * first warn candidate, else OK.
 */

import { quotaTimeoutSecondsFor, snapshotFreshnessIssue } from "./quota-gate.js";
import type { BaseAdapter } from "./adapters/base.js";
import { isVersionAtLeast, parseVersion } from "./cli-runtime.js";
import { compareVersions } from "./harness-compatibility.js";
import {
  FEATURE_FLOORS,
  HARNESS_CONTRACTS,
  SCODE_FLOORS,
  type FeatureFloorKind,
} from "./harness-contracts.js";
import {
  dryGateOnResult,
  loginFingerprint,
  probeVersionVerdict,
  type LoginState,
  type VersionVerdict,
} from "./harness-health.js";
import { providerOverrideEnvNames, readProviderOverride } from "./provider-override.js";
import { remedyFor } from "./doctor-remedies.js";
import {
  notInstalledRow,
  usageClientTimeoutSeconds,
  type HarnessRow,
  type MachineCheckState,
  type RowSeverity,
} from "./doctor-model.js";
import type { ScodeFacts } from "./doctor-environment.js";
import { fetchUsageSnapshot, USAGEMUX_SHUTDOWN_GRACE_MS } from "./usage.js";
import { escapeForTerminal, formatUsagePercent } from "./usage-protocol.js";
import type { AgentId, QuotaPolicy } from "./types.js";

interface HarnessCheckContext {
  versionTimeoutMs: number;
  scode: ScodeFacts;
  usagePolicy: QuotaPolicy | null;
  usagemuxPresent: boolean;
}

const loginLine = (login: LoginState): string => {
  const parts: string[] = [login.state];
  if (login.store !== undefined) parts.push(`(${login.store})`);
  if (login.refreshPresent === true) parts.push("refresh token present");
  return parts.join(" ");
};

const floorLines = (
  agent: AgentId,
  version: string | null
): { line: string; unmet: { feature: FeatureFloorKind; floor: string } | null } => {
  const floors = FEATURE_FLOORS[agent];
  if (floors === undefined) return { line: "none recorded", unmet: null };
  const parts: string[] = [];
  let unmet: { feature: FeatureFloorKind; floor: string } | null = null;
  for (const [feature, floor] of Object.entries(floors) as [FeatureFloorKind, string][]) {
    if (version === null) {
      parts.push(`${feature}: unknown (version unreadable)`);
      continue;
    }
    let below: boolean;
    try {
      below = compareVersions(version, floor) < 0;
    } catch {
      parts.push(`${feature}: unknown (version '${version}' does not compare)`);
      continue;
    }
    if (below) {
      parts.push(`${feature}: refused (needs ${floor}, installed ${version})`);
      unmet ??= { feature, floor };
    } else {
      parts.push(`${feature}: ok (installed ${version})`);
    }
  }
  return { line: parts.join("; "), unmet };
};

const sandboxLine = (agent: AgentId, scode: ScodeFacts): { line: string; state: MachineCheckState | null; floor: string | null } => {
  const floor = SCODE_FLOORS[agent];
  if (!scode.present) {
    return { line: `scode missing${floor !== undefined ? ` (this harness needs >= ${floor})` : ""}`, state: "SANDBOX-MISSING", floor: null };
  }
  if (scode.version === null) {
    return { line: `scode ${scode.label}${floor !== undefined ? ` (needs >= ${floor}; version unreadable)` : ""}`, state: "SANDBOX-TOO-OLD", floor: floor ?? null };
  }
  const minimum = floor !== undefined ? parseVersion(floor) : null;
  if (minimum !== null && !isVersionAtLeast(scode.version, minimum)) {
    return { line: `scode ${scode.label} below the ${agent} floor ${floor}`, state: "SANDBOX-TOO-OLD", floor: floor ?? null };
  }
  return { line: `scode ${scode.label}`, state: null, floor: null };
};

const overrideLine = (adapter: BaseAdapter): { line: string | null; invalid: string | null } => {
  const agent = adapter.id;
  try {
    const override = readProviderOverride(agent);
    if (override === null) return { line: null, invalid: null };
    // The completeness rule a launch applies (requireProviderOverride over
    // the three fields every provider needs), so the row says what a
    // launch would do instead of waiting for the launch to refuse.
    const missing = (["baseUrl", "apiKey", "model"] as const)
      .filter((field) => override[field] === undefined)
      .map((field) => providerOverrideEnvNames(agent)[field]);
    if (missing.length > 0) {
      return {
        line: "present (incomplete)",
        invalid: `provider override is missing ${missing.join(", ")}`,
      };
    }
    const fields = (["baseUrl", "apiKey", "model", "maxOutputTokens", "maxContextTokens"] as const)
      .filter((field) => override[field] !== undefined);
    // The adapter's own rule (a token cap it cannot carry, an unsupported
    // override): what the launch would refuse, the row refuses (review 45).
    const issue = adapter.providerOverrideIssue();
    if (issue !== null) return { line: `present (${fields.join(", ")}; refused)`, invalid: issue };
    // Field names only: a value never enters a row.
    return { line: `present (${fields.join(", ")})`, invalid: null };
  } catch (error) {
    return { line: "invalid", invalid: error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error) };
  }
};

interface UsageOutcome {
  line: string;
  verdict: HarnessRow["usageVerdict"];
  readable: boolean;
  detail: string[];
  accountFingerprint: string | null;
  accountPresent: boolean;
}

const notRunUsage = (reason: string): UsageOutcome => ({
  line: `unreadable (${reason})`,
  // Unreadable is the warn class (audit D6): an unreadable provider is not
  // an exhausted one, and the row says why rather than refusing.
  verdict: "warn",
  readable: false,
  detail: [reason],
  accountFingerprint: null,
  accountPresent: false,
});

type UsageSnapshotResult = Awaited<ReturnType<typeof fetchUsageSnapshot>>["results"][number];

const windowLine = (result: UsageSnapshotResult): string => {
  const primary = result.windows.find((window) => window.kind === "primary");
  const weekly = result.windows.find((window) => /week/i.test(window.kind));
  const parts: string[] = [];
  if (primary !== undefined) {
    const remaining =
      typeof primary.remainingPercent === "number"
        ? `${formatUsagePercent(primary.remainingPercent)}% left`
        : "remaining unknown";
    parts.push(`primary ${remaining} (resets ${primary.resetsAt ?? "unknown"})`);
  }
  if (weekly !== undefined) {
    const used =
      typeof weekly.usedPercent === "number"
        ? `${formatUsagePercent(weekly.usedPercent)}% used`
        : typeof weekly.remainingPercent === "number"
          ? `${formatUsagePercent(weekly.remainingPercent)}% left`
          : "unknown";
    parts.push(`week ${used}`);
  }
  return parts.length > 0 ? parts.join("; ") : "no window reported";
};

const usageOutcome = async (
  agent: AgentId,
  policy: QuotaPolicy | null,
  usagemuxPresent: boolean
): Promise<UsageOutcome> => {
  if (!usagemuxPresent) return notRunUsage("usagemux is not installed");
  // The account a launch spends from (quota.spendsFrom), not the harness
  // id, when the operator mapped one (review round 39): the row then says
  // whose window it reads.
  const client = (policy?.spendsFrom?.[agent] ?? agent) as AgentId;
  const prefix = client === agent ? "" : `spends from ${client}: `;
  // The query waits the longer of the gate's configured budget and the
  // client's known answer time, so the numbers are read; the verdict then
  // says what a launch would do: an answer that arrived after the
  // configured budget is a timeout at launch, so the gate warns and
  // proceeds ungated (review round 44), never QUOTA-LOW.
  // The budget is the launching agent's entry (quotaTimeoutSecondsFor at
  // launch keys on the agent, not the mapped client; review round 45).
  const configuredSeconds = policy === null ? null : quotaTimeoutSecondsFor(policy, agent);
  // A launch accepts an answer that lands inside its shutdown grace after
  // the policy timeout (src/usage.ts), so the row's budget is the same sum
  // (review round 54).
  const launchBudgetSeconds = configuredSeconds === null ? null : configuredSeconds + USAGEMUX_SHUTDOWN_GRACE_MS / 1_000;
  const budgetSeconds = Math.max(launchBudgetSeconds ?? 0, usageClientTimeoutSeconds(client));
  const startedAt = Date.now();
  try {
    const snapshot = await fetchUsageSnapshot([client], budgetSeconds * 1_000);
    const elapsed = (Date.now() - startedAt) / 1_000;
    const seconds = elapsed.toFixed(1);
    if (configuredSeconds !== null && launchBudgetSeconds !== null && elapsed > launchBudgetSeconds) {
      // The entry a launch reads is the launching agent's (review round 52).
      const remedy = `raise quota.timeoutSeconds for ${agent} above ${Math.ceil(elapsed)} s in the configuration`;
      return {
        line: `${prefix}read in ${seconds} s, past the gate's ${configuredSeconds} s budget (plus its ${USAGEMUX_SHUTDOWN_GRACE_MS / 1_000} s grace): a launch proceeds ungated [${seconds} s]`,
        verdict: "warn",
        readable: false,
        detail: [remedy],
        accountFingerprint: null,
        accountPresent: false,
      };
    }
    // The launch gate treats a stale or future-dated snapshot as unreadable
    // and proceeds; so does this row (review round 54).
    const freshness = snapshotFreshnessIssue(snapshot);
    if (freshness !== null) {
      return { line: `${prefix}unreadable (${freshness}) [${seconds} s]`, verdict: "warn", readable: false, detail: [freshness], accountFingerprint: null, accountPresent: false };
    }
    const result = snapshot.results.find((entry) => entry.client === client);
    if (result === undefined) return notRunUsage("usagemux omitted the client");
    if (result.status === "error" || result.status === "unavailable") {
      // usagemux owns provider remedies: its message is printed verbatim.
      const message = escapeForTerminal(result.message ?? result.status);
      return {
        line: `${prefix}unreadable (${message}) [${seconds} s]`,
        verdict: "warn",
        readable: false,
        detail: [message],
        accountFingerprint: null,
        accountPresent: false,
      };
    }
    if (result.status === "not-applicable") {
      return {
        line: `${prefix}not applicable [${seconds} s]`,
        verdict: "proceed",
        readable: true,
        detail: [],
        accountFingerprint: null,
        accountPresent: false,
      };
    }
    if (policy === null) {
      return {
        line: `${prefix}${windowLine(result)}; gate: disabled [${seconds} s]`,
        verdict: "disabled",
        readable: true,
        detail: [],
        accountFingerprint:
          result.account !== null && result.account !== "" ? loginFingerprint(result.account) : null,
        accountPresent: result.account !== null && result.account !== "",
      };
    }
    const gate = dryGateOnResult(agent, result, policy);
    return {
      line: `${prefix}${windowLine(result)}; gate: ${gate.action} [${seconds} s]`,
      verdict: gate.action,
      readable: true,
      detail: gate.lines,
      accountFingerprint:
        result.account !== null && result.account !== "" ? loginFingerprint(result.account) : null,
      accountPresent: result.account !== null && result.account !== "",
    };
  } catch (error) {
    return notRunUsage(error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error));
  }
};

const brokenStates: readonly MachineCheckState[] = [
  "UNTRUSTED",
  "VERSION-BELOW-MIN",
  "FEATURE-FLOOR",
  "SANDBOX-MISSING",
  "SANDBOX-TOO-OLD",
  "OVERRIDE-INVALID",
  "NO-LOGIN",
  "LOGIN-EXPIRED",
  "QUOTA-LOW",
  "PROBE-FAILED",
];

const warnStates: readonly MachineCheckState[] = [
  "VERSION-UNREADABLE",
  "VERSION-ABOVE-CEILING",
  "KNOWN-BREAK",
  "LOGIN-UNKNOWN",
  "QUOTA-UNREADABLE",
];

export async function checkHarness(
  adapter: BaseAdapter,
  context: HarnessCheckContext
): Promise<HarnessRow> {
  if (!adapter.isAvailable()) return notInstalledRow(adapter);
  const detail: string[] = [];
  for (const issue of adapter.configurationIssues()) detail.push(issue);
  const verdict: VersionVerdict = await probeVersionVerdict(adapter.id, adapter.binaryName, {
    timeoutMs: context.versionTimeoutMs,
  });
  const floors = floorLines(adapter.id, verdict.version);
  const sandbox = sandboxLine(adapter.id, context.scode);
  const override = overrideLine(adapter);
  const login = adapter.loginState();
  const usage = await usageOutcome(adapter.id, context.usagePolicy, context.usagemuxPresent);
  if (login.note !== undefined) detail.push(login.note);
  detail.push(...usage.detail);
  if (override.invalid !== null) detail.push(override.invalid);

  const candidates: MachineCheckState[] = [];
  if (verdict.kind === "untrusted") candidates.push("UNTRUSTED");
  if (verdict.kind === "below-min") candidates.push("VERSION-BELOW-MIN");
  if (verdict.kind === "above-ceiling") candidates.push("VERSION-ABOVE-CEILING");
  if (verdict.kind === "unreadable") {
    // The launch gate's own split (assertSupportedHarnessVersion): a
    // contract that pins `unknownVersion: "refuse"` reads an unreadable
    // version as a below-floor release, and so does this row; every other
    // harness warns that the contract is unconfirmed and continues.
    candidates.push(
      HARNESS_CONTRACTS[adapter.id]?.unknownVersion === "refuse"
        ? "VERSION-BELOW-MIN"
        : "VERSION-UNREADABLE"
    );
  }
  // Audit D15: a break scode mitigates is a warning on a machine with
  // scode; without scode it is the break it always was.
  const mitigated = verdict.breakage?.mitigatedBySandbox === true && context.scode.present;
  if (verdict.kind === "known-break") {
    candidates.push("KNOWN-BREAK");
    if (mitigated) detail.push("mitigated by the sandbox");
  }
  if (floors.unmet !== null) candidates.push("FEATURE-FLOOR");
  if (sandbox.state !== null) candidates.push(sandbox.state);
  if (override.invalid !== null) candidates.push("OVERRIDE-INVALID");
  // A complete provider override authenticates with its own key and skips
  // the native quota gate, so the native login is not a candidate (review
  // round 39); the detail says so.
  // An override counts as active only when a launch would accept it: the
  // adapter's own validator ran in overrideLine (an unsupported override or
  // a cap the adapter cannot carry is OVERRIDE-INVALID above; rounds 43, 45).
  const overrideActive = override.line !== null && override.invalid === null;
  // Informational, not a warning: it must not change the row's severity
  // (review round 46: `--strict` failed on a valid override).
  if (overrideActive) detail.push("provider override set; the native login and the native usage window are not used");
  if (!overrideActive && login.state === "no-credential") candidates.push("NO-LOGIN");
  if (!overrideActive && login.state === "expired") candidates.push("LOGIN-EXPIRED");
  if (!overrideActive && login.state === "unknown") candidates.push("LOGIN-UNKNOWN");
  // The native usage window gates native launches only: an override routes
  // requests to its own provider and the launch skips the native gate.
  if (!overrideActive && usage.verdict === "refuse") candidates.push("QUOTA-LOW");
  if (!overrideActive && usage.verdict === "warn" && !usage.readable) candidates.push("QUOTA-UNREADABLE");
  // The default spelling of the contract column.
  const contractLabel = verdict.kind === "no-contract" ? "no contract" : verdict.label;

  const broken =
    candidates.find((state) => brokenStates.includes(state)) ??
    (candidates.includes("KNOWN-BREAK") && !mitigated ? "KNOWN-BREAK" : undefined);
  const state: MachineCheckState = broken ?? candidates.find((s) => warnStates.includes(s)) ?? "OK";
  // A configuration issue or a gate warning keeps the state OK but never
  // reports the row as fully clean; informational lines (a login note, an
  // active override) never do (review round 46: `--strict` on a valid override).
  const severity: RowSeverity =
    broken !== undefined
      ? "broken"
      : warnStates.includes(state) || (!overrideActive && usage.verdict === "warn") || adapter.configurationIssues().length > 0
        ? "warn"
        : "ok";
  const featureFloor = floors.unmet;
  const remedy =
    state === "FEATURE-FLOOR" && featureFloor !== null
      ? remedyFor(adapter.id, state, { feature: featureFloor.feature, floor: featureFloor.floor })
      : state === "SANDBOX-TOO-OLD" && sandbox.floor !== null
        ? remedyFor(adapter.id, state, { floor: sandbox.floor })
        : remedyFor(adapter.id, state);

  return {
    id: adapter.id,
    installed: true,
    state,
    severity,
    checks: {
      version: verdict.version,
      contract: contractLabel,
      floors: floors.line,
      login: loginLine(login),
      usage: usage.line,
      sandbox: sandbox.line,
      override: override.line,
    },
    remedy,
    detail,
    featureFloor,
    usageVerdict: usage.verdict,
    usageReadable: usage.readable,
    overrideActive,
    accountFingerprint: usage.accountFingerprint,
    accountPresent: usage.accountPresent,
    spend: null,
  };
}
