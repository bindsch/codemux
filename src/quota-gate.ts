/**
 * The pre-spend quota gate: one check, the same rule for every agent,
 * run by `run`, `check`, `tui`, and `session` after request validation
 * and before any harness spawn. It asks usagemux about the ONE agent the
 * launch will spend from and refuses (exit 64, a UsageRefusalError) when
 * a bounding usage window is below the configured ceiling. The launch
 * form (`assertQuotaHeadroomForLaunch`) first checks whether a provider
 * override moves that spend elsewhere; see its comment.
 *
 * Fail-open by design for an unreadable snapshot (a timeout, malformed
 * output, a stale reading): an interactive launch must not hang or die on
 * a slow provider query. A gate whose own settings are invalid (a
 * non-integer timeout) refuses instead — a misconfigured gate must not
 * spend. usagemux status `error`/`unavailable`, and an `ok` with no
 * bounding window, warn and proceed the same way: the provider's own
 * remedy text is printed, and only a readable window below the ceiling
 * refuses. Batch callers get the
 * strict fail-closed behavior from cmx (codemux-workflows), which keeps
 * its own policy; this gate never spends on a refused launch, and the
 * ledger records nothing for one (nothing ran). See
 * docs/quota.md#quota-gate for the decision table.
 */

import { readProviderOverride } from "./provider-override.js";
import type { AgentId, QuotaPolicy } from "./types.js";
import { escapeForTerminal, formatResetTime } from "./usage-protocol.js";
import type { UsageSnapshot, UsageWindow } from "./usage-protocol.js";
import { fetchUsageSnapshot, formatUsagePercent, getUsagemuxStatus, UsageQueryError } from "./usage.js";
import { UsageRefusalError } from "./validation.js";
import { timestampMs } from "./calendar.js";

/** A fetched snapshot is reused inside this window, so a batch or a
 * resumed session does not pay the usagemux query per call. */
export const QUOTA_GATE_CACHE_TTL_MS = 60_000;
/** A snapshot older than this is treated as unreadable: the gate warns and
 * proceeds rather than refuse a launch on numbers that predate it. */
const STALE_SNAPSHOT_MS = 10 * 60_000;
/** A snapshot dated more than this far in the FUTURE is unreadable the
 * same way: usagemux stamps the operator's own host clock, so a future
 * date means a skewed or lying clock, and a negative age must not pass
 * the staleness check as fresh (review round 15, edges 5). */
const FUTURE_SNAPSHOT_TOLERANCE_MS = 60_000;
// Windows whose kind matches this do not bound model calls (per-window
// MCP budgets); they never gate or warn. Whole words only: "unscoped" is
// a binding kind and must not match (review round 7, edges). `scoped`
// windows are pools like any other (Claude's Fable allowance,
// `claude-weekly-scoped-fable`, is a real budget): they warn below the
// ceiling (audit round 2, B7).
const NON_BINDING_WINDOW_KIND = /\bmcp\b/i;
const WEEKLY_WINDOW_MINUTES = 10_080;
// A provider reporting a week may round or drift (a 10_079-minute window
// is still a week), so the weekly floor carries an hour of tolerance
// (review round 14, edges 8).
const WEEKLY_WINDOW_TOLERANCE_MINUTES = 60;

interface CacheEntry {
  snapshot: UsageSnapshot;
  fetchedAt: number;
}

/** The cache key: the agent plus a digest of the COMPLETE environment the
 * query receives. usagemux resolves its account from more than PATH (HOME
 * and credential variables among them), so keying on PATH alone let two
 * accounts in one process reuse each other's snapshot; any environment
 * difference is a new query now (review round 11 edges 6; round 12,
 * contracts-2 1). */
const snapshotCacheKey = (
  client: string,
  environment: Record<string, string>
): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const key of Object.keys(environment).sort()) {
    hasher.update(`${key}\0${environment[key] ?? ""}\0`);
  }
  return `${client}\0${hasher.digest("hex")}`;
};

const snapshotCache = new Map<string, CacheEntry>();
// The absent/untrusted warning prints once per process; repeating it on
// every launch in a batch says the same thing to the same operator.
let warnedIntegrationAbsent = false;

const warn = (reason: string): void => {
  console.error(`Warning: quota gate skipped: ${reason}`);
};

