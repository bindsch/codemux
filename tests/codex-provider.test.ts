import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  codexProviderSessionsParent,
  codexSessionProviderHomePath,
  createCodexSessionProviderHome,
  openCodexSessionProviderHome,
  writeCodexProviderConfigInto,
} from "../src/codex-provider.js";
import { MTIME_WALK_ENTRY_CAP, prepareRunDirParent } from "../src/hermetic-home.js";
import { sessionHoldState } from "../src/session/registry.js";

// The provider-override homes under review D1: the session-keyed CODEX_HOME
// (one directory per session, never shared) and the atomic config.toml
// write that cannot follow a symlink the sandboxed child planted.

const OVERRIDE = {
  baseUrl: "http://127.0.0.1:9/v1",
  apiKey: "unit-key",
  maxContextTokens: 32768,
};
const MODEL = "clawvm-qwen32b-coder";
const SESSION_ID = "0123456789abcdef";

function makeCodexHome(): string {
  return mkdtempSync(join(tmpdir(), "cmx-codprov-"));
}

const isRegularFile = (path: string): boolean => lstatSync(path).isFile();

/** A file outside the home a planted symlink could have pointed at, in
 * its own tmpdir root so a recursive rm of the home can never reach it. */
function canaryOutside(): string {
  const path = join(mkdtempSync(join(tmpdir(), "cmx-codprov-out-")), "zshrc");
  writeFileSync(path, "untouched");
  return path;
}

