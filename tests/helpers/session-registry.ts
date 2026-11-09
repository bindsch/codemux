import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewSessionRecord, ResumeProbe, SessionRecord } from "../../src/session/registry.js";

/** A pid above the macOS pid ceiling: never alive, so entries crafted
 * with it are resumable (their owner is dead) and locks holding it are
 * stealable. */
export const DEAD_PID = 999_999;

export function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "cmx-reg-"));
}

export function registryIn(root: string): string {
  return join(root, "reg", "live-sessions.json");
}

export function craftEntry(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "sess-1",
    agent: "claude",
    created_at: "2026-10-05T10:00:00.000Z",
    last_activity: "2026-10-05T10:00:00.000Z",
    cwd: "/definitely/not/the/registry",
    hermetic: false,
    project_settings: false,
    harness_home: "/definitely/not/the/registry/.claude",
    model: null,
    model_alias: null,
    autonomy: "low",
    sandboxed: false,
    sandbox_trust: "standard",
    sandbox_no_net: false,
    sandbox_scrub_env: false,
    sandbox_block: [],
    pass_env: [],
    playwright_mcp: false,
    provider_base_url: null,
    final: false,
    owner_pid: DEAD_PID,
    owner_start: null,
    ended: null,
    ...overrides,
  };
}

export function newRecord(overrides: Partial<NewSessionRecord> = {}): NewSessionRecord {
  const { created_at: _c, last_activity: _l, ended: _e, owner_pid: _p, owner_start: _s, final: _f, ...rest } =
    craftEntry(overrides as Partial<SessionRecord>);
  return rest;
}

export function probe(overrides: Partial<ResumeProbe> = {}): ResumeProbe {
  return {
    agent: "claude",
    harnessHome: "/definitely/not/the/registry/.claude",
    autonomy: "low",
    sandboxed: false,
    sandboxTrust: "standard",
    sandboxNoNet: false,
    sandboxScrubEnv: false,
    sandboxBlock: [],
    cwd: "/definitely/not/the/registry",
    passEnv: [],
    playwrightMcp: false,
    providerBaseUrl: null,
    hermetic: false,
    projectSettings: false,
    ...overrides,
  };
}

/** Write a fully formed registry file directly, bypassing the writers,
 * so lookup/prune behavior can be tested against crafted state. */
export function seedRegistry(path: string, sessions: SessionRecord[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, { mode: 0o600 });
}
