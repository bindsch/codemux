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

/** Date.parse normalizes a nonexistent date (2026-02-30 reads as March 2),
 * so the calendar fields must round-trip through Date.UTC exactly
 * (review round 59). */
const calendarValid = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  // setUTCFullYear, not Date.UTC: Date.UTC reads years 0 to 99 as 1900 to
  // 1999 and would reject valid early timestamps (review round 61).
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day &&
    date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
};

const requireTimestamp = (value: unknown, field: string): string => {
  if (
    typeof value !== "string" ||
    !RFC3339_TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    !calendarValid(value)
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
  // usagemux's protocol guarantees "a finite duration value … no
  // positivity or integer constraint" (its PROTOCOL.md): a non-number or a
  // non-finite number (JSON `1e999` parses to Infinity) is a protocol
  // violation that fails the snapshot (review round 53: an exhausted weekly
  // window read as an unbounded pool); a negative value becomes null.
  if (
    value.windowMinutes !== null &&
    (typeof value.windowMinutes !== "number" || !Number.isFinite(value.windowMinutes))
  ) {
    throw new Error("windowMinutes must be a finite number or null");
  }
  const windowMinutes =
    value.windowMinutes === null || value.windowMinutes < 0 ? null : value.windowMinutes;
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
// sequences. JSON.stringify escapes C0 only; the --json path layers
// escapeJsonControls (labels.ts) on top for DEL and C1, exactly as
// `calls --json` does.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;

export const escapeForTerminal = (value: string): string =>
  value.replace(
    CONTROL_CHARACTERS,
    (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`
  );

/** One argv argument as one printable line (`--print-sandbox`): the output
 * is one argument per line, so a control character inside an argument — a
 * newline in a multi-line `-p` prompt is the common one — must print as an
 * escape sequence, never as a line of its own that reads as an argument
 * separator. Newline, carriage return, and tab use their familiar
 * spellings; every other control takes escapeForTerminal's `\xNN` form. */
const ARGUMENT_ESCAPES = new Map([
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
]);
export const escapeArgvForPrint = (argument: string): string =>
  argument.replace(
    CONTROL_CHARACTERS,
    (character) =>
      ARGUMENT_ESCAPES.get(character) ??
      `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`
  );

/** At most two decimals, matching usagemux's own text format (16.434343
 * renders 16.43). Display only; --json keeps full precision. */
export const formatUsagePercent = (value: number): string =>
  String(Math.round(value * 100) / 100);

/** A reset instant for a human reading a terminal: local time plus a
 * relative span ("in 5 d 11 h"), so nobody converts UTC in their head
 * (audit round 2, B13 — the `calls` table already printed local time).
 * A null, unparseable, or past instant answers null and the caller
 * prints its own placeholder. */
export const formatResetTime = (iso: string | null, now = new Date()): string | null => {
  if (iso === null) return null;
  const when = Date.parse(iso);
  if (!Number.isFinite(when)) return null;
  const date = new Date(when);
  const two = (value: number): string => String(value).padStart(2, "0");
  const local =
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
  const until = when - now.getTime();
  if (until <= 0) return `${local} (now)`;
  const minutes = Math.floor(until / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const span =
    days > 0
      ? `${days} d ${hours % 24} h`
      : hours > 0
        ? `${hours} h ${minutes % 60} m`
        : `${minutes} m`;
  return `${local} (in ${span})`;
};

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
      // A window may report only what it knows: remaining when the provider
      // exposes it, otherwise the used percent, otherwise nothing.
      const remaining =
        window.remainingPercent !== null
          ? `${formatUsagePercent(window.remainingPercent)}% left`
          : window.usedPercent !== null
            ? `${formatUsagePercent(window.usedPercent)}% used`
            : "remaining unknown";
      const reset = window.resetsAt
        ? `; resets ${formatResetTime(window.resetsAt) ?? window.resetsAt}`
        : "";
      lines.push(`  ${escapeForTerminal(window.kind)}: ${remaining}${reset}`);
    }
    if (result.credits) {
      lines.push(
        `  credits: ${result.credits.remaining} ${escapeForTerminal(result.credits.unit)} left`
      );
    }
    if (result.subscriptionRenewsAt) {
      lines.push(
        `  subscription renews: ${formatResetTime(result.subscriptionRenewsAt) ?? result.subscriptionRenewsAt}`
      );
    }
    if (result.subscriptionExpiresAt) {
      lines.push(
        `  subscription expires: ${formatResetTime(result.subscriptionExpiresAt) ?? result.subscriptionExpiresAt}`
      );
    }
  }
  return lines.join("\n");
};