const warnOnce = (reason: string): void => {
  if (warnedIntegrationAbsent) return;
  warnedIntegrationAbsent = true;
  warn(reason);
};

// The in-process TEST hermeticity seam's answer: the variable counts only
// when its value is the nonce the test preload generated and mirrored on
// globalThis (tests/setup.ts). A variable without the marker — exported
// by an operator, or a leaked copy in another process — disables nothing
// (round 20, minor 15).
const testNoQuotaGate = (environment: Record<string, string>): boolean => {
  const nonce = (globalThis as { __codemuxTestNoQuotaGate?: unknown })
    .__codemuxTestNoQuotaGate;
  return typeof nonce === "string" && environment.CODEMUX_TEST_NO_QUOTA_GATE === nonce;
};

// Weekly means a span of one week within an hour of provider rounding, or
// a kind that names a week. A longer span (a monthly cap) is not weekly:
// the weekly warning is about the weekly budget only (review round 14,
// contracts 5). The kind test is word-bounded: "biweekly" and "weekday"
// name other cadences (round 20, minor 12). Exported for the doctor row's
// usage summary, which renders its "week N% used" line with this same
// predicate (round 381: a weekly-by-span pool such as cursor-grok-bot
// never matched the name test alone).
export const isWeekly = (window: UsageWindow): boolean =>
  (window.windowMinutes === null || window.windowMinutes <= WEEKLY_WINDOW_MINUTES + WEEKLY_WINDOW_TOLERANCE_MINUTES) &&
  ((window.windowMinutes !== null &&
    Math.abs(window.windowMinutes - WEEKLY_WINDOW_MINUTES) <= WEEKLY_WINDOW_TOLERANCE_MINUTES) ||
  /\bweek(ly)?\b/i.test(window.kind));

// Weekly by span alone, without reading the name: the refusal rule trusts
// the measurement, not the provider's wording. agy's weekly pool is
// kind-named (`antigravity-quota-summary-3p-weekly`) and cursor's Grok
// pool is `cursor-grok-bot`; neither is `secondary`, so neither refuses a
// launch on its own (audit round 2, B1).
const weeklyBySpan = (window: UsageWindow): boolean =>
  window.windowMinutes !== null &&
  Math.abs(window.windowMinutes - WEEKLY_WINDOW_MINUTES) <= WEEKLY_WINDOW_TOLERANCE_MINUTES;

/** The usagemux timeout for one agent: the policy's number, or the
 * agent's map entry with `default` filling the unnamed agents (config
 * validation requires `default`, so the fallback always resolves). */
export const quotaTimeoutSecondsFor = (
  policy: QuotaPolicy,
  agent: AgentId
): number => {
  if (typeof policy.timeoutSeconds === "number") return policy.timeoutSeconds;
  return policy.timeoutSeconds[agent] ?? policy.timeoutSeconds.default!;
};

/** `--quota-ceiling <percent>`: a number from 0 to 100, else a usage
 * refusal (exit 64) like every other option validator. The empty string
 * is refused explicitly: `Number("")` is 0, which is in range. */
export const parseQuotaCeilingOption = (value: string): number => {
  const percent = Number(value);
  if (
    value.trim() === "" ||
    !Number.isFinite(percent) ||
    percent < 0 ||
    percent > 100
  ) {
    throw new UsageRefusalError(
      "--quota-ceiling must be a number from 0 to 100"
    );
  }
  return percent;
};

export interface QuotaGateRequest {
  config: QuotaPolicy | false;
  /** The raw `--quota-ceiling` value, when the flag was given. */
  ceiling?: string;
  /** `--no-quota-gate`. */
  disabled?: boolean;
}

/** The effective policy for one invocation: null means the gate is off
 * (disabled by flag or by `quota: false`); a ceiling flag overrides
 * minRemainingPercent only. A ceiling value is validated whenever it is
 * given, even under a disabled gate — a bad option value is the caller's
 * mistake whatever the switch says — and a valid one under a disabled
 * gate is ignored with one stderr note saying it has no effect (review
 * round 11, contracts 3). Throws the option's UsageRefusalError on a bad
 * ceiling value. */
