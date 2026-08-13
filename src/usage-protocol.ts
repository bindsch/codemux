import { AGENT_IDS, type AgentId } from "./types.js";

export const USAGEMUX_PROTOCOL_VERSION = "1";

const USAGE_STATUSES = ["ok", "unavailable", "not-applicable", "error"] as const;
type UsageStatus = (typeof USAGE_STATUSES)[number];
const RFC3339_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface UsageWindow {
  kind: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  windowMinutes: number | null;
  resetsAt: string | null;
}

export interface UsageCredits {
  remaining: number;
  unit: string;
}

export interface UsageResult {
  client: AgentId;
  provider: string | null;
  status: UsageStatus;
  source: string | null;
  plan: string | null;
  account: string | null;
  windows: UsageWindow[];
  credits: UsageCredits | null;
  subscriptionRenewsAt: string | null;
  subscriptionExpiresAt: string | null;
  message: string | null;
}

export interface UsageSnapshot {
  schemaVersion: typeof USAGEMUX_PROTOCOL_VERSION;
  generatedAt: string;
  results: UsageResult[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertExactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void => {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${label} contains unknown field '${key}'`);
  }
};

const requireNullableString = (value: unknown, field: string): string | null => {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string or null`);
  return value;
};

const requireFiniteNumber = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
};

const requirePercentage = (value: unknown, field: string): number | null => {
  if (value === null) return null;
  const number = requireFiniteNumber(value, field);
  if (number < 0 || number > 100) {
    throw new Error(`${field} must be a number from 0 to 100 or null`);
  }
  return number;
};

