/**
 * Stage 2 of the machine check: the environment rows — config, model
 * aliases, scode, usagemux, the macOS Keychain, and the CodexBar verdict
 * derived from the usage rows. All reads are existence, mode, version, or
 * exit status; the native credential row is informational and never probes.
 */

import { resolveModel } from "./config.js";
import {
  assertScodeKeepEnvSupport,
  isVersionAtLeast,
  parseVersion,
  SCODE_MINIMUM_VERSION,
} from "./cli-runtime.js";
import { extractScodeVersion, SCODE_DARWIN_FLOOR_REASON, scodeLaunchFloor } from "./cli-runtime/scode.js";
import { compareVersions } from "./harness-compatibility.js";
import { remedyFor } from "./doctor-remedies.js";
import type { EnvironmentRow, HarnessRow, RowSeverity } from "./doctor-model.js";
import { resolveTrustedExecutable } from "./executable-security.js";
import { runCapturedCommand } from "./process-runner.js";
import { runOutputProbe } from "./output-probe.js";
import { withoutAmbientScodeEnv } from "./sandbox.js";
import { isNamespaceCapabilityFailure } from "./scode-namespace.js";
import { readUsagemuxVersion, USAGEMUX_MINIMUM_VERSION } from "./usage.js";
import type { AgentId, CodemuxConfig } from "./types.js";

/** Whether the scode facts fall below a floor, by the launch gate's rule:
 * the full token when the facts carry one (a prerelease of the floor is
 * below it), the numeric triple otherwise (facts built elsewhere). */
export function scodeBelowFloor(facts: ScodeFacts, floor: string): boolean {
  if (facts.semver) {
    try {
      return compareVersions(facts.semver, floor) < 0;
    } catch {
      // An uncomparable token: the gate refuses it; the row says too old.
      return true;
    }
  }
  if (facts.version === null) return true;
  const minimum = parseVersion(floor);
  // An unparseable floor fails closed, like the unreadable facts above
  // and the semver arm's uncomparable token: the launch gate refuses it,
  // and the row says too old (round 372, item 9).
  if (minimum === null) return true;
  return !isVersionAtLeast(facts.version, minimum);
}

export interface ScodeFacts {
  present: boolean;
  /** The trusted scode path, when one resolved. */
  path: string | null;
  /** The parsed `scode --version` triple, when it read one. */
  version: readonly [number, number, number] | null;
  /** The version as printed, for rows and floors. */
  label: string;
  /** The version token with its prerelease suffix, when one was read: the
   * floor comparisons use it the way the launch gate does, so a
   * prerelease of a floor is below the floor on both (review round 344). */
  semver?: string | null;
  /** Why the facts are missing, when they are. */
  issue: string | null;
}