export const resolveQuotaGate = (request: QuotaGateRequest): QuotaPolicy | null => {
  if (request.ceiling !== undefined) {
    const minRemainingPercent = parseQuotaCeilingOption(request.ceiling);
    if (request.disabled || request.config === false) {
      console.error("Warning: --quota-ceiling has no effect: the quota gate is disabled");
      return null;
    }
    return { ...request.config, minRemainingPercent };
  }
  if (request.disabled || request.config === false) return null;
  return { ...request.config };
};

/** Test seam: the cache and the once-flag are process state. */
export const resetQuotaGateState = (): void => {
  snapshotCache.clear();
  warnedIntegrationAbsent = false;
};

/** What one usagemux result decides: the refusal message when a bounding
 * window is below the ceiling (null otherwise), and the warning lines in
 * the order the gate prints them — the notes that preceded the refusal
 * print before it throws. Pure: nothing prints and nothing throws here, so
 * a caller that decides without printing (the live gate's per-harness
 * pre-spawn decisions, scripts/live-gate/quota.ts) applies the exact rule
 * a launch applies. The message strings are the gate's stderr contract
 * (pinned by tests/quota-gate-usagemux.test.ts). */
export interface QuotaGateOutcome {
  refusal: string | null;
  notes: readonly string[];
}

/** The pure decision behind gateOnResult. Exported for the live gate and
 * tests. */
export const gateOutcomeOnResult = (
  agent: AgentId,
  result: UsageSnapshot["results"][number],
  policy: QuotaPolicy
): QuotaGateOutcome => {
  const client = policy.spendsFrom?.[agent] ?? agent;
  const label = client === agent ? agent : `${agent} (usagemux client ${escapeForTerminal(client)})`;
  const notes: string[] = [];
  if (result.status === "not-applicable") {
    // Silent here meant "the gate is off for this harness," which is not
    // what not-applicable says: usagemux has no client for the account the
    // run spends from, so the launch proceeds unmeasured. One line, once
    // per launch, names that (audit round 2, B4).
    return {
      refusal: null,
      notes: [
        `quota gate: ${label}: usage not measured; spends from its configured provider`,
      ],
    };
  }
  if (result.status === "error" || result.status === "unavailable") {
    // An unreadable provider is not an exhausted one: the gate refuses on
    // evidence of spent quota, and an error carries none. The live gate of
    // 2026-11-02 showed what a refusal here does: a usage backend that took
    // 30 s to answer for claude, and an opencode whose usage needs browser
    // cookies the machine does not have, blocked every launch of both
    // harnesses. The provider's own remedy text is still printed.
    return {
      refusal: null,
      notes: [
        `Warning: quota gate: ${label}: usage unreadable (${escapeForTerminal(result.message ?? result.status)}); proceeding`,
      ],
    };
  }
  const binding = result.windows.filter(
    (window) =>
      !NON_BINDING_WINDOW_KIND.test(window.kind) &&
      typeof window.remainingPercent === "number"
  );
  // The weekly warning runs over every binding-kind window with a used
  // percent, not over the ceiling's remaining-percent set: a weekly window
  // may report only usedPercent, and docs promise the warning above the
  // weekly used threshold for exactly that shape (review round 9, edges
  // finding 2). That shape also empties the binding set, whose early
  // return below once skipped this loop — a weekly window reporting only
  // usedPercent gets this warning before the no-binding note (round 23,
  // edges 8).
  const weeklyOverUseNotes = (): string[] => {
    const warnings: string[] = [];
    for (const window of result.windows) {
      if (NON_BINDING_WINDOW_KIND.test(window.kind)) continue;
      if (!isWeekly(window) || typeof window.usedPercent !== "number") continue;
      if (window.usedPercent > policy.weeklyWarnUsedPercent) {
        warnings.push(
          `Warning: quota gate: ${label} ${escapeForTerminal(window.kind)} window is ${formatUsagePercent(window.usedPercent)}% used ` +
            `(above ${formatUsagePercent(policy.weeklyWarnUsedPercent)}%); proceeding`
        );
      }
    }
    return warnings;
  };
  // Credits are a prepaid meter the windows do not carry (codex reports
  // them beside its weekly window): zero means every API-key call fails,
  // so it warns before any window logic can return early (audit round 2,
  // B10). The remaining value prints as reported (review round 391, item
  // 11): the parser accepts any finite number, and an overdrawn account
  // answers -2.5, not a hardcoded 0.
  if (result.credits !== null && result.credits.remaining <= 0) {
    notes.push(
      `Warning: quota gate: ${label}: credits exhausted (${escapeForTerminal(String(result.credits.remaining))} ${escapeForTerminal(result.credits.unit)} left); proceeding`
    );
  }
  if (binding.length === 0) {
    // The same rule: a snapshot with no bounding window reports nothing
    // about spend, so it cannot justify a refusal. What it did report —
    // the weekly used percent — still warns.
    notes.push(...weeklyOverUseNotes());
    notes.push(
      `Warning: quota gate: ${label}: no window that bounds model calls reports a remaining percent; proceeding`
    );
    return { refusal: null, notes };
  }
  for (const window of binding) {
    if (window.remainingPercent! >= policy.minRemainingPercent) continue;
    const reset = formatResetTime(window.resetsAt) ?? "unknown";
    const shortfall =
      `${escapeForTerminal(window.kind)} window has ${formatUsagePercent(window.remainingPercent!)}% left` +
      ` (resets ${reset}), below the ${formatUsagePercent(policy.minRemainingPercent)}% ceiling`;
    // The refusal set is the provider's primary window and a weekly span
    // on a named tier (secondary, tertiary); everything else is a pool a
    // single launch may never touch, and warns instead (audit round 2,
    // B1: a kind merely containing "weekly" — agy's
    // antigravity-quota-summary-3p-weekly, cursor's cursor-grok-bot
    // weekly span — used to refuse while the same pool named "-5h" only
    // warned).
    const bindingTier =
      window.kind === "secondary" || window.kind === "tertiary";
    if (window.kind === "primary" || (bindingTier && weeklyBySpan(window))) {
      return { refusal: `quota gate: ${label}: ${shortfall}`, notes };
    }
    // A pool that is neither the provider's primary window nor a weekly
    // tier does not bound every call: usagemux's third window for cursor
    // is the third-party model pool and for gemini the Flash Lite tier,
    // and a launch that never touches that pool is not blocked by its
    // exhaustion (live gate of 2026-11-02: cursor refused on an empty
    // third-party pool while its plan had 42% left). It warns instead.
    notes.push(`Warning: quota gate: ${label}: ${shortfall}; proceeding (not the primary window)`);
  }
  notes.push(...weeklyOverUseNotes());
  return { refusal: null, notes };
};

