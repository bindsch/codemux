import { resolveTrustedExecutable } from "./executable-security.js";
import { runCapturedCommand } from "./process-runner.js";
import type { AgentId } from "./types.js";
import { parseUsageSnapshot, type UsageSnapshot } from "./usage-protocol.js";

export {
  formatUsageSnapshot,
  parseUsageSnapshot,
  USAGEMUX_PROTOCOL_VERSION,
} from "./usage-protocol.js";

export const USAGEMUX_UNAVAILABLE_EXIT_CODE = 69;
export const MAX_USAGE_TIMEOUT_SECONDS = 300;
const USAGEMUX_SHUTDOWN_GRACE_MS = 2_000;

export interface UsagemuxStatus {
  available: boolean;
  issue: string | null;
}

export class UsageIntegrationUnavailableError extends Error {}

export const parseUsageTimeoutOption = (value: string): number => {
  const seconds = Number(value);
  if (
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > MAX_USAGE_TIMEOUT_SECONDS
  ) {
    throw new Error(
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

export const fetchUsageSnapshot = async (
  clients: readonly AgentId[],
  timeoutMs: number,
  workdir = process.cwd(),
  environment = process.env as Record<string, string>
): Promise<{ snapshot: UsageSnapshot; exitCode: number }> => {
  const binary = resolveUsagemux(workdir, environment);
  if (!binary) {
    throw new UsageIntegrationUnavailableError(
      "usagemux is not installed (optional usage integration); install it and ensure it is on PATH"
    );
  }
  const result = await runCapturedCommand(
    [binary, ...buildUsagemuxArguments(clients, timeoutMs)],
    { cwd: workdir, env: environment, timeoutMs: getUsagemuxProcessTimeout(timeoutMs) }
  );
  if (result.stdout.trim().length === 0) {
    const detail = result.stderr.trim();
    throw new Error(
      `usagemux failed with exit code ${result.exitCode}${detail ? `: ${detail}` : ""}`
    );
  }
  const snapshot = parseUsageSnapshot(result.stdout);
  assertUsageSnapshotClients(snapshot, clients);
  return {
    snapshot,
    exitCode: result.exitCode,
  };
};
