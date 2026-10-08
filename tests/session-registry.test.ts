import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  claimForResume,
  lookupForResume,
  probeRegistryForStart,
  registryInside,
  processIdentityAlive,
  readRegistry,
  recordSessionEnd,
  releaseSessionRecord,
  recordSessionStart,
  REGISTRY_MAX_ENTRIES,
  sessionHoldState,
  sessionRegistryPath,
  touchSession,
  type NewSessionRecord,
  type ResumeProbe,
  type SandboxTrust,
  type SessionRecord,
} from "../src/session/registry.js";
import { MAX_ID_CHARS } from "../src/session/protocol.js";
import { acquireLock, listHeldLocks, writeRegistryAtomic } from "../src/session/registry-io.js";
import { aiderSessionAutonomyFlags } from "../src/session/aider-session.js";
import { opencodeSessionAutonomyFlags } from "../src/session/opencode-session.js";
import type { AutonomyLevel } from "../src/types.js";

/** A pid above the macOS pid ceiling: never alive, so entries crafted
 * with it are resumable (their owner is dead) and locks holding it are
 * stealable. */
const DEAD_PID = 999_999;

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "cmx-reg-"));
}

function registryIn(root: string): string {
  return join(root, "reg", "live-sessions.json");
}

function craftEntry(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "sess-1",
    agent: "claude",
    created_at: "2026-10-05T10:00:00.000Z",
    last_activity: "2026-10-05T10:00:00.000Z",
    cwd: "/definitely/not/the/registry",
    hermetic: false,
    harness_home: "/definitely/not/the/registry/.claude",
    model: null,
    autonomy: "low",
    sandboxed: false,
    sandbox_trust: "standard",
    sandbox_no_net: false,
    sandbox_scrub_env: false,
    pass_env: [],
    playwright_mcp: false,
    provider_base_url: null,
    owner_pid: DEAD_PID,
    owner_start: null,
    ended: null,
    ...overrides,
  };
}

function newRecord(overrides: Partial<NewSessionRecord> = {}): NewSessionRecord {
  const { created_at: _c, last_activity: _l, ended: _e, owner_pid: _p, owner_start: _s, ...rest } =
    craftEntry(overrides as Partial<SessionRecord>);
  return rest;
}

function probe(overrides: Partial<ResumeProbe> = {}): ResumeProbe {
  return {
    agent: "claude",
    harnessHome: "/definitely/not/the/registry/.claude",
    autonomy: "low",
    sandboxed: false,
    sandboxTrust: "standard",
    sandboxNoNet: false,
    sandboxScrubEnv: false,
    cwd: "/definitely/not/the/registry",
    passEnv: [],
    playwrightMcp: false,
    providerBaseUrl: null,
    hermetic: false,
    ...overrides,
  };
}

/** Write a fully formed registry file directly, bypassing the writers,
 * so lookup/prune behavior can be tested against crafted state. */
function seedRegistry(path: string, sessions: SessionRecord[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, { mode: 0o600 });
}

describe("registry path and liveness", () => {
  test("the default path is home-derived per platform", () => {
    expect(sessionRegistryPath("/Users/x", "darwin")).toBe(
      "/Users/x/Library/Application Support/codemux/live-sessions.json"
    );
    expect(sessionRegistryPath("/home/x", "linux")).toBe(
      "/home/x/.local/state/codemux/live-sessions.json"
    );
  });

  test("identity liveness: self alive, out-of-range pid dead", () => {
    expect(processIdentityAlive(process.pid, null)).toBe(true);
    expect(processIdentityAlive(DEAD_PID, null)).toBe(false);
  });

  test("sessionHoldState answers held/free/unknown so a deletion acts only on a positive free (reviews D2, D5)", () => {
    // The file-sweeper's liveness skip: only a session the registry holds
    // OPEN under a live owner is protected from the age sweep (`held`) —
    // an ended or dead-owner session stays sweepable, an unknown id is
    // not held. The D5 rule: a registry that cannot be READ answers
    // `unknown`, never a folded-in "not held" — the sweeps spare what
    // they cannot judge, and only a positive `free` may remove.
    const path = registryIn(makeRoot());
    seedRegistry(path, [
      craftEntry({ id: "live-id", owner_pid: process.pid }),
      craftEntry({ id: "ended-id", owner_pid: process.pid, ended: "2026-10-05T11:00:00.000Z" }),
      craftEntry({ id: "dead-id", owner_pid: DEAD_PID }),
    ]);
    expect(sessionHoldState(path, "live-id")).toBe("held");
    expect(sessionHoldState(path, "ended-id")).toBe("free");
    expect(sessionHoldState(path, "dead-id")).toBe("free");
    expect(sessionHoldState(path, "unknown-id")).toBe("free");
    // No registry at all: nothing can be held (a deletion may proceed).
    expect(sessionHoldState(join(makeRoot(), "absent.json"), "live-id")).toBe("free");
    // A corrupt file is as unreadable as a busy read: unknown, not free.
    const corruptRoot = makeRoot();
    const corruptPath = registryIn(corruptRoot);
    mkdirSync(join(corruptPath, ".."), { recursive: true });
    writeFileSync(corruptPath, "not json", { mode: 0o600 });
    expect(sessionHoldState(corruptPath, "live-id")).toBe("unknown");
    // An untrusted placement (a symlinked registry file) reads the same
    // way: unknown — every not-ok read spares the candidate (review D5,
    // correctness 1 — the transient failure that deleted a live home).
    const linkedRoot = makeRoot();
    const linkedPath = registryIn(linkedRoot);
    mkdirSync(join(linkedPath, ".."), { recursive: true });
    seedRegistry(join(linkedRoot, "reg", "real.json"), [
      craftEntry({ id: "live-id", owner_pid: process.pid }),
    ]);
    symlinkSync(join(linkedRoot, "reg", "real.json"), linkedPath);
    expect(sessionHoldState(linkedPath, "live-id")).toBe("unknown");
  });

  test("an unreadable table and an EPERM probe mean alive, never dead (review live16)", () => {
    // Review live16, minor: the signal-0 fallback read every throw as a
    // dead process, so inside a sandbox that denies signals a live lock
    // holder or session owner looked dead and could be stolen. Only
    // ESRCH proves the pid is gone; the probe is stubbed so the test
    // does not depend on the runner's uid.
    const original = process.kill;
    const throwWith = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    try {
      process.kill = throwWith("EPERM") as typeof process.kill;
      expect(processIdentityAlive(4242, null, new Map())).toBe(true);
      process.kill = throwWith("ESRCH") as typeof process.kill;
      expect(processIdentityAlive(4242, null, new Map())).toBe(false);
    } finally {
      process.kill = original;
    }
  });
});

