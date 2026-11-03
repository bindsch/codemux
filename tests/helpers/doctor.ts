/**
 * Shared fixtures for the machine-check tests: an in-process `codemux
 * doctor` against a controlled environment (nothing the host exported can
 * leak in, nothing here touches the host), fixture HOMEs for credential
 * stores, and the fake scode/usagemux scripts every green path needs.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { getDefaultConfig } from "../../src/config.js";
import { registerInfoCommands } from "../../src/info-commands.js";

/** A throwaway HOME with the named files (relative paths, 0600 unless a
 * mode is given). The tests never read a real home: every login reader
 * would see the operator's own stores. */
export function fixtureHome(
  files: Record<string, string | { body: string; mode?: number }> = {},
  keep: string[] = []
): string {
  const home = mkdtempSync(join(tmpdir(), "codemux-doctor-home-"));
  keep.push(home);
  for (const [relative, entry] of Object.entries(files)) {
    const path = join(home, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof entry === "string" ? entry : entry.body);
    if (typeof entry !== "string" && entry.mode !== undefined) {
      chmodSync(path, entry.mode);
    }
  }
  return home;
}

export function cleanupFixtureHomes(homes: string[]): void {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
}

/** In-process `codemux doctor <args>` with a wholly controlled
 * environment: the host's variables (credential keys, proxy settings) are
 * swapped out for the ones named here, so a login row never depends on
 * the machine the suite runs on. */
export async function runDoctor(
  args: string[],
  options: {
    path: string;
    home: string;
    env?: Record<string, string>;
    configError?: Error;
  }
): Promise<{ output: string; errors: string; exitCode: number | undefined }> {
  const command = new Command();
  command.exitOverride();
  let exitCode: number | undefined;
  registerInfoCommands(command, getDefaultConfig(), options.configError, (code) => {
    exitCode = code;
  });
  const lines: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const savedEnv = { ...process.env };
  console.log = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    PATH: options.path,
    HOME: options.home,
    TMPDIR: savedEnv.TMPDIR ?? "/tmp",
    // Never touch the operator's real Keychain from a test.
    CODEMUX_NO_KEYCHAIN_SYNC: "1",
    ...options.env,
  });
  try {
    await command.parseAsync(["node", "codemux", "doctor", ...args]);
    return { output: lines.join("\n"), errors: errors.join("\n"), exitCode };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
}

/** The scode every green path fakes: it answers --version (the helper's
 * preamble), --help with a --keep-env line, and one sandboxed command. */
export function fakeScodeHelp(): string {
  return `case "$1" in --help) printf '  --keep-env  keep the environment\\n';; esac\nexit 0`;
}

export interface FakeUsagemuxOptions {
  version?: string;
  /** The snapshot's generatedAt; the current time unless a test wants a stale one. */
  generatedAt?: string;
  status?: "ok" | "unavailable" | "not-applicable";
  remainingPercent?: number;
  usedPercent?: number;
  message?: string;
  account?: string;
}

/** A fake usagemux: it answers `--version`, records every snapshot
 * invocation (client and the timeout it received) beside itself, and
 * prints one validated snapshot for whichever client was requested. */
export function fakeUsagemux(options: FakeUsagemuxOptions = {}): string {
  const version = options.version ?? "1.0.0";
  const status = options.status ?? "ok";
  const remaining = options.remainingPercent ?? 61;
  const used = options.usedPercent ?? 39;
  const account = options.account ?? "acct-1";
  const message = options.message ?? null;
  const messageJson = message === null ? "null" : JSON.stringify(message);
  const generatedAt = options.generatedAt === undefined ? `$(date -u +%Y-%m-%dT%H:%M:%S.000Z)` : options.generatedAt;
  return [
    `if [ "$1" = "--version" ]; then printf 'usagemux ${version}\\n'; exit 0; fi`,
    `client=""; previous=""`,
    `for argument in "$@"; do if [ "$previous" = "--client" ]; then client="$argument"; fi; previous="$argument"; done`,
    `timeout=""; previous=""`,
    `for argument in "$@"; do if [ "$previous" = "--timeout" ]; then timeout="$argument"; fi; previous="$argument"; done`,
    `printf '%s\\n' "client=$client timeout=$timeout" >> "$(dirname "$0")/usagemux-calls.log"`,
    `printf '{"schemaVersion":"1","generatedAt":"'"${generatedAt}"'","results":[{"client":"%s","provider":"codex","status":"${status}","source":"codex-cli","plan":"plus","account":"${account}","windows":[{"kind":"primary","usedPercent":${used},"remainingPercent":${remaining},"windowMinutes":10080,"resetsAt":"2026-11-07T09:00:00.000Z"}],"credits":{"remaining":12.5,"unit":"credits"},"subscriptionRenewsAt":"2026-12-03T10:00:00.000Z","subscriptionExpiresAt":null,"message":${messageJson}}]}' "$client"`,
    `exit 0`,
  ].join("\n");
}

/** Reads a marker file a fake binary wrote beside itself; "" when absent,
 * so a test can assert both "it ran" and "it never ran". */
export function readPathMarker(env: Record<string, string>, name: string): string {
  const path = join(env.PATH!.split(":")[0]!, name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export { minimalPath } from "./cli.js";