/** Decides one usagemux result per the table above. Exported for tests. */
export const gateOnResult = (
  agent: AgentId,
  result: UsageSnapshot["results"][number],
  policy: QuotaPolicy
): void => {
  const { refusal, notes } = gateOutcomeOnResult(agent, result, policy);
  for (const note of notes) console.error(note);
  if (refusal !== null) throw new UsageRefusalError(refusal);
};

/** Why a snapshot is unreadable by age, or null when it is current: the
 * gate warns and proceeds on it, and the machine check reports the same
 * (review round 54). generatedAt is usagemux's own string and is escaped. */
export const snapshotFreshnessIssue = (snapshot: { generatedAt: string }): string | null => {
  const generatedAt = timestampMs(snapshot.generatedAt);
  const age = Date.now() - generatedAt;
  if (!Number.isFinite(generatedAt) || age > STALE_SNAPSHOT_MS) {
    return `usagemux snapshot is stale (generated at ${escapeForTerminal(snapshot.generatedAt)})`;
  }
  if (age < -FUTURE_SNAPSHOT_TOLERANCE_MS) {
    return (
      `usagemux snapshot is dated in the future (generated at ${escapeForTerminal(snapshot.generatedAt)}); ` +
      "the host clock and the snapshot disagree, so it is treated as unreadable"
    );
  }
  return null;
};

/** The gate every launch command calls. Never rejects with anything but a
 * UsageRefusalError (exit 64); every unreadable-snapshot path warns on
 * stderr and returns so the launch proceeds. */
