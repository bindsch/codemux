import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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
import { MODEL, OVERRIDE, SESSION_ID, makeCodexHome } from "./helpers/codex-provider.js";

// The provider-override homes under review D1: the session-keyed CODEX_HOME
// (one directory per session, never shared) and the atomic config.toml
// write that cannot follow a symlink the sandboxed child planted.

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

  test("settle persists only the directory this run created — a swapped home is refused (review round 292)", () => {
    // The resumable branch revalidated the parent and the owner of
    // codexHome but not the home's IDENTITY: the shared parent is
    // writable by every sandboxed codex child, so one could rename the
    // real home away and park another user-owned directory at its name —
    // a replacement that passes every check and is then renamed onto the
    // session key, where a later resume loads it as state.
    const home = makeCodexHome();
    try {
      const session = createCodexSessionProviderHome(home, OVERRIDE, MODEL, null);
      const keyed = codexSessionProviderHomePath(home, OVERRIDE.baseUrl, SESSION_ID);
      const moved = join(home, "home-moved");
      renameSync(session.codexHome, moved);
      const replacement = mkdtempSync(join(home, "replacement-"));
      writeFileSync(join(replacement, "planted-config.toml"), "not this session's state\n");
      renameSync(replacement, session.codexHome);
      const errors: string[] = [];
      const realError = console.error;
      console.error = ((message: string) => errors.push(String(message))) as typeof console.error;
      try {
        expect(session.settle(SESSION_ID, true)).toBe(false);
      } finally {
        console.error = realError;
      }
      expect(errors.join("\n")).toContain("could not set aside");
      // The replacement never reached the key, and both directories stay
      // for the sweep; the real home survives under its moved name.
      expect(existsSync(keyed)).toBe(false);
      expect(existsSync(session.codexHome)).toBe(true);
      expect(existsSync(join(moved, "config.toml"))).toBe(false); // the real one: empty until prepareConfig
      expect(existsSync(moved)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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

  test("settle and abandon refuse a parent swapped or replaced after creation (round 104)", () => {
    // The session home's removals revalidated the parent by lstat alone,
    // so a symlink was caught but another directory put at the same path
    // was not, and the recursive remove deleted the same-named child under
    // it. The parent's identity is recorded at creation and revalidated by
    // every removal (src/safe-remove.ts); a refused removal answers false
    // (settle) or keeps the home (abandon), and the sweep reclaims it.
    for (const shape of ["symlink", "replacement"] as const) {
      const home = makeCodexHome();
      try {
        const parent = codexProviderSessionsParent(home);
        const settled = createCodexSessionProviderHome(home, OVERRIDE, MODEL, null);
        const abandoned = createCodexSessionProviderHome(home, OVERRIDE, MODEL, null);
        // The victim (symlink shape) or decoy child (replacement shape)
        // holding a same-named directory a naive removal would delete.
        const sameNamed = (root: string): string => {
          const child = join(root, basename(settled.codexHome));
          mkdirSync(child, { recursive: true });
          writeFileSync(join(child, "marker.txt"), "kept\n");
          return child;
        };
        const victim = sameNamed(join(home, "victim"));
        const moved = join(home, "parent-moved");
        renameSync(parent, moved);
        let decoy: string | null = null;
        if (shape === "symlink") {
          symlinkSync(join(home, "victim"), parent);
        } else {
          mkdirSync(parent);
          decoy = sameNamed(parent);
        }
        const errors: string[] = [];
        const realError = console.error;
        console.error = ((message: string) => errors.push(String(message))) as typeof console.error;
        try {
          expect(settled.settle(null, false)).toBe(false);
          abandoned.abandon();
        } finally {
          console.error = realError;
        }
        expect(errors.join("\n")).toContain("the directory was kept");
        expect(readFileSync(join(victim, "marker.txt"), "utf8")).toBe("kept\n");
        if (decoy !== null) expect(readFileSync(join(decoy, "marker.txt"), "utf8")).toBe("kept\n");
        // Both homes are kept — settle and abandon are one-shot by design,
        // so a refused removal leaves the directory to the stale-home sweep
        // instead of retrying, and nothing under the victim or the decoy
        // went with them. The homes physically sit under the moved parent;
        // their recorded paths now resolve through the swap, so the check
        // follows the physical tree, not the name.
        expect(existsSync(join(moved, basename(settled.codexHome)))).toBe(true);
        expect(existsSync(join(moved, basename(abandoned.codexHome)))).toBe(true);
        // Restore the real parent so the finally cleanup reaches the moved
        // tree; the homes themselves are the sweep's now.
        if (shape === "symlink") {
          rmSync(parent);
        } else {
          rmSync(parent, { recursive: true, force: true });
        }
        renameSync(moved, parent);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });
});
