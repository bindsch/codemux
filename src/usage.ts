import { executableCheck, resolveTrustedExecutable } from "./executable-security.js";
import { compareVersions } from "./harness-compatibility.js";
import { OUTPUT_LIMIT_EXIT_CODE, runCapturedCommand, validateTimeout } from "./process-runner.js";
import { runOutputProbe, versionAnswer } from "./output-probe.js";
import type { AgentId } from "./types.js";
import { escapeForTerminal, parseUsageSnapshot, type UsageSnapshot } from "./usage-protocol.js";
import { UsageRefusalError } from "./validation.js";

export {
  escapeForTerminal,
  formatUsagePercent,
  formatUsageSnapshot,
  parseUsageSnapshot,
  USAGEMUX_PROTOCOL_VERSION,
} from "./usage-protocol.js";

export const USAGEMUX_UNAVAILABLE_EXIT_CODE = 69;
export const MAX_USAGE_TIMEOUT_SECONDS = 300;
/** The oldest usagemux this codemux works correctly with. The wire
 * protocol version ("1") is unchanged since 0.2.1, so protocol checks
 * alone accept a usagemux whose provider messages predate the semantics
 * codemux relies on: 1.0.0 is the release that explains kimi's aged-out
 * access token and rounds percents at emit (audit D5). Doctor reports a
 * lower version as USAGEMUX-STALE and the live gate's usage check fails
 * on it; the quota gate itself still runs — an old usagemux reads quota
 * well enough to warn with. */
export const USAGEMUX_MINIMUM_VERSION = "1.0.0";
// usagemux documents (its BACKEND.md) that discovery, environment
// preparation, spawning, and cleanup sit OUTSIDE its provider timer, and
// cleanup can wait on escaped descendants. A 2 s grace let that overhead
// fire the outer timer on a cold filesystem and turn a healthy snapshot
// into a spurious exit 124; 5 s covers it.
export const USAGEMUX_SHUTDOWN_GRACE_MS = 5_000;

export interface UsagemuxStatus {
  available: boolean;
  issue: string | null;
}

/** Every failure on the usagemux side of a query: the binary is absent or
 * untrusted, it timed out, it exited nonzero, or its output could not be
 * parsed. Callers that warn and proceed on an unreadable snapshot (the
 * quota gate) catch exactly this class; anything else — codemux's own
 * argument validation, an invalid timeout — is the caller's configuration
 * error and must not fail open. */
export class UsageQueryError extends Error {}

/** The integration itself is missing or unusable: the operator fixes both
 * the same way, by installing or repairing usagemux. */
export class UsageIntegrationUnavailableError extends UsageQueryError {}

export const parseUsageTimeoutOption = (value: string): number => {
  const seconds = Number(value);
  if (
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > MAX_USAGE_TIMEOUT_SECONDS
  ) {
    // A bad option value is a usage refusal (EX_USAGE, exit 64), the same
    // class as the CLI's other option validators.
    throw new UsageRefusalError(
      `--timeout must be a number from 0 (exclusive) to ${MAX_USAGE_TIMEOUT_SECONDS} seconds`
    );
  }
  return Math.ceil(seconds * 1_000);
};

export const getUsagemuxProcessTimeout = (providerTimeoutMs: number): number =>
  providerTimeoutMs + USAGEMUX_SHUTDOWN_GRACE_MS;

export const buildUsagemuxArguments = (
  clients: readonly AgentId[],
  timeoutMs: number
): string[] => [
  "snapshot",
  ...clients.flatMap((client) => ["--client", client]),
  "--format",
  "json",
  "--timeout",
  String(timeoutMs / 1_000),
];

const resolveUsagemux = (
  workdir: string,
  environment: Record<string, string>
): string | null => {
  const binary = Bun.which("usagemux", { PATH: environment.PATH });
  if (!binary) return null;
  return resolveTrustedExecutable(binary, "usagemux", workdir);
};

export const getUsagemuxStatus = (
  workdir = process.cwd(),
  environment = process.env as Record<string, string>
): UsagemuxStatus => {
  try {
    return { available: resolveUsagemux(workdir, environment) !== null, issue: null };
  } catch (error) {
    return {
      available: true,
      issue: error instanceof Error ? error.message : String(error),
    };
  }
};

export interface UsagemuxVersionStatus {
  /** The parsed `usagemux <version>` output, or null when the version
   * could not be read (absent binary, failed run, unparseable output). */
  version: string | null;
  /** True when the version was read and sits below
   * USAGEMUX_MINIMUM_VERSION. */
  belowMinimum: boolean;
  /** Why the version could not be read, when it could not. */
  issue: string | null;
}

/** Reads `usagemux --version` through the same trust check every
 * usagemux spawn applies, and compares the answer against
 * USAGEMUX_MINIMUM_VERSION. Deliberately NOT part of
 * getUsagemuxStatus: that check runs before every gated launch, and a
 * version spawn per launch would tax the hot path for a fact that only
 * changes on upgrade. Doctor (per run) and the live gate's usage check
 * call this instead. */