export const assertQuotaHeadroom = async (
  agent: AgentId,
  policy: QuotaPolicy,
  environment: Record<string, string> = process.env as Record<string, string>
): Promise<void> => {
  // The in-process TEST hermeticity seam. The name says TEST: nothing in
  // the operator environment or the docs disables the gate — the flag
  // (--no-quota-gate) and the config key (quota: false) are the only
  // switches (review round 15, minor 3). tests/setup.ts generates the
  // nonce and mirrors it on globalThis, so a test driving a launch
  // command in-process never consults the operator's real usagemux (an
  // expired credential on the host would otherwise fail the suite, and a
  // healthy one would make it pass only by the host's grace). The CLI
  // test helper strips the variable from spawned children, so a spawned
  // codemux runs the real gate against its own fake or absent usagemux.
  if (testNoQuotaGate(environment)) return;
  const workdir = process.cwd();
  const status = getUsagemuxStatus(workdir, environment);
  if (!status.available) {
    warnOnce("usagemux is not installed (optional usage integration)");
    return;
  }
  if (status.issue !== null) {
    warnOnce(`usagemux is unavailable: ${status.issue}`);
    return;
  }
  // A harness that spends from another provider's account (opencode on a
  // Claude subscription) is gated on THAT client's windows: its own
  // client measures a different spend, or nothing (audit round 2, B4).
  // Messages still name the harness; the numbers come from the mapped
  // client.
  const client = policy.spendsFrom?.[agent] ?? agent;
  let snapshot: UsageSnapshot;
  const cacheKey = snapshotCacheKey(client, environment);
  const cached = snapshotCache.get(cacheKey);
  if (cached !== undefined && Date.now() - cached.fetchedAt < QUOTA_GATE_CACHE_TTL_MS) {
    snapshot = cached.snapshot;
  } else {
    try {
      // spendsFrom values are usagemux client names, which are agent ids;
      // the cast documents that the map ranges over the same vocabulary.
      snapshot = await fetchUsageSnapshot(
        [client as AgentId],
        quotaTimeoutSecondsFor(policy, agent) * 1_000,
        workdir,
        environment
      );
    } catch (error) {
      // Only the usagemux-side failures (UsageQueryError: absent or
      // untrusted binary, timeout, nonzero exit, unparseable output) warn
      // and proceed. An error from codemux's own validation — an invalid
      // timeout, an invalid argument — means the gate itself is
      // misconfigured and refuses (exit 64) instead of failing open.
      if (!(error instanceof UsageQueryError)) {
        throw new UsageRefusalError(
          `quota gate: invalid usage query settings: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      // The message may carry upstream-derived bytes (usagemux's stderr
      // detail): escaped at the source already, and again here — the
      // escape is idempotent, so the belt never mangles the suspender.
      warn(escapeForTerminal(error.message));
      return;
    }
    snapshotCache.set(cacheKey, { snapshot, fetchedAt: Date.now() });
  }
  const freshness = snapshotFreshnessIssue(snapshot);
  if (freshness !== null) {
    warn(freshness);
    return;
  }
  const result = snapshot.results.find((entry) => entry.client === client);
  if (result === undefined) {
    warn(`usagemux returned no result for ${client}`);
    return;
  }
  gateOnResult(agent, result, policy);
};

/** The launch form of the gate (`run`, `tui`, `check`, `session`): it
 * decides the gate's subject before the gate runs. A validated provider
 * override with a base URL routes every model request to the operator's
 * endpoint, so the native account the gate would measure is not the one
 * the launch spends from — the gate does not apply and prints one stderr
 * line saying so. The override is read with the adapter's own validation
 * (`readProviderOverride`), so a malformed override still refuses here
 * with the adapter's message (exit 64), never quietly ungates the launch.
 * Everything else — a harness that cannot carry an override, an override
 * with no base URL (caps or a model name alone do not move the endpoint),
 * no override at all — gates on the native account as before. */
export const assertQuotaHeadroomForLaunch = async (
  adapter: { id: AgentId; capabilities(): { supportsProviderOverride?: boolean } },
  policy: QuotaPolicy,
  environment: Record<string, string> = process.env as Record<string, string>
): Promise<void> => {
  // The same TEST-only seam as assertQuotaHeadroom (see its comment).
  if (testNoQuotaGate(environment)) return;
  const override = readProviderOverride(adapter.id, environment as NodeJS.ProcessEnv);
  if (
    override !== null &&
    override.baseUrl !== undefined &&
    adapter.capabilities().supportsProviderOverride
  ) {
    // readProviderOverride validated an absolute http(s) URL, so the host
    // parse cannot throw here.
    console.error(
      `quota gate: skipped, ${adapter.id} runs through the provider override at ${new URL(override.baseUrl).host}`
    );
    return;
  }
  await assertQuotaHeadroom(adapter.id, policy, environment);
};
