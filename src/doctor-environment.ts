/**
 * Stage 2 of the machine check: the environment rows — config, model
 * aliases, scode, usagemux, the macOS Keychain, and the CodexBar verdict
 * derived from the usage rows. All reads are existence, mode, version, or
 * exit status; the Keychain probe never asks for the secret itself.
 */

import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { resolveModel } from "./config.js";
import {
  assertScodeKeepEnvSupport,
  isVersionAtLeast,
  parseVersion,
  SCODE_MINIMUM_VERSION,
} from "./cli-runtime.js";
import { remedyFor } from "./doctor-remedies.js";
import type { EnvironmentRow, HarnessRow, RowSeverity } from "./doctor-model.js";
import { resolveTrustedExecutable } from "./executable-security.js";
import { runCapturedCommand } from "./process-runner.js";
import { isNamespaceCapabilityFailure } from "./scode-namespace.js";
import { readUsagemuxVersion, USAGEMUX_MINIMUM_VERSION } from "./usage.js";
import { escapeForTerminal } from "./usage-protocol.js";
import type { AgentId, CodemuxConfig } from "./types.js";

export interface ScodeFacts {
  present: boolean;
  /** The trusted scode path, when one resolved. */
  path: string | null;
  /** The parsed `scode --version` triple, when it read one. */
  version: readonly [number, number, number] | null;
  /** The version as printed, for rows and floors. */
  label: string;
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
    const result = await runCapturedCommand([trusted, "--version"], {
      cwd: workdir,
      env: process.env as unknown as Record<string, string>,
      timeoutMs: 10_000,
    });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (!result.success) {
      return { present: true, path: trusted, version: null, label: "unreadable", issue: `scode --version exited ${result.exitCode}` };
    }
    const version = parseVersion(output);
    if (version === null) {
      return { present: true, path: trusted, version: null, label: "unreadable", issue: `could not parse scode version '${output}'` };
    }
    return { present: true, path: trusted, version, label: version.join("."), issue: null };
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

/** One `security find-generic-password -s "Claude Code-credentials"`
 * WITHOUT `-w`: does the item exist and can this session read it. Never
 * the secret itself. `CODEMUX_NO_KEYCHAIN_SYNC=1` (the test seam) skips
 * the read so a test never touches the operator's real Keychain. */
export const readKeychainStatus = async (
  environment: NodeJS.ProcessEnv = process.env
): Promise<KeychainStatus> => {
  if (process.platform !== "darwin") {
    return { state: "not-macos", detail: "the Keychain check is macOS-only" };
  }
  if (environment.CODEMUX_NO_KEYCHAIN_SYNC === "1") {
    return { state: "skipped", detail: "keychain read disabled for this run" };
  }
  const resolvedSecurity = Bun.which("security", { PATH: environment.PATH ?? "" });
  if (resolvedSecurity === null) {
    return { state: "unreadable", detail: "the security tool is not on PATH" };
  }
  // The same trust rule every launch applies to a tool it executes: a
  // writable or working-directory `security` is never run (review round 44).
  let security: string;
  try {
    security = resolveTrustedExecutable(resolvedSecurity, "security", process.cwd());
  } catch (error) {
    return { state: "unreadable", detail: `the security tool is not trusted: ${error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error)}` };
  }
  try {
    // The user default keychain must exist on disk, whether or not a Claude
    // item exists: a default that names a missing file makes macOS prompt
    // "a keychain cannot be found to store ..." the next time any process
    // stores a credential (2026-11-03, an agy mirror; the ordering is
    // review round 53's). Broken, with the one-line remedy.
    const def = await runCapturedCommand([security, "default-keychain", "-d", "user"], {
      cwd: process.cwd(), env: environment as unknown as Record<string, string>, timeoutMs: 5_000,
    });
    const path = def.stdout.trim().replace(/^"|"$/g, "");
    if (def.success && path !== "" && !existsSync(path)) {
      return { state: "default-missing", detail: `the user default keychain names a missing file: ${path}` };
    }
    const result = await runCapturedCommand(
      // The same item the credential reader queries (src/credentials/oauth.ts):
      // service plus the current account, never the service alone (round 46).
      [security, "find-generic-password", "-s", "Claude Code-credentials", "-a", environment.USER || userInfo().username],
      { cwd: process.cwd(), env: environment as unknown as Record<string, string>, timeoutMs: 5_000 }
    );
    if (result.success) {
      return { state: "readable", detail: "the login item is readable" };
    }
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (/could not be found/i.test(output)) {
      return { state: "no-entry", detail: "no Claude Code-credentials item in the Keychain" };
    }
    const overSsh = Boolean(environment.SSH_CONNECTION ?? environment.SSH_TTY);
    if (overSsh) {
      return { state: "locked-ssh", detail: "the Keychain is locked over SSH; a GUI login unlocks it" };
    }
    return {
      state: "unreadable",
      detail: `security exited ${result.exitCode}${output ? `: ${escapeForTerminal(output.split("\n")[0] ?? "")}` : ""}`,
    };
  } catch (error) {
    return {
      state: "unreadable",
      detail: error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error),
    };
  }
};

export const aliasRow = (config: CodemuxConfig): EnvironmentRow => {
  const aliases = Object.entries(config.models);
  if (aliases.length === 0) {
    return { state: "ok", severity: "ok", detail: "no model aliases configured", remedy: null };
  }
  const problems: string[] = [];
  for (const [alias, mapping] of aliases) {
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
  workdir = process.cwd()
): Promise<"pass" | "skipped" | "failed"> => {
  const resolved = Bun.which("scode", { PATH: process.env.PATH ?? "" });
  if (resolved === null) return "failed";
  try {
    const result = await runCapturedCommand([resolved, "--", "/bin/sh", "-c", "exit 0"], {
      cwd: workdir,
      env: process.env as unknown as Record<string, string>,
      timeoutMs: 10_000,
    });
    if (result.success) return "pass";
    const output = `${result.stdout}\n${result.stderr}`;
    return isNamespaceCapabilityFailure(output) ? "skipped" : "failed";
  } catch {
    return "failed";
  }
};

export const scodeEnvironmentRow = async (facts: ScodeFacts): Promise<EnvironmentRow> => {
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
  const minimum = parseVersion(SCODE_MINIMUM_VERSION)!;
  if (!isVersionAtLeast(facts.version, minimum)) {
    return {
      state: "SANDBOX-TOO-OLD",
      severity: "broken",
      detail: `scode ${facts.label} is below the global minimum ${SCODE_MINIMUM_VERSION}`,
      remedy: `brew upgrade bindsch/tap/scode to >= ${SCODE_MINIMUM_VERSION}`,
    };
  }
  const lines = [`scode ${facts.label} (>= ${SCODE_MINIMUM_VERSION})`];
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
  const namespace = await probeScodeNamespace();
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
    return {
      state: "USAGEMUX-MISSING",
      severity: "warn",
      detail: status.issue ?? "unreadable",
      remedy: remedyFor("claude", "USAGEMUX-MISSING"),
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
        remedy: "security default-keychain -d user -s ~/Library/Keychains/login.keychain-db",
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