describe("codex provider session homes (review D1)", () => {
  test("the session home path is keyed by endpoint hash AND session id", () => {
    const home = makeCodexHome();
    const a = codexSessionProviderHomePath(home, "http://a.example/v1", SESSION_ID);
    const b = codexSessionProviderHomePath(home, "http://b.example/v1", SESSION_ID);
    const other = codexSessionProviderHomePath(home, "http://a.example/v1", "fedcba9876543210");
    expect(basename(a)).toMatch(new RegExp(`^session-home-[0-9a-f]{12}-${SESSION_ID}$`));
    expect(a).not.toBe(b); // two endpoints never share
    expect(a).not.toBe(other); // two sessions never share
    expect(dirname(a)).toBe(codexProviderSessionsParent(home));
  });

  test("the endpoint hash reads the base URL's identity form, so a rotated query key keeps the home (review D10, security)", () => {
    // A gateway key can ride the base URL's query; the home key must not
    // vary with credentials (key rotation would strand the recorded home
    // and break every later resume), and the hash never embeds the key.
    const home = makeCodexHome();
    const plain = codexSessionProviderHomePath(home, "http://a.example/v1", SESSION_ID);
    expect(codexSessionProviderHomePath(home, "http://a.example/v1?key=k1", SESSION_ID)).toBe(plain);
    expect(codexSessionProviderHomePath(home, "http://a.example/v1?key=k2", SESSION_ID)).toBe(plain);
    expect(codexSessionProviderHomePath(home, "http://a.example/v1#frag", SESSION_ID)).toBe(plain);
    // A different endpoint is still a different home.
    expect(codexSessionProviderHomePath(home, "http://a.example/v2?key=k1", SESSION_ID)).not.toBe(plain);
  });

  test("a config.toml written over a planted symlink replaces the link, never the target", () => {
    const home = makeCodexHome();
    const canary = canaryOutside();
    symlinkSync(canary, join(home, "config.toml"));
    writeCodexProviderConfigInto(home, OVERRIDE, MODEL, null);
    expect(isRegularFile(join(home, "config.toml"))).toBe(true);
    expect(readFileSync(canary, "utf8")).toBe("untouched");
    const config = readFileSync(join(home, "config.toml"), "utf8");
    expect(config).toContain(`base_url = "${OVERRIDE.baseUrl}"`);
    expect(config).toContain(`model = "${MODEL}"`);
    expect(config).toContain("model_context_window = 32768");
    // No temp file survived the rename.
    expect(readdirSync(home).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  test("a fresh session home is run-shaped, settles onto its key when resumable, and is removed otherwise", () => {
    const home = makeCodexHome();
    const session = createCodexSessionProviderHome(home, OVERRIDE, MODEL, null);
    expect(basename(session.codexHome)).toMatch(/^run-\d+-/);
    // The config waits for prepareConfig (after the resume claim, review
    // D5, correctness 3): a session refused before its spawn writes
    // nothing at all.
    expect(existsSync(join(session.codexHome, "config.toml"))).toBe(false);
    session.prepareConfig();
    expect(existsSync(join(session.codexHome, "config.toml"))).toBe(true);
    const keyed = codexSessionProviderHomePath(home, OVERRIDE.baseUrl, SESSION_ID);
    // The settle return (review D2, correctness-2 2): true iff the state
    // ended where a resume finds it.
    expect(session.settle(SESSION_ID, true)).toBe(true);
    expect(existsSync(session.codexHome)).toBe(false); // the run-shaped name is gone
    expect(isRegularFile(join(keyed, "config.toml"))).toBe(true); // the key holds the state
    // Settlement is once-only: a second call changes nothing and answers
    // false (nothing was settled by it).
    expect(session.settle(SESSION_ID, true)).toBe(false);
    expect(existsSync(keyed)).toBe(true);

    const removed = createCodexSessionProviderHome(home, OVERRIDE, MODEL, null);
    expect(removed.settle(SESSION_ID, false)).toBe(true); // a non-resumable end removes the home
    expect(existsSync(removed.codexHome)).toBe(false);
    expect(existsSync(keyed)).toBe(true);

    const unowned = createCodexSessionProviderHome(home, OVERRIDE, MODEL, null);
    expect(unowned.settle(null, true)).toBe(true); // never adopted an id: owns nothing
    expect(existsSync(unowned.codexHome)).toBe(false);

    const abandoned = createCodexSessionProviderHome(home, OVERRIDE, MODEL, null);
    abandoned.abandon(); // the spawn-throw backstop
    expect(existsSync(abandoned.codexHome)).toBe(false);
  });

  test("a settle whose rename cannot land returns false — the state never reached the key (review D2)", () => {
    // The finding's trigger: the keyed target already exists (or a
    // component was swapped), the rename fails, and the threads stay in
    // the run-shaped name a resume never computes. The return must say
    // not-resumable so the driver refuses the caller now instead of
    // letting a later --resume open an empty home and fail inside codex.
    const home = makeCodexHome();
    const session = createCodexSessionProviderHome(home, OVERRIDE, MODEL, null);
    const keyed = codexSessionProviderHomePath(home, OVERRIDE.baseUrl, SESSION_ID);
    mkdirSync(keyed);
    writeFileSync(join(keyed, "occupied"), ""); // a non-empty target: the rename cannot take it
    expect(session.settle(SESSION_ID, true)).toBe(false);
    // Both directories stay on disk (never delete what this process did
    // not create); the sweeps reclaim them.
    expect(existsSync(session.codexHome)).toBe(true);
    expect(existsSync(keyed)).toBe(true);
  });

  test("opening a missing keyed home refuses instead of silently remaking it (review D2)", () => {
    // The registry vouches for a session whose home is gone (a settle
    // that failed, or a codemux death before it, or the sweep). Creating
    // an empty home here handed the resume a thread-not-found failure
    // inside codex; the refusal names the path instead.
    const home = makeCodexHome();
    expect(() =>
      openCodexSessionProviderHome(home, OVERRIDE, MODEL, null, SESSION_ID)
    ).toThrow(/missing or untrusted/);
    expect(
      existsSync(codexSessionProviderHomePath(home, OVERRIDE.baseUrl, SESSION_ID))
    ).toBe(false);
  });

  test("a resumed home opens its key untouched and rewrites the config only at prepareConfig, through a planted symlink (reviews D1, D5)", () => {
    const home = makeCodexHome();
    // The prior process's resumable end left the state on the key.
    const prior = createCodexSessionProviderHome(home, OVERRIDE, MODEL, null);
    prior.prepareConfig();
    prior.settle(SESSION_ID, true);
    const keyed = codexSessionProviderHomePath(home, OVERRIDE.baseUrl, SESSION_ID);
    mkdirSync(join(keyed, "threads"));
    // The prior session's sandboxed child replaced the config with a
    // symlink pointing at the operator's file — the review D1 trigger.
    const canary = canaryOutside();
    unlinkSync(join(keyed, "config.toml"));
    symlinkSync(canary, join(keyed, "config.toml"));
    const session = openCodexSessionProviderHome(home, OVERRIDE, MODEL, null, SESSION_ID);
    expect(session.codexHome).toBe(keyed);
    // The open alone rewrites nothing (review D5, correctness 3): a racing
    // second resume refused session_busy leaves the live session's config
    // exactly as its owner wrote it — the planted link included.
    expect(lstatSync(join(keyed, "config.toml")).isSymbolicLink()).toBe(true);
    expect(readFileSync(canary, "utf8")).toBe("untouched");
    // prepareConfig (after the claim) replaces the link, never follows it.
    session.prepareConfig();
    expect(isRegularFile(join(keyed, "config.toml"))).toBe(true);
    expect(readFileSync(canary, "utf8")).toBe("untouched");
    expect(existsSync(join(keyed, "threads"))).toBe(true); // the state survived the rewrite
    // A failed resume (the spawn throws) never deletes state it did not
    // create: the home stays for the sweep.
    session.abandon();
    expect(existsSync(keyed)).toBe(true);
    // A resumable end keeps it; a non-resumable end NEVER removes a
    // resumed home (review D3, correctness-2): an interrupted resume
    // only proves this run did not complete, so deleting the home there
    // destroyed every earlier turn of the session. The home stays at its
    // key (settlement answers true — a resume finds it) and the 28-day
    // sweep reclaims it if none comes back.
    const kept = openCodexSessionProviderHome(home, OVERRIDE, MODEL, null, SESSION_ID);
    expect(kept.settle(SESSION_ID, true)).toBe(true);
    expect(existsSync(keyed)).toBe(true);
    const ended = openCodexSessionProviderHome(home, OVERRIDE, MODEL, null, SESSION_ID);
    expect(ended.settle(SESSION_ID, false)).toBe(true);
    expect(existsSync(keyed)).toBe(true);
    // Settlement is once-only here too.
    expect(ended.settle(SESSION_ID, false)).toBe(false);
    expect(existsSync(keyed)).toBe(true);
  });

  test("a home swapped for a symlink between the open and prepareConfig is refused, never written through (review D7, security)", () => {
    // The aider per-turn check's codex sibling: the open asserts the keyed
    // home, but the resume claim can wait out the lock budget between the
    // open and the config write, and the shared parent is writable by
    // every sandboxed codex child — another session's child can swap the
    // home DIRECTORY for a symlink in that window. The write re-asserts
    // the home itself (writeCodexProviderConfigInto), so the config
    // lands in a trusted directory or not at all.
    const home = makeCodexHome();
    const prior = createCodexSessionProviderHome(home, OVERRIDE, MODEL, null);
    prior.prepareConfig();
    prior.settle(SESSION_ID, true);
    const keyed = codexSessionProviderHomePath(home, OVERRIDE.baseUrl, SESSION_ID);
    const session = openCodexSessionProviderHome(home, OVERRIDE, MODEL, null, SESSION_ID);
    expect(session.codexHome).toBe(keyed);
    // The swap: what another session's child could do while this resume
    // waits at the claim.
    const outside = mkdtempSync(join(tmpdir(), "cmx-codprov-out-"));
    rmSync(keyed, { recursive: true, force: true });
    symlinkSync(outside, keyed);
    expect(() => session.prepareConfig()).toThrow(
      /must be a directory owned by the current user/
    );
    // Nothing was written through the link, and the link still stands
    // for the operator to see.
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(keyed).isSymbolicLink()).toBe(true);
    session.abandon();
  });

  test("a session never runs in another session's home — the naming rule codemux vouches for (review D5, security)", () => {
    // What codemux itself guarantees (and no more): no two sessions share
    // a directory, so codemux never loads one session's files into
    // another's CODEX_HOME. The shared parent stays child-writable — a
    // sandboxed child CAN write into any session home — so the guarantee
    // is naming, not access; the corrected boundary lives in
    // codexSessionProviderHomePath's doc.
    const home = makeCodexHome();
    const first = createCodexSessionProviderHome(home, OVERRIDE, MODEL, null);
    first.prepareConfig();
    first.settle(SESSION_ID, true);
    const keyed = codexSessionProviderHomePath(home, OVERRIDE.baseUrl, SESSION_ID);
    mkdirSync(join(keyed, "rules"));
    writeFileSync(join(keyed, "AGENTS.md"), "planted by the first session's child");
    const second = createCodexSessionProviderHome(home, OVERRIDE, MODEL, null);
    second.prepareConfig();
    second.settle("fedcba9876543210", true);
    const otherKey = codexSessionProviderHomePath(home, OVERRIDE.baseUrl, "fedcba9876543210");
    expect(existsSync(join(otherKey, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(otherKey, "rules"))).toBe(false);
    expect(existsSync(join(keyed, "AGENTS.md"))).toBe(true);
  });

  test("stale session homes are swept by age; fresh ones and recent dead-run homes are not", () => {
    const home = makeCodexHome();
    const parent = prepareRunDirParent(home, ".codemux-provider");
    const staleSession = join(parent, "session-home-abc123def456-deadbeefdeadbeef");
    const freshSession = join(parent, "session-home-abc123def456-feedfacefeedface");
    // Three days old: past the run-dir gate, far short of the session one.
    const youngSession = join(parent, "session-home-abc123def456-0123456789abcdef");
    mkdirSync(staleSession);
    mkdirSync(freshSession);
    mkdirSync(youngSession);
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    const twentyNineDaysAgo = new Date(Date.now() - 29 * 86_400_000);
    utimesSync(staleSession, twentyNineDaysAgo, twentyNineDaysAgo);
    utimesSync(youngSession, threeDaysAgo, threeDaysAgo);
    // A run dir of a dead pid, also three days old: swept by the run rule.
    const deadRun = join(parent, "run-999999999-gone");
    mkdirSync(deadRun);
    utimesSync(deadRun, threeDaysAgo, threeDaysAgo);
    // The next prepareRunDirParent (any session or run start) sweeps.
    prepareRunDirParent(home, ".codemux-provider");
    expect(existsSync(staleSession)).toBe(false);
    expect(existsSync(deadRun)).toBe(false);
    expect(existsSync(freshSession)).toBe(true);
    expect(existsSync(youngSession)).toBe(true);
  });

  test("a stale tree too big to walk is judged by registry proof, and the sweep still works beside it (reviews D7 and D10, correctness-2 2)", () => {
    // D7 capped the walk: an over-budget tree answers null, so a child
    // grown tree under `~/.codex` can no longer slow every later codemux
    // run. D10 split what null then means (the finding: the cap kept any
    // keyed home forever — every later run re-walked it to the cap): a
    // KEYED home the registry has POSITIVELY freed carries an ownership
    // proof (the run branch's pid gate twin), so null falls back to the
    // directory's own mtime and a huge dead tree is reclaimed by age;
    // every other over-budget home — `unknown`, or a name with no
    // parseable registry key — keeps the D7 spare, and the registry
    // consult runs BEFORE the walk, so the spared ones cost no walk at
    // all.
    const home = makeCodexHome();
    const parent = prepareRunDirParent(home, ".codemux-provider");
    const monthAgo = new Date(Date.now() - 30 * 86_400_000);
    // One past the cap, every entry old: a completed walk would judge the
    // tree stale, but the walk cannot complete.
    const fill = (dir: string): void => {
      mkdirSync(dir);
      for (let i = 0; i <= MTIME_WALK_ENTRY_CAP; i++) {
        const file = join(dir, `f${i}`);
        writeFileSync(file, "old");
        utimesSync(file, monthAgo, monthAgo);
      }
      utimesSync(dir, monthAgo, monthAgo);
    };
    const freedHuge = join(parent, "session-home-abc123def456-cafecafecafecafe");
    fill(freedHuge);
    const unknownHuge = join(parent, "session-home-abc123def456-baadbabebaadbabe");
    fill(unknownHuge);
    // No 12-hex endpoint hash ahead of a dash: not a registry key.
    const idlessHuge = join(parent, "session-home-nokeyedid");
    fill(idlessHuge);
    const small = join(parent, "session-home-abc123def456-deadbeefdeadbeef");
    mkdirSync(small);
    utimesSync(small, monthAgo, monthAgo);
    // The next prepareRunDirParent (any session or run start) sweeps: the
    // freed over-budget tree is reclaimed by its own age, the unknown and
    // id-less ones are spared, and the small stale one still goes.
    prepareRunDirParent(home, ".codemux-provider", (id) =>
      id === "cafecafecafecafe" || id === "deadbeefdeadbeef" ? "free" : "unknown");
    expect(existsSync(freedHuge)).toBe(false); // freed: own-mtime fallback reclaims
    expect(existsSync(unknownHuge)).toBe(true); // unknown: the D7 spare holds
    expect(existsSync(idlessHuge)).toBe(true); // no registry key: no proof exists
    expect(existsSync(small)).toBe(false);
  });

  test("a dead run directory too big to walk is aged by its own mtime, not spared (review D9, correctness-2)", () => {
    // The finding: the sweep aged a dead-owner run directory by the
    // tree-newest mtime, and the capped walk's null spared it — a
    // codemux crash that left a run HOME holding more than the walk's
    // entry budget (npm/pip/cargo caches) leaked the directory forever
    // and cost every later run a walk to the cap. The pid gate has
    // already shown nothing owns the tree, so an over-budget walk now
    // falls back to the directory's own mtime: stale by it goes, young
    // by it stays.
    const home = makeCodexHome();
    const parent = prepareRunDirParent(home, ".codemux-provider");
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    // One past the cap, so the walk cannot finish; the interior files
    // stay young while the directory's own mtime carries the verdict.
    const fill = (dir: string): void => {
      mkdirSync(dir);
      for (let i = 0; i <= MTIME_WALK_ENTRY_CAP; i++) {
        writeFileSync(join(dir, `f${i}`), "x");
      }
    };
    const deadRun = join(parent, "run-999999999-crashed");
    fill(deadRun);
    utimesSync(deadRun, threeDaysAgo, threeDaysAgo);
    const youngRun = join(parent, "run-999999998-just-crashed");
    fill(youngRun);
    // The next prepareRunDirParent (any session or run start) sweeps.
    prepareRunDirParent(home, ".codemux-provider");
    expect(existsSync(deadRun)).toBe(false); // stale by its own mtime: gone
    expect(existsSync(youngRun)).toBe(true); // over-cap but young: kept
  });

  test("an undeletable stale entry never blocks the sweep or later runs (review D11, correctness 2 2)", () => {
    // The finding: a sandboxed codex child can leave a directory
    // without write permission inside its session home; once the home
    // is stale and the registry answers `free`, the branch's rmSync
    // threw EACCES straight out of prepareRunDirParent — failing every
    // later codemux run that reached the sweep until the directory was
    // removed by hand. The guard is the other sweeps' rule: warn, leave
    // the entry (retrying it never cleans it either), keep sweeping.
    // The run branch carries the same guard, so a locked dead run tree
    // is pinned the same way, beside a deletable sibling the sweep must
    // still reach.
    const home = makeCodexHome();
    const parent = prepareRunDirParent(home, ".codemux-provider");
    const monthAgo = new Date(Date.now() - 30 * 86_400_000);
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    /** A stale tree whose interior directory cannot be unlinked
     * through: rm needs write permission on a directory to remove its
     * children, so the recursive delete throws EACCES. */
    const lock = (dir: string, when: Date): void => {
      mkdirSync(join(dir, "no-write"), { recursive: true });
      writeFileSync(join(dir, "no-write", "f"), "old");
      utimesSync(join(dir, "no-write", "f"), when, when);
      utimesSync(join(dir, "no-write"), when, when);
      utimesSync(dir, when, when);
      chmodSync(join(dir, "no-write"), 0o500);
    };
    const lockedHome = join(parent, "session-home-abc123def456-lockeddeadbeef");
    lock(lockedHome, monthAgo);
    const lockedRun = join(parent, "run-999999999-crashed");
    lock(lockedRun, threeDaysAgo);
    const staleHome = join(parent, "session-home-abc123def456-freedeadbeef00");
    mkdirSync(staleHome);
    utimesSync(staleHome, monthAgo, monthAgo);

    // Returns normally: pre-fix this call threw EACCES out of the sweep.
    prepareRunDirParent(home, ".codemux-provider", () => "free");
    expect(existsSync(lockedHome)).toBe(true); // undeletable: stays, retried
    expect(existsSync(lockedRun)).toBe(true); // the run branch's twin
    expect(existsSync(staleHome)).toBe(false); // the sweep kept going
    // Restore writability so the tmp tree stays cleanable by anything
    // that sweeps it later.
    chmodSync(join(lockedHome, "no-write"), 0o700);
    chmodSync(join(lockedRun, "no-write"), 0o700);
  });

  test("a session home the registry holds live is never swept, however stale (review D4, security 1)", () => {
    // The finding: the sweep fires from ANY codemux run's
    // prepareRunDirParent, so a resumed codex session held open past the
    // age gate with no writes lost its CODEX_HOME to the next run. The
    // session-home branch now carries the aider rule — a registry-held id
    // (an OPEN record with a live owner) is skipped; age alone never
    // removes a live session's home, while an ended record's home still
    // goes.
    const home = makeCodexHome();
    const registryPath = join(
      mkdtempSync(join(tmpdir(), "cmx-codprov-reg-")),
      "live-sessions.json"
    );
    const isHeld = (id: string) => sessionHoldState(registryPath, id);
    const parent = prepareRunDirParent(home, ".codemux-provider", isHeld);
    const held = join(parent, "session-home-abc123def456-1111111111111111");
    const ended = join(parent, "session-home-abc123def456-2222222222222222");
    mkdirSync(held);
    mkdirSync(ended);
    const stale = new Date(Date.now() - 30 * 86_400_000);
    for (const dir of [held, ended]) utimesSync(dir, stale, stale);
    const now = new Date().toISOString();
    const record = (id: string, endedAt: string | null): unknown => ({
      id,
      agent: "codex",
      created_at: now,
      last_activity: now,
      cwd: "/definitely/not/the/registry",
      hermetic: false,
      harness_home: "/definitely/not/the/registry/.codex",
      model: null,
      autonomy: "low",
      sandboxed: true,
      sandbox_trust: "standard",
      sandbox_no_net: false,
      sandbox_scrub_env: false,
      pass_env: [],
      playwright_mcp: false,
      provider_base_url: "http://127.0.0.1:9/v1",
      owner_pid: process.pid,
      owner_start: null,
      ended: endedAt,
    });
    mkdirSync(dirname(registryPath), { recursive: true });
    writeFileSync(
      registryPath,
      `${JSON.stringify({
        version: 1,
        sessions: [record("1111111111111111", null), record("2222222222222222", now)],
      }, null, 2)}\n`,
      { mode: 0o600 }
    );
    // The next codemux run or session start sweeps with the same skip.
    prepareRunDirParent(home, ".codemux-provider", isHeld);
    expect(existsSync(held)).toBe(true); // held live: spared however stale
    expect(existsSync(ended)).toBe(false); // the record ended: age decides
  });

  test("a registry that cannot be read spares every stale home — only a positive free may remove (review D5, correctness 1)", () => {
    // The finding: sessionHeldLive folded every non-ok read (a transient
    // I/O error above all) into "not held", so the sweep deleted a LIVE
    // session's home during a registry read failure. The tri-state
    // answers `unknown`, and the sweep removes nothing it cannot judge.
    const home = makeCodexHome();
    const registryPath = join(
      mkdtempSync(join(tmpdir(), "cmx-codprov-reg-")),
      "live-sessions.json"
    );
    // A corrupt registry reads as `unknown` for every id (a transient
    // read error maps there too — sessionHoldState folds every not-ok
    // read into unknown).
    mkdirSync(dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, "not json", { mode: 0o600 });
    const holdOf = (id: string) => sessionHoldState(registryPath, id);
    const parent = prepareRunDirParent(home, ".codemux-provider", holdOf);
    const staleHome = join(parent, "session-home-abc123def456-3333333333333333");
    const staleRun = join(parent, "run-999999999-gone");
    mkdirSync(staleHome);
    mkdirSync(staleRun);
    const stale = new Date(Date.now() - 30 * 86_400_000);
    for (const dir of [staleHome, staleRun]) utimesSync(dir, stale, stale);
    prepareRunDirParent(home, ".codemux-provider", holdOf);
    expect(existsSync(staleHome)).toBe(true); // unknown: spared, live session or not
    expect(existsSync(staleRun)).toBe(false); // run homes age out regardless — no id to judge
    // A MISSING registry is a positive free (nothing can be held): the
    // stale session home goes again.
    unlinkSync(registryPath);
    prepareRunDirParent(home, ".codemux-provider", holdOf);
    expect(existsSync(staleHome)).toBe(false);
  });

  test("a home whose newest WRITE is recent survives an old directory mtime (review D2, security 2)", () => {
    // codex writes its thread state into SUBDIRECTORIES of the home, which
    // never moves the home's own mtime — so aging by the top directory
    // deleted the homes of live, long-running sessions 28 days after
    // creation. The age is the NEWEST mtime anywhere in the tree.
    const home = makeCodexHome();
    const parent = prepareRunDirParent(home, ".codemux-provider");
    const twentyNineDaysAgo = new Date(Date.now() - 29 * 86_400_000);
    // A long-running session home: created 29 days ago, thread state
    // written yesterday under sessions/.
    const longRunning = join(parent, "session-home-abc123def456-1111111111111111");
    const threadDir = join(longRunning, "sessions", "2026", "10");
    mkdirSync(threadDir, { recursive: true });
    writeFileSync(join(threadDir, "rollout.jsonl"), "written yesterday");
    utimesSync(longRunning, twentyNineDaysAgo, twentyNineDaysAgo);
    const yesterday = new Date(Date.now() - 86_400_000);
    utimesSync(threadDir, yesterday, yesterday);
    utimesSync(join(threadDir, "rollout.jsonl"), yesterday, yesterday);
    // The same-class run-dir case: a dead owner pid whose codex child
    // kept writing inside — the 2-day run gate must measure true
    // idleness too, not time since creation.
    const deadRun = join(parent, "run-999999999-writes");
    mkdirSync(join(deadRun, "sessions"), { recursive: true });
    writeFileSync(join(deadRun, "sessions", "fresh.jsonl"), "recent");
    utimesSync(deadRun, twentyNineDaysAgo, twentyNineDaysAgo);
    utimesSync(join(deadRun, "sessions"), yesterday, yesterday);
    utimesSync(join(deadRun, "sessions", "fresh.jsonl"), yesterday, yesterday);
    // A truly idle one — old everywhere — still goes.
    const idle = join(parent, "session-home-abc123def456-2222222222222222");
    mkdirSync(idle);
    utimesSync(idle, twentyNineDaysAgo, twentyNineDaysAgo);
    prepareRunDirParent(home, ".codemux-provider");
    expect(existsSync(longRunning)).toBe(true);
    expect(existsSync(deadRun)).toBe(true);
    expect(existsSync(idle)).toBe(false);
  });

  test("a resume's own setup never sweeps the home it is about to open (review D10, correctness-2 3)", () => {
    // The finding: openCodexSessionProviderHome called the parent sweep
    // (prepareRunDirParent) AFTER lookupForResume had already vouched for
    // the keyed home — and for an ended record the registry answers
    // `free`, the sweep's removal condition, so a home idle past the
    // 28-day gate was deleted right there and the resume refused
    // "missing or untrusted", a refusal its own setup caused. The entry
    // being opened is spared; every other codemux run may still sweep it.
    const home = makeCodexHome();
    const keyed = codexSessionProviderHomePath(home, OVERRIDE.baseUrl, SESSION_ID);
    mkdirSync(keyed, { recursive: true });
    const stateFile = join(keyed, "config.toml");
    writeFileSync(stateFile, "prior session state");
    const twentyNineDaysAgo = new Date(Date.now() - 29 * 86_400_000);
    // The whole tree is idle past the gate — the file too, or a fresh
    // write inside would keep the home by the walk and the test would
    // never see the sweep's verdict.
    utimesSync(keyed, twentyNineDaysAgo, twentyNineDaysAgo);
    utimesSync(stateFile, twentyNineDaysAgo, twentyNineDaysAgo);
    // A sibling the sweep must still take: a dead-owner run directory
    // past its age gate, judged by name and mtime alone (deterministic —
    // no registry consult).
    const sibling = join(dirname(keyed), "run-999999999-gone");
    mkdirSync(sibling);
    utimesSync(sibling, twentyNineDaysAgo, twentyNineDaysAgo);
    // The open itself runs the sweep, with the default registry consult —
    // this id sits in no registry, which answers `free`, exactly the
    // ended-record state the finding describes; only the spare keeps the
    // home.
    const opened = openCodexSessionProviderHome(home, OVERRIDE, MODEL, null, SESSION_ID);
    expect(opened.codexHome).toBe(keyed);
    expect(readFileSync(join(keyed, "config.toml"), "utf8")).toBe("prior session state");
    expect(existsSync(sibling)).toBe(false);
  });
});


