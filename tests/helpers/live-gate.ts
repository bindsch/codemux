// Shared fixtures for the live-gate test files: a scratch report directory
// per test, per-harness facts, report-input builders, and the logged-in
// fixture environment every runProbes call site passes. The gate under
// test lives in scripts/live-gate.ts; tests/live-gate.test.ts owns the
// option and probe-matrix tests.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AGENT_IDS } from "../../src/types.js";
import { getAdapter } from "../../src/adapters/index.js";
import { SESSION_AGENTS } from "../../src/session/cli.js";
import { DEFAULT_PROBES, harnessFacts } from "../../scripts/live-gate.js";
import type { GateRow, HarnessFacts, ProbeLetter } from "../../scripts/live-gate.js";
import type { ReportInput } from "../../scripts/live-gate/report.js";

export const ROOT = resolve(import.meta.dir, "../..");

/** Probe B is judged by the answer's last line (verifyMediumAnswer), so it
 * reaches the runner's capture; test fakes recompute the expected hash from
 * the nonce file the gate planted in the probe's cwd. */
export function mediumHash(command: string[]): string {
  const nonce = readFileSync(join(command[command.indexOf("--cwd") + 1]!, "nonce.txt"), "utf8");
  return createHash("sha256").update(nonce).digest("hex").slice(0, 16);
}

export function fixtureDirectory(): string {
  const scratch = join(ROOT, "scratch");
  mkdirSync(scratch, { recursive: true });
  return mkdtempSync(join(scratch, "live-gate-test-"));
}

export function factsFor(id: (typeof AGENT_IDS)[number]): HarnessFacts {
  return harnessFacts(id, getAdapter(id).capabilities(), SESSION_AGENTS[id] !== undefined);
}

export function passRow(agent: string, letters: readonly ProbeLetter[]): GateRow {
  return { agent: agent as GateRow["agent"], results: Object.fromEntries(letters.map((letter) => [letter, { status: "PASS" as const, seconds: 1, stderr: "" }])) };
}

export function reportInput(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    rows: [],
    contracts: [],
    usage: { status: "SKIP", detail: "usagemux is not installed" },
    version: "2.0.0",
    codemux: join(ROOT, "bin/codemux"),
    probes: DEFAULT_PROBES,
    allowStaleContracts: false,
    allowKnownBreaks: false,
    ...overrides,
  };
}

/** One synthetic credential file per store codemux can read, under a
 * throwaway HOME. No value here is a real credential: the login readers
 * touch existence, mode, expiry, and token-field presence only, and the
 * fake values never leave the fixture. */
const LOGGED_IN_FILES: Record<string, [string, number?]> = {
  ".claude/.credentials.json": ["{ \"claudeAiOauth\": { \"accessToken\": \"synthetic\", \"expiresAt\": 4102444800000 } }"],
  ".codex/auth.json": ["{ \"auth_mode\": \"chatgpt\", \"tokens\": { \"refresh_token\": \"synthetic\" } }"],
  ".kimi-code/credentials/kimi-code.json": ["{ \"expires_at\": 4102444800, \"refresh_token\": \"synthetic\" }"],
  ".zai": ["synthetic", 0o600],
  ".gemini/antigravity-cli/antigravity-oauth-token": ["synthetic"],
  ".gemini/oauth_creds.json": ["synthetic"],
  ".config/goose/config.yaml": ["synthetic"],
  ".copilot/config.json": ["{ \"github\": {} }"],
  ".cursor/auth.json": ["{ \"github\": {} }"],
  ".pi/agent/auth.json": ["{ \"github\": {} }"],
  ".local/share/opencode/auth.json": ["{ \"github\": {} }"],
};

/** The env keys the provider-key harnesses need (aider, droid, openhands,
 * qwen); every file-store harness reads a file above instead. */
const LOGGED_IN_KEYS: Record<string, string> = {
  ANTHROPIC_API_KEY: "synthetic",
  FACTORY_API_KEY: "synthetic",
  LLM_API_KEY: "synthetic",
  DASHSCOPE_API_KEY: "synthetic",
};

/** The fixture homes created so far; cleaned once per test file by
 * cleanupLoggedInHomes (the doctor helper's pattern). */
const homes: string[] = [];

export function cleanupLoggedInHomes(): void {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
}

/** The environment every runProbes call site passes: a HOME whose stores
 * log every harness in, plus the provider-key variables. runProbes reads
 * the login state before the matrix (audit D8), so a call that let the
 * default process.env through would skip or run probes depending on the
 * operator's own stores. `overrides` win over the fixture values. */
export function loggedInEnv(
  overrides: Record<string, string | undefined> = {}
): { env: Record<string, string | undefined> } {
  const home = mkdtempSync(join(tmpdir(), "codemux-probe-home-"));
  homes.push(home);
  for (const [relative, [body, mode]] of Object.entries(LOGGED_IN_FILES)) {
    const path = join(home, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, { mode: mode ?? 0o600 });
  }
  return { env: { HOME: home, ...LOGGED_IN_KEYS, ...overrides } };
}

/** The audit D8 counterpart: the same throwaway-HOME shape with every
 * store absent and no provider key exported, so each harness reads
 * no-credential from its own store. */
export function loggedOutEnv(): { env: Record<string, string | undefined> } {
  const home = mkdtempSync(join(tmpdir(), "codemux-probe-home-"));
  homes.push(home);
  return { env: { HOME: home } };
}