export const readUsagemuxVersion = async (
  workdir = process.cwd(),
  environment = process.env as Record<string, string>
): Promise<UsagemuxVersionStatus> => {
  let binary: string | null;
  try {
    binary = resolveUsagemux(workdir, environment);
  } catch (error) {
    return {
      version: null,
      belowMinimum: false,
      issue: error instanceof Error ? error.message : String(error),
    };
  }
  if (binary === null) {
    return { version: null, belowMinimum: false, issue: "usagemux is not installed" };
  }
  try {
    const result = await runOutputProbe([binary, "--version"], {
      cwd: workdir,
      env: environment,
      timeoutMs: 10_000,
    }, versionAnswer(/usagemux\s+(\d+\.\d+\.\d+)/));
    if (result.exitCode !== 0) {
      return { version: null, belowMinimum: false, issue: `usagemux --version exited ${result.exitCode}` };
    }
    const version = /usagemux\s+(\d+\.\d+\.\d+)/.exec(result.stdout.trim())?.[1] ?? null;
    if (version === null) {
      return { version: null, belowMinimum: false, issue: "usagemux --version printed no version" };
    }
    return {
      version,
      belowMinimum: compareVersions(version, USAGEMUX_MINIMUM_VERSION) < 0,
      issue: null,
    };
  } catch (error) {
    return { version: null, belowMinimum: false, issue: error instanceof Error ? error.message : String(error) };
  }
};

export const assertUsageSnapshotClients = (
  snapshot: UsageSnapshot,
  requestedClients: readonly AgentId[]
): void => {
  const requested = new Set<AgentId>(requestedClients);
  const returned = new Set<AgentId>();
  for (const result of snapshot.results) {
    if (!requested.has(result.client)) {
      throw new Error(`usagemux returned unrequested client '${result.client}'`);
    }
    if (returned.has(result.client)) {
      throw new Error(`usagemux returned duplicate client '${result.client}'`);
    }
    returned.add(result.client);
  }
  for (const client of requested) {
    if (!returned.has(client)) {
      throw new Error(`usagemux omitted requested client '${client}'`);
    }
  }
};

/** Run usagemux and return the parsed snapshot. Any nonzero exit, with
 * or without stdout, is a `UsageQueryError` — an unreadable query, never
 * a cached or answered one. */
export const fetchUsageSnapshot = async (
  clients: readonly AgentId[],
  timeoutMs: number,
  workdir = process.cwd(),
  environment = process.env as Record<string, string>
): Promise<UsageSnapshot> => {
  // The resolution sits inside the UsageQueryError contract too: a binary
  // absent or turned untrusted between the status check and this query is
  // an unreadable snapshot (the documented warn-and-proceed class), never
  // a plain Error the quota gate would answer with a launch refusal
  // (review round 11, edges 7).
  let binary: string | null;
  try {
    binary = resolveUsagemux(workdir, environment);
  } catch (error) {
    throw new UsageQueryError(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
  if (!binary) {
    throw new UsageIntegrationUnavailableError(
      "usagemux is not installed (optional usage integration); install it and ensure it is on PATH"
    );
  }
  // This query's own resolution, captured in the resolution's synchronous
  // block and carried to the runner's pre-spawn re-stat, so a usagemux
  // re-recorded by another launch in this process cannot satisfy it
  // (round 23, edges 1).
  const usagemuxCheck = executableCheck(binary);
  const processTimeoutMs = getUsagemuxProcessTimeout(timeoutMs);
  // Codemux's own argument validation runs BEFORE the spawn, outside the
  // usagemux-side wrapping below: an invalid timeout is the caller's
  // configuration error (a plain Error the quota gate refuses on), not an
  // unreadable snapshot a caller may warn and proceed on.
  validateTimeout(processTimeoutMs);
  let result;
  try {
    result = await runCapturedCommand(
      [binary, ...buildUsagemuxArguments(clients, timeoutMs)],
      {
        cwd: workdir,
        env: environment,
        timeoutMs: processTimeoutMs,
        requiredPaths: [binary],
        checks: usagemuxCheck === null ? undefined : [usagemuxCheck],
      }
    );
  } catch (error) {
    // The spawn itself failed (the tree could not be reaped, a capture
    // broke): usagemux-side, like a nonzero exit.
    throw new UsageQueryError(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
  // An oversized response is truncated rather than dropped, so report the real
  // cause instead of letting the parser blame it on malformed JSON.
  if (result.exitCode === OUTPUT_LIMIT_EXIT_CODE) {
    throw new UsageQueryError(
      "usagemux produced more output than codemux will capture; its response was truncated"
    );
  }
  // Any nonzero exit is an unreadable snapshot whatever stdout holds
  // (review round 4, edges finding 3): usagemux can print a full valid
  // snapshot and still fail its own cleanup, and a query the caller
  // cannot trust must never be cached or answered as healthy.
  if (result.exitCode !== 0) {
    // usagemux's stderr is upstream bytes (an OSC title, an ANSI color
    // run): they never reach the terminal raw. Escaped here at the
    // source, and the print sites escape again (idempotent on the
    // already-escaped text) — review round 10, contracts 5.
    const detail = escapeForTerminal(result.stderr.trim());
    throw new UsageQueryError(
      `usagemux exited ${result.exitCode}${detail ? `: ${detail}` : ""}`
    );
  }
  let snapshot: UsageSnapshot;
  try {
    snapshot = parseUsageSnapshot(result.stdout);
    assertUsageSnapshotClients(snapshot, clients);
  } catch (error) {
    throw new UsageQueryError(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
  return snapshot;
};