describe("the pre-write validation (review live16)", () => {
  test("a record the reader would reject is refused, and the registry stays readable", () => {
    // Review live16, correctness major: a harness-supplied id over the
    // reader's cap was written, the reader then rejected the whole file,
    // every resume failed closed, and the next fresh start's
    // backup-and-reset dropped every record, live owners included.
    const path = registryIn(makeRoot());
    expect(recordSessionStart(path, newRecord({ id: "keep-me" })).ok).toBe(true);
    const outcome = recordSessionStart(path, newRecord({ id: "x".repeat(MAX_ID_CHARS + 1) }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("nothing was written");
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") expect(read.file.sessions.map((entry) => entry.id)).toEqual(["keep-me"]);
  });
});

describe("recording sessions", () => {
  test("recordSessionStart writes a complete entry and updates in place", () => {
    const path = registryIn(makeRoot());
    expect(recordSessionStart(path, newRecord()).ok).toBe(true);
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome !== "ok") return;
    expect(read.file.sessions.length).toBe(1);
    const entry = read.file.sessions[0] as SessionRecord;
    expect(entry.owner_pid).toBe(process.pid);
    expect(entry.ended).toBeNull();
    expect(entry.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Same id again: one entry, created_at preserved, mode still 0600.
    expect(recordSessionStart(path, newRecord({ model: "opus" })).ok).toBe(true);
    const again = readRegistry(path);
    expect(again.outcome).toBe("ok");
    if (again.outcome !== "ok") return;
    expect(again.file.sessions.length).toBe(1);
    const updated = again.file.sessions[0] as SessionRecord;
    expect(updated.model).toBe("opus");
    expect(updated.created_at).toBe(entry.created_at);
  });

  test("a start cannot steal a live foreign owner's record (atomic claim)", async () => {
    // Review live3, correctness 2: two callers can both pass
    // lookupForResume before either spawns, and the second start-write
    // used to replace the first owner unconditionally — both sessions
    // then ran under one record, and either end stamp could free the
    // other. The claim is atomic under the writer lock: a live foreign
    // owner refuses with the same session_busy refusal resume uses (the
    // loser's driver dies through its fail-closed registry-start path),
    // and the winner's ownership survives untouched. A genuinely live
    // child process is the foreign owner — owner_start null keeps
    // liveness true in both table and signal-0 modes.
    const child = Bun.spawn(["sleep", "30"]);
    await Bun.sleep(50);
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry({ owner_pid: child.pid, owner_start: null })]);
    const outcome = recordSessionStart(path, newRecord());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("session_busy");
    }
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") {
      const entry = read.file.sessions[0] as SessionRecord;
      expect(entry.owner_pid).toBe(child.pid);
      expect(entry.ended).toBeNull();
    }
    // Once the foreign owner is gone, the same record updates in place —
    // the refused claim was a liveness refusal, not a corrupted entry.
    child.kill();
    await child.exited;
    let dead = false;
    for (let i = 0; i < 40 && !dead; i++) {
      dead = !processIdentityAlive(child.pid, null);
      if (!dead) await Bun.sleep(50);
    }
    expect(dead).toBe(true);
    expect(recordSessionStart(path, newRecord({ model: "opus" })).ok).toBe(true);
  });

  test("a start finds its own claim whatever start token the claim read (review live20)", () => {
    // claimForResume and recordSessionStart each read the process table
    // once. `ps` can time out to an empty table, so one reading may
    // carry a start token and the other null; the self check compared
    // tokens too and refused the resume's own claim as session_busy.
    // Both directions are pinned: a null token on the claim (ps failed
    // then) and a token that differs from this reading's (ps failed now,
    // or the reading changed).
    for (const claimed of [null, "Thu Jan  1 00:00:00 1970"]) {
      const path = registryIn(makeRoot());
      seedRegistry(path, [craftEntry({ owner_pid: process.pid, owner_start: claimed })]);
      const outcome = recordSessionStart(path, newRecord());
      expect(outcome).toEqual({ ok: true });
    }
  });

  test("an uncreatable registry directory fails as an outcome, never a throw", () => {
    // A regular file where the registry's directory chain needs one:
    // mkdir cannot create `<file>/reg`, and the failure must surface as
    // the designed fail-closed outcome (an EPERM'd home behaves the same
    // way) rather than escaping updateRegistry — the driver records a
    // session start from inside its harness-line handler, where a throw
    // would be misread as harness output.
    const root = makeRoot();
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory");
    const outcome = recordSessionStart(
      join(blocker, "reg", "live-sessions.json"),
      newRecord()
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("cannot update the session registry");
    }
  });

  test("a lost end stamp is reported on stderr, never dropped (review live21)", () => {
    // Correctness minor 2: the CLI's spawn-failure release discarded
    // recordSessionEnd's outcome, which carries failures as values, so a
    // lost release left no trace. Every end path now goes through
    // releaseSessionRecord, which reports the loss the drivers' way.
    const root = makeRoot();
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory");
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      releaseSessionRecord(join(blocker, "reg", "live-sessions.json"), "sess-lost");
    } finally {
      spy.mockRestore();
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("cannot stamp the session end for sess-lost");
    expect(errors[0]).toContain("session_busy");
    // A stamp that lands says nothing.
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry()]);
    const quiet = spyOn(console, "error");
    try {
      releaseSessionRecord(path, "sess-1");
      expect(quiet).not.toHaveBeenCalled();
    } finally {
      quiet.mockRestore();
    }
  });

  test("touch and end stamp last_activity; unknown ids fail", () => {
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry()]);
    expect(touchSession(path, "sess-1").ok).toBe(true);
    expect(recordSessionEnd(path, "sess-1").ok).toBe(true);
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome !== "ok") return;
    const entry = read.file.sessions[0] as SessionRecord;
    expect(entry.ended).toBe(entry.last_activity);
    expect(touchSession(path, "nope").ok).toBe(false);
    expect(recordSessionEnd(path, "nope").ok).toBe(false);
  });
});