const requireTimestamp = (value: unknown, field: string): string => {
  if (
    typeof value !== "string" ||
    !RFC3339_TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${field} must be an RFC 3339 timestamp`);
  }
  return value;
};

const parseWindow = (value: unknown): UsageWindow => {
  if (!isRecord(value)) throw new Error("usage window must be an object");
  assertExactKeys(
    value,
    ["kind", "usedPercent", "remainingPercent", "windowMinutes", "resetsAt"],
    "usage window"
  );
  if (typeof value.kind !== "string" || value.kind.length === 0) {
    throw new Error("kind must be a non-empty string");
  }
  const windowMinutes = value.windowMinutes === null
    ? null
    : requireFiniteNumber(value.windowMinutes, "windowMinutes");
  if (windowMinutes !== null && windowMinutes < 0) {
    throw new Error("windowMinutes must be non-negative or null");
  }
  const resetsAt = requireNullableString(value.resetsAt, "resetsAt");
  if (resetsAt !== null) requireTimestamp(resetsAt, "resetsAt");
  return {
    kind: value.kind,
    usedPercent: requirePercentage(value.usedPercent, "usedPercent"),
    remainingPercent: requirePercentage(value.remainingPercent, "remainingPercent"),
    windowMinutes,
    resetsAt,
  };
};

const parseCredits = (value: unknown): UsageCredits | null => {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error("credits must be an object or null");
  assertExactKeys(value, ["remaining", "unit"], "credits");
  if (typeof value.unit !== "string" || value.unit.length === 0) {
    throw new Error("credits.unit must be a non-empty string");
  }
  return {
    remaining: requireFiniteNumber(value.remaining, "credits.remaining"),
    unit: value.unit,
  };
};

const parseResult = (value: unknown): UsageResult => {
  if (!isRecord(value)) throw new Error("usage result must be an object");
  assertExactKeys(
    value,
    [
      "client",
      "provider",
      "status",
      "source",
      "plan",
      "account",
      "windows",
      "credits",
      "subscriptionRenewsAt",
      "subscriptionExpiresAt",
      "message",
    ],
    "usage result"
  );
  if (typeof value.client !== "string" || !AGENT_IDS.includes(value.client as AgentId)) {
    throw new Error(`unknown usage client '${String(value.client)}'`);
  }
  if (
    typeof value.status !== "string" ||
    !(USAGE_STATUSES as readonly string[]).includes(value.status)
  ) {
    throw new Error(`unknown usage status '${String(value.status)}'`);
  }
  if (!Array.isArray(value.windows)) throw new Error("windows must be an array");
  const subscriptionRenewsAt = requireNullableString(
    value.subscriptionRenewsAt,
    "subscriptionRenewsAt"
  );
  if (subscriptionRenewsAt !== null) {
    requireTimestamp(subscriptionRenewsAt, "subscriptionRenewsAt");
  }
  const subscriptionExpiresAt = requireNullableString(
    value.subscriptionExpiresAt,
    "subscriptionExpiresAt"
  );
  if (subscriptionExpiresAt !== null) {
    requireTimestamp(subscriptionExpiresAt, "subscriptionExpiresAt");
  }
  return {
    client: value.client as AgentId,
    provider: requireNullableString(value.provider, "provider"),
    status: value.status as UsageStatus,
    source: requireNullableString(value.source, "source"),
    plan: requireNullableString(value.plan, "plan"),
    account: requireNullableString(value.account, "account"),
    windows: value.windows.map(parseWindow),
    credits: parseCredits(value.credits),
    subscriptionRenewsAt,
    subscriptionExpiresAt,
    message: requireNullableString(value.message, "message"),
  };
};

export const parseUsageSnapshot = (text: string): UsageSnapshot => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`usagemux returned invalid JSON${detail}`);
  }
  if (!isRecord(value)) throw new Error("usagemux response must be an object");
  assertExactKeys(value, ["schemaVersion", "generatedAt", "results"], "usagemux response");
  if (value.schemaVersion !== USAGEMUX_PROTOCOL_VERSION) {
    throw new Error(
      `unsupported usagemux protocol version '${String(value.schemaVersion)}'`
    );
  }
  if (!Array.isArray(value.results)) throw new Error("usagemux results must be an array");
  return {
    schemaVersion: USAGEMUX_PROTOCOL_VERSION,
    generatedAt: requireTimestamp(value.generatedAt, "generatedAt"),
    results: value.results.map(parseResult),
  };
};

// usagemux relays provider-supplied strings, and these reach a terminal. Escape
// C0/C1 control characters and DEL so a hostile or compromised upstream response
// cannot move the cursor, clear the screen, or drive terminal reporting
// sequences. The --json path needs no equivalent: JSON.stringify escapes them.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;

export const escapeForTerminal = (value: string): string =>
  value.replace(
    CONTROL_CHARACTERS,
    (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`
  );

export const formatUsageSnapshot = (snapshot: UsageSnapshot): string => {
  const lines: string[] = [];
  for (const result of snapshot.results) {
    if (result.status !== "ok") {
      lines.push(
        `${result.client}: ${result.status}${result.message ? ` — ${escapeForTerminal(result.message)}` : ""}`
      );
      continue;
    }
    const provider = result.provider ? ` (${escapeForTerminal(result.provider)})` : "";
    lines.push(
      `${result.client}${provider}: ${result.plan ? escapeForTerminal(result.plan) : "usage available"}`
    );
    if (result.account) lines.push(`  account: ${escapeForTerminal(result.account)}`);
    for (const window of result.windows) {
      const remaining = window.remainingPercent === null
        ? "remaining unknown"
        : `${window.remainingPercent}% left`;
      const reset = window.resetsAt ? `; resets ${window.resetsAt}` : "";
      lines.push(`  ${escapeForTerminal(window.kind)}: ${remaining}${reset}`);
    }
    if (result.credits) {
      lines.push(
        `  credits: ${result.credits.remaining} ${escapeForTerminal(result.credits.unit)} left`
      );
    }
    if (result.subscriptionRenewsAt) {
      lines.push(`  subscription renews: ${result.subscriptionRenewsAt}`);
    }
    if (result.subscriptionExpiresAt) {
      lines.push(`  subscription expires: ${result.subscriptionExpiresAt}`);
    }
  }
  return lines.join("\n");
};
