/**
 * Unit tests for the aider session wiring (design §4.7, plan step 8): the
 * floor, the honest capability matrix, the per-turn spawn command over
 * --restore-chat-history, the per-session history file codemux owns, and
 * its integrity rules — the collision refusal, the stale-directory sweep,
 * and the symlink refusal (aider-session.ts names the pinned sources). The
 * driver round-trips are the e2e suite (tests/session-aider-e2e.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdapter } from "../src/adapters/index.js";
import {
  aiderSessionAutonomyFlags,
  aiderSessionCapabilities,
  aiderSessionHistoryPath,
  AIDER_SESSION_FLOOR,
  AIDER_SESSION_ID_PATTERN,
  assertAiderHistoryForTurn,
  buildAiderSessionCommand,
  createAiderSessionHistory,
  removeAiderSessionHistory,
} from "../src/session/aider-session.js";
import type { AutonomyLevel } from "../src/types.js";

const UUID = "11111111-2222-3333-4444-555555555555";

describe("aider session - contract", () => {
  test("the floor is the audited 0.86.2", () => {
    expect(AIDER_SESSION_FLOOR).toBe("0.86.2");
  });

  test("the capability matrix is honest: live input and resume, nothing else", () => {
    expect(aiderSessionCapabilities()).toEqual({
      live_input: true,
      user_during_turn: false,
      steer: false,
      interrupt: false,
      permissions: false,
      deltas: false,
      file_changes: false,
      usage_stream: false,
      resume: true,
    });
  });

  test("the session autonomy flags are the adapter's mapping, no drift", () => {
    const adapter = getAdapter("aider");
    for (const level of ["read-only", "low", "medium", "high"] as AutonomyLevel[]) {
      expect(aiderSessionAutonomyFlags(level)).toEqual(adapter.mapAutonomy(level));
    }
  });

  test("the id pattern accepts the minted lowercase UUIDs and refuses everything else", () => {
    expect(AIDER_SESSION_ID_PATTERN.test(UUID)).toBe(true);
    // randomUUID mints lowercase hex; an uppercase spelling is not one.
    expect(AIDER_SESSION_ID_PATTERN.test("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe(true);
    expect(AIDER_SESSION_ID_PATTERN.test("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")).toBe(false);
    expect(AIDER_SESSION_ID_PATTERN.test("ses_abc12345")).toBe(false);
    expect(AIDER_SESSION_ID_PATTERN.test("")).toBe(false);
    expect(AIDER_SESSION_ID_PATTERN.test("not-a-uuid")).toBe(false);
  });
});

describe("aider session - spawn command", () => {
  test("a turn is the shared headless flags plus --restore-chat-history and the argv prompt", () => {
    const historyPath = `/home/u/.aider/.codemux/sessions/${UUID}/history.md`;
    const argv = buildAiderSessionCommand({
      autonomy: "low",
      historyPath,
      prompt: "fix the bug",
    });
    // The shared headless surface rides first, exactly as the run path
    // builds it, with the session's history file as the chat target.
    expect(argv[0]).toBe("aider");
    expect(argv).toContain("--no-gitignore");
    expect(argv).toContain("--no-auto-commits");
    const historyIndex = argv.indexOf("--chat-history-file");
    expect(historyIndex).not.toBe(-1);
    expect(argv[historyIndex + 1]).toBe(historyPath);
    // The replay flag: the session's whole state carrier.
    expect(argv).toContain("--restore-chat-history");
    // The prompt is the argv tail, on the = form the adapter pins.
    expect(argv[argv.length - 1]).toBe("--message=fix the bug");
  });

  test("model rides before the weak model; the weak model appears only when passed", () => {
    const base = { autonomy: "high", historyPath: "/h.md", prompt: "p" } as const;
    const withWeak = buildAiderSessionCommand({
      ...base,
      model: "openai/clawvm-qwen32b-coder",
      weakModel: "openai/clawvm-qwen32b-coder",
    });
    expect(withWeak).toContain("--model");
    expect(withWeak[withWeak.indexOf("--model") + 1]).toBe("openai/clawvm-qwen32b-coder");
    expect(withWeak).toContain("--weak-model");
    expect(withWeak[withWeak.indexOf("--weak-model") + 1]).toBe("openai/clawvm-qwen32b-coder");
    const withoutWeak = buildAiderSessionCommand({
      autonomy: "high",
      historyPath: "/h.md",
      prompt: "p",
      model: "gpt-5.1",
    });
    expect(withoutWeak).not.toContain("--weak-model");
  });

  test("read-only maps to --dry-run; medium and high map to --yes-always", () => {
    const flags = (autonomy: AutonomyLevel): string[] =>
      buildAiderSessionCommand({ autonomy, historyPath: "/h.md", prompt: "p" });
    expect(flags("read-only")).toContain("--dry-run");
    expect(flags("read-only")).not.toContain("--yes-always");
    expect(flags("low")).not.toContain("--yes-always");
    expect(flags("medium")).toContain("--yes-always");
    expect(flags("high")).toContain("--yes-always");
  });

  test("effort rides as --reasoning-effort before the prompt", () => {
    const argv = buildAiderSessionCommand({
      autonomy: "low",
      historyPath: "/h.md",
      prompt: "p",
      effort: "high",
    });
    expect(argv).toContain("--reasoning-effort");
    expect(argv.indexOf("--reasoning-effort")).toBeLessThan(argv.length - 1);
    expect(argv[argv.length - 1]).toBe("--message=p");
  });
});

describe("aider session - history file", () => {
  test("the per-session history path sits under the harness home's codemux directory", () => {
    expect(aiderSessionHistoryPath("/home/u/.aider", UUID)).toBe(
      `/home/u/.aider/.codemux/sessions/${UUID}/history.md`
    );
  });

  test("a fresh session creates an empty history file, exclusively", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-aider-unit-"));
    const historyPath = aiderSessionHistoryPath(home, UUID);
    createAiderSessionHistory(historyPath);
    expect(existsSync(historyPath)).toBe(true);
    expect(readFileSync(historyPath, "utf8")).toBe("");
    // An existing file means a minted-UUID collision: reusing it would
    // splice two sessions' transcripts, so the create refuses.
    expect(() => createAiderSessionHistory(historyPath)).toThrow();
  });

  test("the sweep removes UUID-named session directories idle past any session's lifetime, and nothing else", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-aider-sweep-"));
    const sessionsDir = join(home, ".codemux", "sessions");
    const stale = join(sessionsDir, "00000000-1111-2222-3333-444444444444");
    const fresh = join(sessionsDir, "55555555-6666-7777-8888-999999999999");
    const foreign = join(sessionsDir, "not-a-uuid");
    for (const dir of [stale, fresh, foreign]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "history.md"), "old");
    }
    const monthAgo = Date.now() - 30 * 86_400_000;
    // The age signal is the HISTORY FILE's mtime (review D2, security 2 /
    // correctness-2 1): aider only ever appends to history.md in place, so
    // the directory's own mtime never moves after creation.
    utimesSync(join(stale, "history.md"), monthAgo / 1000, monthAgo / 1000);
    utimesSync(join(foreign, "history.md"), monthAgo / 1000, monthAgo / 1000);
    // The create for a NEW session id sweeps first.
    createAiderSessionHistory(aiderSessionHistoryPath(home, UUID));
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    // Only UUID-named directories are ever considered.
    expect(existsSync(foreign)).toBe(true);
  });

  test("a directory aged by mtime alone survives while its history file is fresh (review D2)", () => {
    // The finding's worked example: a session created more than 28 days
    // ago, resumed yesterday, swept by the next fresh session because the
    // DIRECTORY mtime never moved. Aging by history.md keeps it.
    const home = mkdtempSync(join(tmpdir(), "codemux-aider-sweep2-"));
    const sessionsDir = join(home, ".codemux", "sessions");
    const usedYesterday = join(sessionsDir, "00000000-1111-2222-3333-444444444444");
    mkdirSync(usedYesterday, { recursive: true });
    writeFileSync(join(usedYesterday, "history.md"), "the conversation");
    const monthAgo = Date.now() - 30 * 86_400_000;
    utimesSync(usedYesterday, monthAgo / 1000, monthAgo / 1000);
    createAiderSessionHistory(aiderSessionHistoryPath(home, UUID));
    expect(existsSync(usedYesterday)).toBe(true);
    expect(existsSync(join(usedYesterday, "history.md"))).toBe(true);
  });

  test("an id the registry vouches for is never swept, however stale its history file (review D2)", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-aider-sweep3-"));
    const sessionsDir = join(home, ".codemux", "sessions");
    const liveId = "00000000-1111-2222-3333-444444444444";
    const live = join(sessionsDir, liveId);
    const dead = join(sessionsDir, "99999999-8888-7777-6666-555555555555");
    for (const dir of [live, dead]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "history.md"), "old");
    }
    const monthAgo = Date.now() - 30 * 86_400_000;
    for (const dir of [live, dead]) {
      utimesSync(join(dir, "history.md"), monthAgo / 1000, monthAgo / 1000);
    }
    // The driver's registry-backed liveness skip: both are stale by file
    // age, but the held id is skipped while the unheld one is swept.
    createAiderSessionHistory(
      aiderSessionHistoryPath(home, UUID),
      (id) => (id === liveId ? "held" : "free")
    );
    expect(existsSync(live)).toBe(true);
    expect(existsSync(dead)).toBe(false);
  });

  test("an unreadable registry spares every stale directory — only a positive free may remove (review D5, correctness 1)", () => {
    // The finding's aider arm: sessionHeldLive answered false for every
    // non-ok read, so a transient registry failure swept a live session's
    // history away. `unknown` must spare: the sweep removes nothing it
    // cannot judge.
    const home = mkdtempSync(join(tmpdir(), "codemux-aider-sweep5-"));
    const sessionsDir = join(home, ".codemux", "sessions");
    const stale = join(sessionsDir, "00000000-1111-2222-3333-444444444444");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "history.md"), "old");
    const monthAgo = Date.now() - 30 * 86_400_000;
    utimesSync(join(stale, "history.md"), monthAgo / 1000, monthAgo / 1000);
    createAiderSessionHistory(
      aiderSessionHistoryPath(home, UUID),
      () => "unknown"
    );
    expect(existsSync(stale)).toBe(true);
    // A positive free (the registry read fine and holds nothing) is the
    // only answer that removes. A different fresh id: the history file
    // for the first already exists now.
    createAiderSessionHistory(
      aiderSessionHistoryPath(home, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
      () => "free"
    );
    expect(existsSync(stale)).toBe(false);
  });

  test("a crash-leftover directory with no history file ages by its own mtime", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-aider-sweep4-"));
    const sessionsDir = join(home, ".codemux", "sessions");
    const leftover = join(sessionsDir, "00000000-1111-2222-3333-444444444444");
    mkdirSync(leftover, { recursive: true });
    const monthAgo = Date.now() - 30 * 86_400_000;
    utimesSync(leftover, monthAgo / 1000, monthAgo / 1000);
    createAiderSessionHistory(aiderSessionHistoryPath(home, UUID));
    expect(existsSync(leftover)).toBe(false);
  });

  test("the pre-turn check accepts the created file and trips on anything swapped in (review D7, security)", () => {
    // Between turns nothing else guards the file: the creation-time
    // check is one-shot and the O_NOFOLLOW read runs only after a
    // turn's process exits. This check is what every later spawn
    // stands on — the chain, then the file itself (regular, ours,
    // 0600).
    const home = mkdtempSync(join(tmpdir(), "codemux-aider-preturn-"));
    const historyPath = aiderSessionHistoryPath(home, UUID);
    createAiderSessionHistory(historyPath);
    expect(() => assertAiderHistoryForTurn(historyPath)).not.toThrow();
    // A widened mode trips: aider only ever appends in place, so a live
    // session's file never carries another mode — no false positive.
    chmodSync(historyPath, 0o644);
    expect(() => assertAiderHistoryForTurn(historyPath)).toThrow(/mode 0600/);
    chmodSync(historyPath, 0o600);
    // The finding's shape: the file replaced by a symlink to something
    // outside the sandbox that a sandboxed child wants read into the
    // model context and appended to.
    const target = join(home, "authorized_keys");
    writeFileSync(target, "secret");
    rmSync(historyPath);
    symlinkSync(target, historyPath);
    expect(() => assertAiderHistoryForTurn(historyPath)).toThrow(
      /must be a regular file owned by the current user with mode 0600/
    );
    expect(readFileSync(target, "utf8")).toBe("secret");
    // A missing file trips too: never spawn against state codemux
    // cannot see.
    rmSync(historyPath);
    expect(() => assertAiderHistoryForTurn(historyPath)).toThrow();
  });

  test("a symlinked session directory is refused, never written through", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-aider-link-"));
    const sessionsDir = join(home, ".codemux", "sessions");
    const target = join(home, "target");
    mkdirSync(target);
    mkdirSync(sessionsDir, { recursive: true });
    symlinkSync(target, join(sessionsDir, UUID));
    expect(() =>
      createAiderSessionHistory(aiderSessionHistoryPath(home, UUID))
    ).toThrow(/must be a directory owned by the current user/);
    expect(existsSync(join(target, "history.md"))).toBe(false);
  });

  test("a symlinked .codemux intermediate is refused: no history directory, no sweep, no removal through it (review D4)", () => {
    // The finding: mkdirSync(recursive) and a last-component lstat both
    // RESOLVE an intermediate symlink, and the sandboxed aider child can
    // write `~/.aider` — so a planted `.codemux` link aimed the fresh
    // session's history directory, the 28-day sweep, and the
    // record-failure removal wherever the link named. Every component
    // from `.codemux` down is now lstat-checked first.
    const home = mkdtempSync(join(tmpdir(), "codemux-aider-link2-"));
    const target = join(home, "target");
    const staleId = "00000000-1111-2222-3333-444444444444";
    // What a sweep run through the link would have deleted: a stale
    // UUID directory under the link's target.
    mkdirSync(join(target, "sessions", staleId), { recursive: true });
    writeFileSync(join(target, "sessions", staleId, "history.md"), "old");
    const monthAgo = Date.now() - 30 * 86_400_000;
    utimesSync(
      join(target, "sessions", staleId, "history.md"),
      monthAgo / 1000,
      monthAgo / 1000
    );
    // The planted link: `~/.aider/.codemux` -> ~/…/target.
    symlinkSync(target, join(home, ".codemux"));
    const historyPath = aiderSessionHistoryPath(home, UUID);
    expect(() => createAiderSessionHistory(historyPath)).toThrow(
      /must be a directory owned by the current user/
    );
    // Nothing was created through the link, and the sweep never ran
    // under the target: the fresh session's directory is absent and the
    // stale one survives.
    expect(existsSync(join(target, "sessions", UUID))).toBe(false);
    expect(existsSync(join(target, "sessions", staleId, "history.md"))).toBe(true);
    // The record-failure removal refuses the same intermediates instead
    // of aiming rmSync through the link.
    expect(() => removeAiderSessionHistory(historyPath)).toThrow(
      /must be a directory owned by the current user/
    );
    expect(existsSync(join(target, "sessions", staleId))).toBe(true);
  });
});