describe("resume guards", () => {
  test("a matching dead-owner entry resumes", () => {
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry()]);
    const result = lookupForResume(path, "sess-1", probe());
    expect(result.outcome).toBe("ok");
  });

  test("missing registry or missing entry is not_found", () => {
    const path = registryIn(makeRoot());
    expect(lookupForResume(path, "sess-1", probe()).outcome).toBe("not_found");
    seedRegistry(path, [craftEntry()]);
    expect(lookupForResume(path, "other", probe()).outcome).toBe("not_found");
  });

  test("agent and harness-home mismatches refuse", () => {
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry()]);
    const agent = lookupForResume(path, "sess-1", probe({ agent: "zai" }));
    expect(agent.outcome).toBe("refused");
    if (agent.outcome === "refused") expect(agent.reason).toContain("belongs to agent");
    const home = lookupForResume(path, "sess-1", probe({ harnessHome: "/elsewhere/.claude" }));
    expect(home.outcome).toBe("refused");
    if (home.outcome === "refused") expect(home.reason).toContain("harness home");
  });

  test("the provider identity pins the endpoint a resume may replay against (review D3, security)", () => {
    // The recorded state directory does not move with the endpoint for
    // claude (~/.claude), opencode (the real data dir), or aider
    // (~/.aider), so the harness-home guard cannot carry this rule: the
    // override's base URL — or null for the operator's own login — must
    // equal the resume's, in both directions, or the transcript replays
    // on a provider the caller never chose at creation.
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry({ provider_base_url: "http://127.0.0.1:9/v1" })]);
    expect(
      lookupForResume(path, "sess-1", probe({ providerBaseUrl: "http://127.0.0.1:9/v1" })).outcome
    ).toBe("ok");
    const other = lookupForResume(path, "sess-1", probe({ providerBaseUrl: "http://127.0.0.1:10/v1" }));
    expect(other.outcome).toBe("refused");
    if (other.outcome === "refused") {
      expect(other.reason).toContain("created against the provider override at http://127.0.0.1:9/v1");
      expect(other.reason).toContain("cannot resume against the provider override at http://127.0.0.1:10/v1");
    }
    const login = lookupForResume(path, "sess-1", probe());
    expect(login.outcome).toBe("refused");
    if (login.outcome === "refused") {
      expect(login.reason).toContain("cannot resume against the operator's own login");
    }
    // The mirror: an operator-login session never runs under an override.
    seedRegistry(path, [craftEntry()]);
    const flipped = lookupForResume(path, "sess-1", probe({ providerBaseUrl: "http://127.0.0.1:9/v1" }));
    expect(flipped.outcome).toBe("refused");
    if (flipped.outcome === "refused") {
      expect(flipped.reason).toContain("created against the operator's own login");
    }
    expect(lookupForResume(path, "sess-1", probe()).outcome).toBe("ok");
  });

  test("a 0.9.0 record without the provider field reads as operator login (review D3)", () => {
    // Sessions refused every override before this field existed, so an
    // absent provider_base_url IS an operator-login record: refusing it
    // would poison every existing registry as corrupt. The read
    // normalizes it to null, and the next write persists the explicit
    // null.
    const path = registryIn(makeRoot());
    const { provider_base_url: _omit, ...legacy } = craftEntry();
    seedRegistry(path, [legacy as unknown as SessionRecord]);
    expect(readRegistry(path).outcome).toBe("ok");
    expect(lookupForResume(path, "sess-1", probe()).outcome).toBe("ok");
    expect(
      lookupForResume(path, "sess-1", probe({ providerBaseUrl: "http://127.0.0.1:9/v1" })).outcome
    ).toBe("refused");
    // Any other missing key is still corrupt, and a non-string value too.
    const { harness_home: _home, ...noHome } = craftEntry();
    seedRegistry(path, [noHome as unknown as SessionRecord]);
    expect(readRegistry(path).outcome).toBe("corrupt");
    seedRegistry(path, [craftEntry({ provider_base_url: 7 as unknown as string })]);
    expect(readRegistry(path).outcome).toBe("corrupt");
    // The normalization persists at the next write.
    seedRegistry(path, [legacy as unknown as SessionRecord]);
    expect(recordSessionStart(path, newRecord({ id: "sess-1" })).ok).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).sessions[0].provider_base_url).toBeNull();
  });

  test("containment may not drop and trust may not rise", () => {
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry({ sandboxed: true, sandbox_trust: "standard" })]);
    const drop = lookupForResume(path, "sess-1", probe({ sandboxed: false }));
    expect(drop.outcome).toBe("refused");
    if (drop.outcome === "refused") expect(drop.reason).toContain("scode");
    const rise = lookupForResume(path, "sess-1", probe({ sandboxed: true, sandboxTrust: "trusted" }));
    expect(rise.outcome).toBe("refused");
    if (rise.outcome === "refused") expect(rise.reason).toContain("trust");
    // Staying equal or narrowing is allowed.
    expect(
      lookupForResume(path, "sess-1", probe({ sandboxed: true, sandboxTrust: "untrusted" })).outcome
    ).toBe("ok");
  });

  test("a recorded --sandbox-no-net or --sandbox-scrub-env may not be cleared on resume", () => {
    // Review live4, security: the entry recorded neither flag, so a
    // session created without network (or with a scrubbed environment)
    // and fed untrusted content could be resumed with the flag gone —
    // the transcript then running with reach creation never granted.
    const path = registryIn(makeRoot());
    seedRegistry(path, [
      craftEntry({ sandboxed: true, sandbox_no_net: true, sandbox_scrub_env: true }),
    ]);
    const noNet = lookupForResume(path, "sess-1", probe({ sandboxed: true, sandboxScrubEnv: true }));
    expect(noNet.outcome).toBe("refused");
    if (noNet.outcome === "refused") expect(noNet.reason).toContain("--sandbox-no-net");
    const scrub = lookupForResume(
      path,
      "sess-1",
      probe({ sandboxed: true, sandboxNoNet: true })
    );
    expect(scrub.outcome).toBe("refused");
    if (scrub.outcome === "refused") expect(scrub.reason).toContain("--sandbox-scrub-env");
    // Both flags kept: the resume passes (nothing else refuses it).
    expect(
      lookupForResume(
        path,
        "sess-1",
        probe({ sandboxed: true, sandboxNoNet: true, sandboxScrubEnv: true })
      ).outcome
    ).toBe("ok");
    // The rule is one-directional: a session created WITHOUT the flags
    // may resume with them (adding containment only tightens).
    seedRegistry(path, [craftEntry({ id: "plain", sandboxed: true })]);
    expect(
      lookupForResume(
        path,
        "plain",
        probe({ sandboxed: true, sandboxNoNet: true, sandboxScrubEnv: true })
      ).outcome
    ).toBe("ok");
  });

  test("a resume may not change the cwd, add a --pass-env name, or turn on Playwright (review live16)", () => {
    // Review live16, security: only the sandbox flags were compared, so
    // a resume could hand a possibly injected transcript another tree, a
    // secret, or a browser that creation never granted.
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry({ pass_env: ["A_TOKEN", "B_TOKEN"], playwright_mcp: false })]);
    const moved = lookupForResume(path, "sess-1", probe({ cwd: "/somewhere/else" }));
    expect(moved.outcome).toBe("refused");
    if (moved.outcome === "refused") expect(moved.reason).toContain("cannot resume in /somewhere/else");
    const secret = lookupForResume(path, "sess-1", probe({ passEnv: ["A_TOKEN", "GITHUB_TOKEN"] }));
    expect(secret.outcome).toBe("refused");
    if (secret.outcome === "refused") expect(secret.reason).toContain("--pass-env GITHUB_TOKEN");
    const browser = lookupForResume(path, "sess-1", probe({ playwrightMcp: true }));
    expect(browser.outcome).toBe("refused");
    if (browser.outcome === "refused") expect(browser.reason).toContain("--enable-playwright-mcp");
    // One-directional: the same names, a subset, or none at all pass.
    for (const passEnv of [["B_TOKEN", "A_TOKEN"], ["A_TOKEN"], []]) {
      expect(lookupForResume(path, "sess-1", probe({ passEnv })).outcome).toBe("ok");
    }
    // A record created with the MCP may resume with or without it.
    seedRegistry(path, [craftEntry({ id: "pw", playwright_mcp: true })]);
    expect(lookupForResume(path, "pw", probe({ playwrightMcp: true })).outcome).toBe("ok");
    expect(lookupForResume(path, "pw", probe()).outcome).toBe("ok");
  });

  test("the start record stores the --pass-env names sorted, never values (review live16)", () => {
    const path = registryIn(makeRoot());
    expect(recordSessionStart(path, newRecord({ pass_env: ["Z_TOKEN", "A_TOKEN"] })).ok).toBe(true);
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") expect(read.file.sessions[0]?.pass_env).toEqual(["A_TOKEN", "Z_TOKEN"]);
  });

  test("the autonomy ladder is ranked by reach, not by name", () => {
    const path = registryIn(makeRoot());
    const cases: Array<{
      created: AutonomyLevel;
      resume: AutonomyLevel;
      ok: boolean;
    }> = [
      { created: "read-only", resume: "medium", ok: false },
      { created: "read-only", resume: "read-only", ok: true },
      { created: "medium", resume: "read-only", ok: true },
      { created: "medium", resume: "high", ok: false },
      { created: "high", resume: "low", ok: false },
      { created: "high", resume: "medium", ok: true },
      { created: "low", resume: "high", ok: true },
      { created: "low", resume: "low", ok: true },
    ];
    for (const { created, resume, ok } of cases) {
      seedRegistry(path, [craftEntry({ autonomy: created })]);
      const result = lookupForResume(path, "sess-1", probe({ autonomy: resume }));
      expect(result.outcome).toBe(ok ? "ok" : "refused");
      if (!ok && result.outcome === "refused") {
        expect(result.reason).toContain("autonomy");
      }
    }
  });

  test("the agy autonomy ladder is strict: no resume above creation", () => {
    // Review live9, security 1: agy has no permission round-trip
    // (`permissions: false` — approvals become soft denials headless), so
    // its low has the LEAST reach of the three flag levels (low = no mode
    // flag, medium = `--mode=accept-edits`, high =
    // `--dangerously-skip-permissions`). The claude/codex ranking (low
    // out-reaches high, because a low caller approves everything) applied
    // to agy let a session created at low resume at high — the bypass
    // flag — and low→medium the same way.
    const path = registryIn(makeRoot());
    const cases: Array<{ created: AutonomyLevel; resume: AutonomyLevel; ok: boolean }> = [
      { created: "low", resume: "high", ok: false }, // the finding's escalation
      { created: "low", resume: "medium", ok: false },
      { created: "medium", resume: "high", ok: false },
      { created: "read-only", resume: "low", ok: false },
      { created: "high", resume: "medium", ok: true },
      { created: "low", resume: "low", ok: true },
      { created: "read-only", resume: "read-only", ok: true },
    ];
    for (const { created, resume, ok } of cases) {
      seedRegistry(path, [craftEntry({ agent: "agy", autonomy: created })]);
      const result = lookupForResume(path, "sess-1", probe({ agent: "agy", autonomy: resume }));
      expect(result.outcome).toBe(ok ? "ok" : "refused");
      if (!ok && result.outcome === "refused") {
        expect(result.reason).toContain("autonomy");
      }
    }
    // Contrast, pinned for the claude family: low→high stays resumable —
    // a low caller can approve anything, so resuming at high narrows.
    seedRegistry(path, [craftEntry({ agent: "claude", autonomy: "low" })]);
    expect(
      lookupForResume(path, "sess-1", probe({ agent: "claude", autonomy: "high" })).outcome
    ).toBe("ok");
  });

  test("opencode's and aider's adjacent autonomy ties still refuse an upward resume (review D1, 2.1)", () => {
    // opencode's low and medium both spawn `--agent build`, and aider's
    // medium and high both spawn `--yes-always` — each ladder has one
    // adjacent tie, so the strict ranking refuses a resume into a level
    // whose command is byte-identical to the recorded one. The refusal is
    // the intended conservatism (a refused byte-identical resume costs a
    // retry at the recorded level; a folded tie could never be proven
    // narrow), and this test plus the flag pins keep the ranking and the
    // ties honest against each other.
    expect(opencodeSessionAutonomyFlags("low")).toEqual(["--agent", "build"]);
    expect(opencodeSessionAutonomyFlags("medium")).toEqual(["--agent", "build"]);
    expect(aiderSessionAutonomyFlags("medium")).toEqual(["--yes-always"]);
    expect(aiderSessionAutonomyFlags("high")).toEqual(["--yes-always"]);
    const path = registryIn(makeRoot());
    const cases: Array<{ agent: "opencode" | "aider"; created: AutonomyLevel; resume: AutonomyLevel }> = [
      { agent: "aider", created: "medium", resume: "high" }, // byte-identical command, still refused
      { agent: "opencode", created: "low", resume: "medium" }, // the same shape on the other ladder
    ];
    for (const { agent, created, resume } of cases) {
      seedRegistry(path, [craftEntry({ agent, autonomy: created })]);
      const result = lookupForResume(path, "sess-1", probe({ agent, autonomy: resume }));
      expect(result.outcome).toBe("refused");
      if (result.outcome === "refused") {
        expect(result.reason).toContain("autonomy");
      }
      // The same-level resume stays open: the tie costs nothing downward.
      expect(
        lookupForResume(path, "sess-1", probe({ agent, autonomy: created })).outcome
      ).toBe("ok");
    }
  });

  test("hermetic provenance must match", () => {
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry({ hermetic: true })]);
    expect(lookupForResume(path, "sess-1", probe()).outcome).toBe("refused");
    expect(lookupForResume(path, "sess-1", probe({ hermetic: true })).outcome).toBe("ok");
  });

  test("a live owner refuses with session_busy; an ended session does not", async () => {
    // A live foreign process is the owner: this process's own pid is
    // exempt (review live25, the test below).
    const child = Bun.spawn(["sleep", "30"]);
    try {
      await Bun.sleep(50);
      const path = registryIn(makeRoot());
      seedRegistry(path, [
        craftEntry({ id: "alive", owner_pid: child.pid }),
        craftEntry({ id: "done", owner_pid: child.pid, ended: "2026-10-05T11:00:00.000Z" }),
      ]);
      const busy = lookupForResume(path, "alive", probe());
      expect(busy.outcome).toBe("refused");
      if (busy.outcome === "refused") expect(busy.reason).toContain("session_busy");
      expect(lookupForResume(path, "done", probe()).outcome).toBe("ok");
    } finally {
      child.kill();
    }
  });

  test("a record naming this process's own pid as live owner is not busy (review live25)", () => {
    // Review live25, correctness-2 minor 9: recordSessionStart exempts its
    // own pid, judgeResumeEntry did not, so a reused pid's stale unended
    // record (start token null) refused every resume from that pid.
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry({ id: "mine", owner_pid: process.pid, owner_start: null })]);
    expect(lookupForResume(path, "mine", probe()).outcome).toBe("ok");
    expect(claimForResume(path, "mine", probe()).outcome).toBe("ok");
  });

  test("a registry inside the entry's cwd or harness home is untrusted", () => {
    const root = makeRoot();
    const path = registryIn(root);
    seedRegistry(path, [craftEntry({ id: "in-cwd", cwd: root })]);
    const inCwd = lookupForResume(path, "in-cwd", probe({ cwd: root }));
    expect(inCwd.outcome).toBe("untrusted");
    if (inCwd.outcome === "untrusted") expect(inCwd.reason).toContain("cwd");
    seedRegistry(path, [
      craftEntry({ id: "in-home", harness_home: root }),
    ]);
    const inHome = lookupForResume(path, "in-home", probe({ harnessHome: root }));
    expect(inHome.outcome).toBe("untrusted");
    if (inHome.outcome === "untrusted") expect(inHome.reason).toContain("harness home");
  });

  test("a root cwd or harness home contains every registry placement", () => {
    // Review live7, security 3: the containment prefix for a root scope
    // was `//`, which no real path starts with, so `--cwd /` reported
    // the registry as outside the writable set — both the start-time
    // refusal and this untrusted check let a registry that sat inside
    // the harness's writable scope through. A root scope contains every
    // absolute path, the same rule the ceiling's scope check carries.
    const path = registryIn(makeRoot());
    expect(registryInside(path, "/")).toBe(true);
    seedRegistry(path, [craftEntry({ id: "at-root", cwd: "/" })]);
    const atRoot = lookupForResume(path, "at-root", probe({ cwd: "/" }));
    expect(atRoot.outcome).toBe("untrusted");
    if (atRoot.outcome === "untrusted") expect(atRoot.reason).toContain("cwd");
    // The harness-home half the name promises (review live25: the body
    // exercised only the cwd side).
    seedRegistry(path, [craftEntry({ id: "home-root", harness_home: "/" })]);
    const homeRoot = lookupForResume(path, "home-root", probe({ harnessHome: "/" }));
    expect(homeRoot.outcome).toBe("untrusted");
    if (homeRoot.outcome === "untrusted") expect(homeRoot.reason).toContain("harness home");
  });
});