export const readScodeFacts = async (
  workdir = process.cwd()
): Promise<ScodeFacts> => {
  const resolved = Bun.which("scode", { PATH: process.env.PATH ?? "" });
  if (resolved === null) {
    return { present: false, path: null, version: null, label: "absent", issue: "scode is not installed" };
  }
  let trusted: string;
  try {
    trusted = resolveTrustedExecutable(resolved, "scode", workdir);
  } catch (error) {
    return {
      present: false,
      path: null,
      version: null,
      label: "untrusted",
      issue: `scode is not a trusted executable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    const result = await runOutputProbe([trusted, "--version"], {
      cwd: workdir,
      env: process.env as unknown as Record<string, string>,
      timeoutMs: 10_000, scodeProbe: true, // a version probe prepares no HOME
    }, (output) => extractScodeVersion(output) !== null);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (!result.success) {
      return { present: true, path: trusted, version: null, label: "unreadable", issue: `scode --version exited ${result.exitCode}` };
    }
    const version = parseVersion(output);
    const semver = extractScodeVersion(output);
    if (version === null || semver === null) {
      return { present: true, path: trusted, version: null, label: "unreadable", issue: `could not parse scode version '${output}'` };
    }
    return { present: true, path: trusted, version, label: semver, semver, issue: null };
  } catch (error) {
    return {
      present: true,
      path: trusted,
      version: null,
      label: "unreadable",
      issue: error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error),
    };
  }
};

export interface KeychainStatus {
  state: "readable" | "no-entry" | "locked-ssh" | "unreadable" | "skipped" | "not-macos" | "default-missing";
  detail: string;
}

/** Compatibility row: health checks never inspect native credential stores. */
export const readKeychainStatus = async (
  _environment: NodeJS.ProcessEnv = process.env
): Promise<KeychainStatus> => ({
  state: "skipped", detail: "Keychain access is disabled by codemux policy",
});

export const aliasRow = (config: CodemuxConfig): EnvironmentRow => {
  const aliases = Object.entries(config.models);
  if (aliases.length === 0) {
    return { state: "ok", severity: "ok", detail: "no model aliases configured", remedy: null };
  }
  const problems: string[] = [];
  for (const [alias, mapping] of aliases) {
    if (Object.keys(mapping).length === 0) problems.push(`${alias}: maps no harness`);
    for (const agent of Object.keys(mapping)) {
      try {
        resolveModel(alias, agent as AgentId, config);
      } catch (error) {
        problems.push(
          `${alias}->${agent}: ${error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error)}`
        );
      }
    }
  }
  return problems.length > 0
    ? {
        state: "invalid",
        severity: "broken",
        detail: problems.join("; "),
        remedy: "fix the models table in ~/.config/codemux/config.yaml",
      }
    : {
        state: "ok",
        severity: "ok",
        detail: `${aliases.length} alias${aliases.length === 1 ? "" : "es"}, all resolve`,
        remedy: null,
      };
};

export const quotaDetail = (config: CodemuxConfig): string => {
  if (config.quota === false) return "quota gate disabled";
  const timeout = config.quota.timeoutSeconds;
  // A per-agent map spells its entries (review round 50: `[object Object]`).
  const spelled = typeof timeout === "number"
    ? `${timeout} s`
    : Object.entries(timeout).map(([agent, seconds]) => `${agent} ${seconds} s`).join(", ");
  return `ceiling ${config.quota.minRemainingPercent}%, weekly warn ${config.quota.weeklyWarnUsedPercent}%, timeout ${spelled}`;
};

/** One trivial sandboxed command, the same probe CI's scode contract
 * check runs (scripts/check-scode-version.ts, which imports the shared
 * vocabulary): only the sandboxed probe detects a scode that answers
 * --version but cannot sandbox. */
export const probeScodeNamespace = async (
  workdir = process.cwd(),
  scodePath: string | null = null
): Promise<"pass" | "skipped" | "failed"> => {
  // The trusted path the facts resolved, when the caller has one: a second
  // PATH resolution could pick a binary planted between the two lookups
  // (review round 57).
  const resolved = scodePath ?? Bun.which("scode", { PATH: process.env.PATH ?? "" });
  if (resolved === null) return "failed";
  try {
    const result = await runCapturedCommand([resolved, "--", "/bin/sh", "-c", "exit 0"], {
      cwd: workdir,
      // The same scrub a real launch's scode spawn gets (review round
      // 162, finding 4): an ambient SCODE_ACCOUNT_FILE must not turn a
      // diagnostic probe into a write to the path it names.
      env: withoutAmbientScodeEnv(process.env as unknown as Record<string, string>),
      timeoutMs: 10_000,
    });
    if (result.success) return "pass";
    const output = `${result.stdout}\n${result.stderr}`;
    return isNamespaceCapabilityFailure(output) ? "skipped" : "failed";
  } catch {
    return "failed";
  }
};

export const scodeEnvironmentRow = async (facts: ScodeFacts, platform: NodeJS.Platform = process.platform): Promise<EnvironmentRow> => {
  if (!facts.present) {
    return {
      state: facts.issue !== null && facts.issue.includes("trusted") ? "UNTRUSTED" : "SANDBOX-MISSING",
      severity: "broken",
      detail: facts.issue ?? "scode is not installed",
      remedy: remedyFor("claude", facts.issue?.includes("trusted") ? "UNTRUSTED" : "SANDBOX-MISSING"),
    };
  }
  if (facts.version === null) {
    return {
      state: "unreadable",
      severity: "broken",
      detail: facts.issue ?? "scode --version printed no version",
      remedy: "reinstall scode (brew reinstall bindsch/tap/scode)",
    };
  }
  // The launch gate's floor: the global minimum, raised on macOS to the
  // release that denies the keychain services (cli-runtime/scode.ts).
  const minimum = scodeLaunchFloor(SCODE_MINIMUM_VERSION, platform);
  if (scodeBelowFloor(facts, minimum)) {
    return {
      state: "SANDBOX-TOO-OLD",
      severity: "broken",
      detail: `scode ${facts.label} is below the ${minimum === SCODE_MINIMUM_VERSION ? "global" : "macOS"} minimum ${minimum}` +
        (minimum === SCODE_MINIMUM_VERSION ? "" : SCODE_DARWIN_FLOOR_REASON.replace(" on macOS", "")),
      remedy: `brew upgrade bindsch/tap/scode to >= ${minimum}`,
    };
  }
  const lines = [`scode ${facts.label} (>= ${minimum})`];
  if (platform === "darwin") lines.push("keychain services denied without the login-store grant");
  let severity: RowSeverity = "ok";
  if (facts.path !== null) {
    try {
      await assertScodeKeepEnvSupport(facts.path, process.cwd(), undefined, {
        scrubEnv: false,
        untrusted: false,
      });
      lines.push("--keep-env supported");
    } catch (error) {
      severity = "warn";
      lines.push(
        `--keep-env unsupported: ${error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error)}`
      );
    }
  }
  const namespace = await probeScodeNamespace(process.cwd(), facts.path);
  if (namespace === "skipped") {
    lines.push("namespace probe skipped (this runner cannot create user namespaces)");
    if (severity === "ok") severity = "info";
  } else if (namespace === "failed") {
    return {
      state: "PROBE-FAILED",
      severity: "broken",
      detail: "scode could not run one sandboxed command (/bin/sh -c 'exit 0')",
      remedy: "reinstall scode; if the kernel refuses user namespaces, scode cannot sandbox here",
    };
  } else {
    lines.push("namespace probe passed");
  }
  return { state: "ok", severity, detail: lines.join("; "), remedy: null };
};

export const usagemuxRowFrom = (
  status: Awaited<ReturnType<typeof readUsagemuxVersion>>
): EnvironmentRow => {
  if (status.version === null) {
    if (status.issue === "usagemux is not installed") {
      return {
        state: "USAGEMUX-MISSING",
        severity: "warn",
        detail: "not installed (optional; usage rows read UNREADABLE)",
        remedy: remedyFor("claude", "USAGEMUX-MISSING"),
      };
    }
    // Installed but unreadable (review round 361): a --version that exits
    // nonzero, prints no version, or times out, or a binary the trust
    // check refuses. Collapsing these onto MISSING printed "not installed"
    // for an installed binary and prescribed installing it — the wrong
    // remedy for the command whose job is to diagnose a broken install.
    // The separate state also keeps the binary present: the machine check
    // reads `usagemuxPresent` as "not MISSING", so the usage rows still
    // query it and report their own unreadable verdict, never "usagemux is
    // not installed".
    return {
      state: "USAGEMUX-UNREADABLE",
      severity: "warn",
      detail: status.issue ?? "unreadable",
      remedy: remedyFor("claude", "USAGEMUX-UNREADABLE"),
    };
  }
  if (status.belowMinimum) {
    return {
      state: "USAGEMUX-STALE",
      severity: "warn",
      detail: `usagemux ${status.version} is below ${USAGEMUX_MINIMUM_VERSION}`,
      remedy: remedyFor("claude", "USAGEMUX-STALE"),
    };
  }
  return { state: "ok", severity: "ok", detail: `usagemux ${status.version}`, remedy: null };
};

export const keychainRowFrom = (status: KeychainStatus): EnvironmentRow => {
  switch (status.state) {
    case "readable":
      return { state: "ok", severity: "ok", detail: status.detail, remedy: null };
    case "not-macos":
    case "skipped":
      return { state: status.state, severity: "info", detail: status.detail, remedy: null };
    case "no-entry":
      return { state: "no-entry", severity: "info", detail: status.detail, remedy: null };
    case "default-missing":
      return {
        state: "default-missing",
        severity: "broken",
        detail: status.detail,
        remedy: null,
      };
    default:
      return { state: status.state, severity: "warn", detail: status.detail, remedy: null };
  }
};

export const codexbarRow = (rows: readonly HarnessRow[], usagemuxPresent: boolean): EnvironmentRow => {
  if (!usagemuxPresent) {
    return { state: "unknown", severity: "info", detail: "usagemux is absent; CodexBar reachability is unknown", remedy: null };
  }
  const fetched = rows.filter((row) => row.usageVerdict !== "not-run");
  const unavailable = fetched.filter((row) => !row.usageReadable && row.usageVerdict === "warn");
  if (fetched.length === 0) {
    return { state: "unknown", severity: "info", detail: "no usage row was fetched", remedy: null };
  }
  if (unavailable.length === fetched.length) {
    return {
      state: "unreachable",
      severity: "warn",
      detail: "every client reported unavailable; see each row's usagemux message",
      remedy: null,
    };
  }
  return { state: "reachable", severity: "ok", detail: `${fetched.length - unavailable.length}/${fetched.length} clients answered`, remedy: null };
};