describe("failure policy", () => {
  test("a corrupt registry fails resume closed", () => {
    const path = registryIn(makeRoot());
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "not json at all", { mode: 0o600 });
    const result = lookupForResume(path, "sess-1", probe());
    expect(result.outcome).toBe("untrusted");
    if (result.outcome === "untrusted") expect(result.reason).toContain("corrupt");
  });

  test("a shape-valid but wrong registry is corrupt, not ok", () => {
    const path = registryIn(makeRoot());
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, '{"version":2,"sessions":[]}', { mode: 0o600 });
    expect(readRegistry(path).outcome).toBe("corrupt");
    writeFileSync(path, '{"version":1,"sessions":[{"id":"x"}]}', { mode: 0o600 });
    expect(readRegistry(path).outcome).toBe("corrupt");
  });

  test("prototype-chain spellings of the enum fields are corrupt, not ranks", () => {
    // Review live11, minor 6: validation used `in`, and `"constructor"
    // in AUTONOMY_REACH` is true through the prototype chain — so a
    // tampered record carrying autonomy "toString" or sandbox_trust
    // "constructor" validated, and the trust guard then compared
    // TRUST_RANK["constructor"] (a function, so NaN) against a number:
    // never greater, so a trusted resume above the recorded trust was
    // never refused. Object.hasOwn makes such records corrupt, which
    // fails the resume closed.
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry({ id: "proto-trust", sandbox_trust: "constructor" as SandboxTrust })]);
    expect(readRegistry(path).outcome).toBe("corrupt");
    const refused = lookupForResume(path, "proto-trust", probe());
    expect(refused.outcome).toBe("untrusted");
    if (refused.outcome === "untrusted") expect(refused.reason).toContain("corrupt");

    const otherPath = registryIn(makeRoot());
    seedRegistry(otherPath, [craftEntry({ id: "proto-auto", autonomy: "toString" as AutonomyLevel })]);
    expect(readRegistry(otherPath).outcome).toBe("corrupt");
  });

  test("the next new session backs the corrupt file up and starts fresh", () => {
    const path = registryIn(makeRoot());
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{corrupt", { mode: 0o600 });
    expect(recordSessionStart(path, newRecord()).ok).toBe(true);
    const dir = join(path, "..");
    const backups = readdirSync(dir).filter((name) => name.startsWith("live-sessions.json.corrupt-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(dir, backups[0] as string), "utf8")).toBe("{corrupt");
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") expect(read.file.sessions.length).toBe(1);
    // Updates against a still-corrupt registry fail rather than reset.
    const again = registryIn(makeRoot());
    mkdirSync(join(again, ".."), { recursive: true });
    writeFileSync(again, "{corrupt", { mode: 0o600 });
    expect(touchSession(again, "sess-1").ok).toBe(false);
  });
});

describe("placement checks", () => {
  test("a healthy file passes; wrong mode, a symlinked registry directory, and a symlinked file fail", () => {
    const root = makeRoot();
    const path = registryIn(root);
    seedRegistry(path, [craftEntry()]);
    expect(readRegistry(path).outcome).toBe("ok");

    chmodSync(path, 0o644);
    const loose = readRegistry(path);
    expect(loose.outcome).toBe("untrusted");
    if (loose.outcome === "untrusted") expect(loose.reason).toContain("0600");

    // The symlink is the registry's own directory — a leaf, not an
    // ancestor — so it is refused on the original spelling; genuine
    // symlinked ancestors are resolved away (pinned by the test below).
    const linkRoot = makeRoot();
    const realDir = join(linkRoot, "real");
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, join(linkRoot, "link"));
    const throughLink = join(linkRoot, "link", "live-sessions.json");
    seedRegistry(throughLink, [craftEntry()]);
    const leafDir = readRegistry(throughLink);
    expect(leafDir.outcome).toBe("untrusted");
    if (leafDir.outcome === "untrusted") expect(leafDir.reason).toContain("symbolic link");

    const leafLinkRoot = makeRoot();
    const leafReal = join(leafLinkRoot, "file.json");
    writeFileSync(leafReal, "{}", { mode: 0o600 });
    const leafPath = join(leafLinkRoot, "link.json");
    symlinkSync(leafReal, leafPath);
    const leaf = readRegistry(leafPath);
    expect(leaf.outcome).toBe("untrusted");

    const wideDir = makeRoot();
    const widePath = join(wideDir, "live-sessions.json");
    mkdirSync(wideDir, { recursive: true });
    // chmod, not mkdir's mode: the process umask would strip the bits.
    chmodSync(wideDir, 0o770);
    const wide = readRegistry(widePath);
    expect(wide.outcome).toBe("untrusted");
  });

  test("a missing registry is a clean missing, not untrusted", () => {
    const root = makeRoot();
    expect(readRegistry(registryIn(root)).outcome).toBe("missing");
  });

  test("a symlinked ancestor resolves; the registry lands in the real directory", () => {
    // The macOS `/var -> /private/var` class: a registry reached through
    // a symlinked ancestor of its own directory (not a symlinked leaf)
    // must work — the ancestor is resolved away, never refused — and the
    // file must land in the real directory, with the link spelling
    // reading back the same registry.
    const real = makeRoot();
    const linkParent = makeRoot();
    const link = join(linkParent, "home-link");
    symlinkSync(real, link);
    const throughLink = join(link, "reg", "live-sessions.json");
    const outcome = recordSessionStart(throughLink, newRecord());
    expect(outcome.ok).toBe(true);
    const landed = join(real, "reg", "live-sessions.json");
    expect(existsSync(landed)).toBe(true);
    expect(existsSync(join(linkParent, "reg"))).toBe(false);
    const read = readRegistry(landed);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") expect(read.file.sessions.length).toBe(1);
    expect(readRegistry(throughLink).outcome).toBe("ok");
  });
});

describe("the writer lock", () => {
  /** Seed a held-format lock file directly: `<pid>\n<start>\n` under a
   * never-reused held name, the shape acquireLock itself creates. */
  function seedHeldLock(lockPath: string, pid: number, start: string | null, salt: string): string {
    const path = join(
      dirname(lockPath),
      `.${basename(lockPath)}.${pid}.${salt}.held`
    );
    writeFileSync(path, `${pid}\n${start ?? ""}\n`, { mode: 0o600 });
    return path;
  }

  test("a touch on the turn-path budget never waits behind a live writer (review live13)", () => {
    const root = makeRoot();
    const path = registryIn(root);
    expect(recordSessionStart(path, newRecord()).ok).toBe(true);
    // Hold the writer lock from this (live) process, the way a concurrent
    // codemux registry write would.
    const handle = acquireLock(`${path}.lock`, { attempts: 1 });
    try {
      const began = Date.now();
      const outcome = touchSession(path, "sess-1", { attempts: 1 });
      const elapsed = Date.now() - began;
      // Fail fast AND report it: the pre-fix call ran the default budget
      // (40 sleeps of 250 ms plus jitter — about 10 s of Atomics.wait on
      // the main thread) before failing; the turn path must instead take
      // one sweep and return.
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toMatch(/live writer/);
      expect(elapsed).toBeLessThan(1_000);
    } finally {
      handle.release();
    }
    // Contention was the only problem: with the lock free again, the same
    // single-attempt touch succeeds.
    expect(touchSession(path, "sess-1", { attempts: 1 }).ok).toBe(true);
  });

  test("acquire and release round-trip; a stale lock is stolen", () => {
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    const handle = acquireLock(lockPath, { attempts: 1 });
    const held = listHeldLocks(lockPath);
    expect(held.length).toBe(1);
    expect(held[0]!.holder?.pid).toBe(process.pid);
    expect(existsSync(held[0]!.path)).toBe(true);
    handle.release();
    expect(listHeldLocks(lockPath)).toHaveLength(0);

    // A lock whose holder is dead is stale, not blocking.
    seedHeldLock(lockPath, DEAD_PID, null, "0bad1");
    const stolen = acquireLock(lockPath, { attempts: 1 });
    const after = listHeldLocks(lockPath);
    expect(after.length).toBe(1);
    expect(after[0]!.holder?.pid).not.toBe(DEAD_PID);
    stolen.release();
    expect(listHeldLocks(lockPath)).toHaveLength(0);
  });

  test("a lock create the directory denies is thrown at once, never blamed on a live writer (review live25)", () => {
    // Review live25, correctness-2 major 1: every openSync failure was
    // read as contention, so a read-only registry directory slept the
    // full default budget (about 10 s) and then reported a live holder.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    chmodSync(root, 0o500);
    try {
      const began = Date.now();
      let message = "";
      try {
        acquireLock(lockPath);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("cannot create the session registry lock");
      expect(message).toContain("EACCES");
      expect(message).not.toMatch(/live writer/);
      expect(Date.now() - began).toBeLessThan(1_000);
    } finally {
      chmodSync(root, 0o700);
    }
  });

  test("a dead holder's lock the directory will not let go is thrown at once (review live25 sibling)", () => {
    // The sweep's sibling: a failed unlink of a dead corpse marked the
    // sweep blocked, so the same denied directory waited the budget and
    // blamed a live writer.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    seedHeldLock(lockPath, DEAD_PID, null, "dead25");
    chmodSync(root, 0o500);
    try {
      const began = Date.now();
      expect(() => acquireLock(lockPath)).toThrow(/cannot remove the dead session registry lock/);
      expect(Date.now() - began).toBeLessThan(1_000);
    } finally {
      chmodSync(root, 0o700);
    }
  });

  test("a live holder blocks within the bounded retry budget", () => {
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    seedHeldLock(lockPath, process.pid, null, "1e7e");
    expect(() => acquireLock(lockPath, { attempts: 2, retryMs: 5 })).toThrow(/live writer/);
  });

  test("two writers that both observe a stale lock cannot both acquire it", () => {
    // Review live9, correctness 1: the steal used to unlink a reused
    // lock pathname, so writer B's fresh lock sat where writer A had
    // verified a corpse — A's late unlink removed B's live lock and both
    // held it. Held names are never reused: B's steal consumes the stale
    // file itself, so an A that verified it earlier finds nothing left
    // to unlink, and blocks behind B's live lock instead.
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    const staleName = seedHeldLock(lockPath, DEAD_PID, null, "07a1e");
    // B acquires first; its sweep steals the corpse by that exact name.
    const b = acquireLock(lockPath, { attempts: 1 });
    expect(existsSync(staleName)).toBe(false);
    expect(listHeldLocks(lockPath)).toHaveLength(1);
    // A, arriving with its own stale observation, must not clear B.
    expect(() => acquireLock(lockPath, { attempts: 1, retryMs: 5 })).toThrow(/live writer/);
    const stillHeld = listHeldLocks(lockPath);
    expect(stillHeld).toHaveLength(1);
    expect(existsSync(stillHeld[0]!.path)).toBe(true);
    // With B gone, A acquires cleanly.
    b.release();
    const a = acquireLock(lockPath, { attempts: 1 });
    expect(listHeldLocks(lockPath)).toHaveLength(1);
    a.release();
    expect(listHeldLocks(lockPath)).toHaveLength(0);
  });

  test("losing the steal of a dead holder to another writer is not contention (review live20)", () => {
    // Two writers that both judge the same corpse dead both unlink it;
    // the loser's unlink fails ENOENT. That used to mark the sweep
    // blocked, so a single-attempt acquisition (the per-turn touch)
    // failed although the lock was free. The spy removes the corpse just
    // before the real unlink, which is exactly the loser's view.
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    const corpse = seedHeldLock(lockPath, DEAD_PID, null, "5ea1ed");
    const realUnlink = fs.unlinkSync;
    const spy = spyOn(fs, "unlinkSync").mockImplementation(((target: fs.PathLike) => {
      if (target === corpse) realUnlink(target);
      realUnlink(target);
    }) as typeof fs.unlinkSync);
    let handle: ReturnType<typeof acquireLock> | null = null;
    try {
      handle = acquireLock(lockPath, { attempts: 1, retryMs: 5 });
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(corpse)).toBe(false);
    expect(listHeldLocks(lockPath).map((held) => held.holder?.pid)).toEqual([process.pid]);
    handle.release();
    expect(listHeldLocks(lockPath)).toHaveLength(0);
  });

  test("losing a confirm-time steal to another writer is not a conflict either (review live20)", () => {
    // The sweep's sibling in the post-create confirm: a dead rival that
    // appeared between the sweep and the create is stolen there, and an
    // ENOENT from a writer that stole it first released our claim as if
    // a live rival had won. The openSync spy plants the corpse at our
    // create; the unlinkSync spy removes it just before the real unlink.
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    const corpse = join(root, `.live-sessions.json.lock.${DEAD_PID}.c0ff1e.held`);
    const realOpen = fs.openSync;
    const realUnlink = fs.unlinkSync;
    const openSpy = spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (flags === "wx" && !existsSync(corpse)) {
        writeFileSync(corpse, `${DEAD_PID}\n\n`, { mode: 0o600 });
      }
      return realOpen(target, flags, mode);
    }) as typeof fs.openSync);
    const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation(((target: fs.PathLike) => {
      if (target === corpse) realUnlink(target);
      realUnlink(target);
    }) as typeof fs.unlinkSync);
    let handle: ReturnType<typeof acquireLock> | null = null;
    try {
      handle = acquireLock(lockPath, { attempts: 1, retryMs: 5 });
    } finally {
      openSpy.mockRestore();
      unlinkSpy.mockRestore();
    }
    expect(existsSync(corpse)).toBe(false);
    expect(listHeldLocks(lockPath).map((held) => held.holder?.pid)).toEqual([process.pid]);
    handle.release();
  });

  test("an unjudgeable held file with a live name-pid blocks and is never stolen", () => {
    // Fail closed: a held file whose payload cannot be judged (junk
    // content, or an unreadable file) is treated as live while its
    // name-encoded pid is live — the bounded budget decides, and the
    // file is still there afterwards. (A dead name-pid is the other
    // arm, review live14: such a corpse is stealable — pinned below.)
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    const junkPath = join(root, `.live-sessions.json.lock.${process.pid}.ff00d.held`);
    writeFileSync(junkPath, "junk\n", { mode: 0o600 });
    expect(() => acquireLock(lockPath, { attempts: 1, retryMs: 5 })).toThrow(/live writer/);
    expect(existsSync(junkPath)).toBe(true);
    expect(listHeldLocks(lockPath)).toEqual([{ path: junkPath, holder: null }]);
  });

  test("a held file a dead acquirer left unjudgeable is stolen, not a permanent block", () => {
    // Review live14: the lock create writes the file before the payload,
    // so a process killed between the two (or a write that died on
    // ENOSPC) left a corpse whose payload cannot be judged. Pre-fix it
    // read as `unknown` forever — never stolen — and every later
    // registry write failed its full retry budget until someone deleted
    // the file by hand: no session could start, stamp, or end. The pid
    // in the never-reused name is the fallback: dead (an empty corpse,
    // junk content — any unjudgeable payload) means the file can only
    // be that failed acquisition's leftover, so the steal that consumes
    // the exact name is sound.
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    const corpse = join(root, `.live-sessions.json.lock.${DEAD_PID}.0dd1e5.held`);
    writeFileSync(corpse, "", { mode: 0o600 });
    const handle = acquireLock(lockPath, { attempts: 1 });
    // The corpse was consumed by the steal; our own held file is the
    // only one left, and a follow-up write is uncontended.
    expect(existsSync(corpse)).toBe(false);
    const held = listHeldLocks(lockPath);
    expect(held).toHaveLength(1);
    expect(held[0]!.holder?.pid).toBe(process.pid);
    handle.release();
    expect(listHeldLocks(lockPath)).toHaveLength(0);
  });
});

describe("pruning", () => {
  test("prune keeps 1000 by last_activity and never evicts a live owner", () => {
    const root = makeRoot();
    const path = registryIn(root);
    const sessions: SessionRecord[] = [];
    // 999 stale entries plus the live-owner survivor: 1000 total, so the
    // seeded file is valid; recording one more pushes it over the bound.
    for (let i = 0; i < REGISTRY_MAX_ENTRIES - 1; i++) {
      sessions.push(
        craftEntry({
          id: `old-${i}`,
          last_activity: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
        })
      );
    }
    // Oldest of all, but its owner is us: live, so it must survive.
    sessions.push(
      craftEntry({
        id: "live-oldest",
        last_activity: "2025-01-01T00:00:00.000Z",
        owner_pid: process.pid,
      })
    );
    seedRegistry(path, sessions);
    expect(recordSessionStart(path, newRecord({ id: "fresh" })).ok).toBe(true);
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome !== "ok") return;
    expect(read.file.sessions.length).toBe(REGISTRY_MAX_ENTRIES);
    const ids = new Set(read.file.sessions.map((entry) => entry.id));
    expect(ids.has("fresh")).toBe(true);
    expect(ids.has("live-oldest")).toBe(true);
    expect(ids.has("old-0")).toBe(false);
    expect(ids.has("old-1")).toBe(true);
  });

  test("an all-live overflow still prunes to a file the validator accepts (review live13)", () => {
    const root = makeRoot();
    const path = registryIn(root);
    const sessions: SessionRecord[] = [];
    // Exactly REGISTRY_MAX_ENTRIES entries, every one owned by a live
    // process (us), so recording one more crosses the bound with no
    // evictable entry in sight.
    for (let i = 0; i < REGISTRY_MAX_ENTRIES; i++) {
      sessions.push(
        craftEntry({
          id: `live-${i}`,
          last_activity: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
          owner_pid: process.pid,
        })
      );
    }
    seedRegistry(path, sessions);
    const began = Date.now();
    const outcome = recordSessionStart(path, newRecord({ id: "fresh" }));
    const elapsed = Date.now() - began;
    expect(outcome.ok).toBe(true);
    // The liveness judgments share one process-table snapshot; without
    // it, this one call enumerates the host's processes once per live
    // owner (a thousand spawns inside the held writer lock).
    expect(elapsed).toBeLessThan(8_000);
    // The writer must never leave a file its own validator rejects:
    // more than REGISTRY_MAX_ENTRIES reads as corrupt on the next open,
    // which fails every resume closed and makes the next start back the
    // file up and reset it — dropping the records of every live session.
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome !== "ok") return;
    expect(read.file.sessions.length).toBe(REGISTRY_MAX_ENTRIES);
    const ids = new Set(read.file.sessions.map((entry) => entry.id));
    expect(ids.has("fresh")).toBe(true);
    // The overflow falls on the oldest entry even though its owner is
    // live: a lookup hint evicted answers not_found, the smaller loss.
    expect(ids.has("live-0")).toBe(false);
    expect(ids.has("live-1")).toBe(true);
  });
});

describe("review live18", () => {
  test("the writer refuses a symlinked registry directory the reader refuses", () => {
    // Correctness 3: updateRegistry resolved the path before reading, so
    // the leaf symlink check never saw the link. Every session recorded
    // fine and none could resume (the reader said "symbolic link").
    const linkRoot = makeRoot();
    const realDir = join(linkRoot, "real");
    mkdirSync(realDir, { recursive: true, mode: 0o700 });
    symlinkSync(realDir, join(linkRoot, "link"));
    const throughLink = join(linkRoot, "link", "live-sessions.json");
    const outcome = recordSessionStart(throughLink, newRecord());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("symbolic link");
    expect(existsSync(join(realDir, "live-sessions.json"))).toBe(false);
  });

  test("an oversize registry is corrupt, so the next start backs it up instead of failing forever", () => {
    // Minor: a file over the 4 MiB cap read as untrusted, which the start
    // path never recovers, so every new session failed until someone
    // deleted it.
    const path = registryIn(makeRoot());
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, " ".repeat(4 * 1024 * 1024 + 1), { mode: 0o600 });
    expect(readRegistry(path).outcome).toBe("corrupt");
    expect(recordSessionStart(path, newRecord()).ok).toBe(true);
    expect(readRegistry(path).outcome).toBe("ok");
    const backups = readdirSync(dirname(path)).filter((name) => name.includes(".corrupt-"));
    expect(backups).toHaveLength(1);
  });

  test("the writer prunes to the byte cap, never writing a file the reader rejects", () => {
    // Minor, the writer half: only the entry count was enforced, so long
    // records could push the file past 4 MiB, which the reader refused.
    const path = registryIn(makeRoot());
    const sessions: SessionRecord[] = [];
    for (let i = 0; i < 700; i++) {
      sessions.push(
        craftEntry({
          id: `long-${i}`,
          cwd: `/${"d".repeat(5000)}`,
          last_activity: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
        })
      );
    }
    seedRegistry(path, sessions);
    expect(readRegistry(path).outcome).toBe("ok");
    expect(recordSessionStart(path, newRecord({ id: "fresh", cwd: `/${"f".repeat(400_000)}` })).ok).toBe(true);
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome !== "ok") return;
    const ids = new Set(read.file.sessions.map((entry) => entry.id));
    expect(ids.has("fresh")).toBe(true);
    expect(ids.has("long-0")).toBe(false);
    expect(ids.has("long-699")).toBe(true);
  });

  test("a failed registry write removes its temp file and leaves the registry intact", () => {
    // Minor: a writeSync failure (ENOSPC) left the temp file behind.
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry()]);
    const before = readFileSync(path, "utf8");
    expect(() =>
      writeRegistryAtomic(path, "{}\n", () => {
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      })
    ).toThrow("ENOSPC");
    expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("registry failure classes (review live22)", () => {
  test("a claim that cannot reach the registry is unavailable, not untrusted", () => {
    // Correctness major 3: an I/O failure inside the claim's locked
    // update (a busy lock, ENOSPC, EACCES; here a file where the
    // registry's directory must be) came back "untrusted", which the CLI
    // maps to 78, the permanent policy refusal. Nothing was judged, so it
    // is unavailable now, and the CLI exits 1 as a fresh session does.
    const root = makeRoot();
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory");
    const result = claimForResume(join(blocker, "reg", "live-sessions.json"), "sess-1", probe());
    expect(result.outcome).toBe("unavailable");
    // A registry codemux will not vouch from stays untrusted.
    const path = registryIn(makeRoot());
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, "not json at all", { mode: 0o600 });
    expect(claimForResume(path, "sess-1", probe()).outcome).toBe("untrusted");
  });

  test("a transient read failure is unavailable for resume, never the 78 refusal", () => {
    // Sibling of major 3 on the unlocked lookup: descriptor exhaustion
    // (EMFILE) while reading a healthy registry was classed "untrusted".
    const path = registryIn(makeRoot());
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, '{"version":1,"sessions":[]}', { mode: 0o600 });
    const realOpen = fs.openSync;
    const openSpy = spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (String(target) === fs.realpathSync(path)) {
        throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
      }
      return realOpen(target, flags, mode);
    }) as typeof fs.openSync);
    try {
      expect(readRegistry(path).outcome).toBe("unavailable");
      expect(lookupForResume(path, "sess-1", probe()).outcome).toBe("unavailable");
    } finally {
      openSpy.mockRestore();
    }
    expect(lookupForResume(path, "sess-1", probe()).outcome).toBe("not_found");
  });

  test("the start probe refuses an untrusted or unreachable registry and accepts a fresh one", () => {
    // Correctness major 4: a fresh agy session runs its first turn before
    // its id exists, so the registry is proven writable before the spawn.
    const fresh = registryIn(makeRoot());
    expect(probeRegistryForStart(fresh).ok).toBe(true);
    const wide = registryIn(makeRoot());
    mkdirSync(join(wide, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(wide, '{"version":1,"sessions":[]}', { mode: 0o600 });
    chmodSync(wide, 0o644);
    const refused = probeRegistryForStart(wide);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.kind).toBe("untrusted");
    const root = makeRoot();
    writeFileSync(join(root, "blocker"), "x");
    const blocked = probeRegistryForStart(join(root, "blocker", "reg", "live-sessions.json"));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.kind).toBe("unavailable");
  });
});

describe("review live23", () => {
  test("a dead acquirer's lock file with invalid UTF-8 is stolen like any junk", () => {
    // Audit sibling of contracts major 2: the strict decode threw, and
    // the lock reader classed that `unknown` (never stolen), so the bytes
    // blocked every registry write until someone deleted the file.
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    const corpse = join(root, `.live-sessions.json.lock.${DEAD_PID}.badb17.held`);
    writeFileSync(corpse, Buffer.from([0xff, 0xfe, 0x0a]), { mode: 0o600 });
    const handle = acquireLock(lockPath, { attempts: 1 });
    expect(existsSync(corpse)).toBe(false);
    handle.release();
  });

  test("an invalid-UTF-8 registry is corrupt, so the next start backs it up and resets", () => {
    // Contracts major 2: the strict decode threw a code-less error, which
    // the reader classed untrusted. Every start and resume was then
    // refused 78 until someone deleted the file by hand.
    const path = registryIn(makeRoot());
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), { mode: 0o600 });
    expect(readRegistry(path).outcome).toBe("corrupt");
    expect(lookupForResume(path, "sess-1", probe()).outcome).toBe("untrusted");
    expect(recordSessionStart(path, newRecord()).ok).toBe(true);
    expect(readRegistry(path).outcome).toBe("ok");
    const backups = readdirSync(dirname(path)).filter((name) => name.includes(".corrupt-"));
    expect(backups).toHaveLength(1);
  });

  test("a dangling symlink at the registry directory is refused as untrusted, naming the link", () => {
    // Contracts minor 4: `existsSync` follows links, so a dangling link
    // read as "nothing exists yet", skipped the symlink refusal, and the
    // write then failed as "unavailable" on every start. The registry
    // file's own existence check had the same shape.
    const root = makeRoot();
    symlinkSync(join(root, "gone"), join(root, "reg"));
    const path = join(root, "reg", "live-sessions.json");
    const outcome = recordSessionStart(path, newRecord());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("untrusted");
      expect(outcome.error).toContain("symbolic link");
    }
    const fileRoot = makeRoot();
    const filePath = registryIn(fileRoot);
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    symlinkSync(join(fileRoot, "gone"), filePath);
    const fileOutcome = recordSessionStart(filePath, newRecord());
    expect(fileOutcome.ok).toBe(false);
    if (!fileOutcome.ok) {
      expect(fileOutcome.kind).toBe("untrusted");
      expect(fileOutcome.error).toContain("the registry is a symbolic link");
    }
  });
});
