import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCeiling, pathInsideScope, spellingsInsideScope } from "../src/session/ceiling.js";
import { tempDir } from "./helpers/session-ceiling.js";

describe("medium .git and normalization containment (review live11)", () => {
  test("medium denies writes inside the launch directory's .git", () => {
    // Review live11, minor 7: `.git/hooks/*` and `.git/config` are
    // executable git configuration — whatever lands in a hook runs on
    // the next git command — so the medium edit grant does not cover
    // them. High never consults the predicate (the bare grant), and low
    // leaves the answer to the caller.
    const dir = tempDir();
    const hook = claudeCeiling(
      "medium",
      "Write",
      { file_path: join(dir, ".git", "hooks", "pre-commit"), content: "x" },
      dir
    );
    expect(hook.allowable).toBe(false);
    expect(hook.reason).toContain(".git");
    const config = claudeCeiling(
      "medium",
      "Edit",
      { file_path: join(dir, ".git", "config"), old_string: "x", new_string: "y" },
      dir
    );
    expect(config.allowable).toBe(false);
    expect(config.reason).toContain(".git");
    // A nested .git (a submodule worktree's) is repository metadata too.
    expect(
      claudeCeiling(
        "medium",
        "Write",
        { file_path: join(dir, "sub", ".git", "config"), content: "x" },
        dir
      ).allowable
    ).toBe(false);
    // The component must be exactly ".git": a name that merely contains
    // the letters is an ordinary file.
    expect(
      claudeCeiling(
        "medium",
        "Edit",
        { file_path: join(dir, "github-notes.txt"), old_string: "x", new_string: "y" },
        dir
      ).allowable
    ).toBe(true);
    // High keeps the bare grant: any path, .git included.
    expect(
      claudeCeiling(
        "high",
        "Write",
        { file_path: join(dir, ".git", "hooks", "pre-commit"), content: "x" },
        dir
      ).allowable
    ).toBe(true);
    // Low leaves the answer to the caller.
    expect(
      claudeCeiling(
        "low",
        "Write",
        { file_path: join(dir, ".git", "config"), content: "x" },
        dir
      ).allowable
    ).toBe(true);
    // The codex fileChange ceiling shares pathInsideScope, so a medium
    // patch touching .git/config refuses the same way.
    expect(
      pathInsideScope(join(dir, ".git", "config"), dir).reason
    ).toContain(".git");
  });

  test("the .git refusal folds case: .GIT and .Git spellings deny at medium", () => {
    // Review live13, minor 1: on a case-insensitive filesystem (macOS's
    // default, Windows) a `.GIT`-spelled write opens the real `.git` —
    // verified on this machine, where writing `.GIT/config` lands in
    // `.git/config` and realpath of the existing mixed-case spelling
    // rewrites to the on-disk case. That rewrite is what carried the old
    // case-sensitive compare on macOS; the rule must not lean on the
    // resolver's manners, so the component compare folds case outright.
    // The shape below has no `.git` on disk, so nothing rewrites the
    // spelling (verified: resolution keeps `.GIT` verbatim) — pre-fix
    // that Write was allowable at medium, on every filesystem, and it is
    // exactly the spelling a case-insensitive volume maps onto `.git`.
    const dir = tempDir();
    const hook = claudeCeiling(
      "medium",
      "Write",
      { file_path: join(dir, ".GIT", "hooks", "pre-commit"), content: "x" },
      dir
    );
    expect(hook.allowable).toBe(false);
    expect(hook.reason).toContain(".git");
    // Other case variants refuse the same way.
    expect(
      claudeCeiling(
        "medium",
        "Edit",
        { file_path: join(dir, ".Git", "config"), old_string: "x", new_string: "y" },
        dir
      ).allowable
    ).toBe(false);
    // With a real `.git` on disk the attack lands end to end (on macOS
    // realpath rewrites the existing mixed-case ancestor onto it); the
    // fold denies it without asking the resolver.
    const repo = tempDir();
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    expect(
      claudeCeiling(
        "medium",
        "Write",
        { file_path: join(repo, ".GIT", "hooks", "pre-commit"), content: "x" },
        repo
      ).allowable
    ).toBe(false);
    // The fold tightens medium only: high keeps the bare grant.
    expect(
      claudeCeiling(
        "high",
        "Write",
        { file_path: join(dir, ".GIT", "hooks", "pre-commit"), content: "x" },
        dir
      ).allowable
    ).toBe(true);
    // A plain in-scope file still allows — the fold matches whole
    // components, not substrings.
    writeFileSync(join(dir, "a.ts"), "x");
    expect(
      claudeCeiling(
        "medium",
        "Edit",
        { file_path: join(dir, "a.ts"), old_string: "x", new_string: "y" },
        dir
      ).allowable
    ).toBe(true);
  });

  test("a decomposed-name sibling cannot ride the NFC fold into the scope", () => {
    // Review live11, minor 7: the NFC fold exists so an NFD-spelled
    // launch directory still matches its own files, but on a
    // normalization-preserving filesystem (Linux) a sibling directory
    // whose name is the COMPOSED spelling of the launch directory's own
    // name composes onto the scope string and would ride the NFC
    // comparison to "inside". Containment now also demands the raw bytes
    // sit inside the launch directory's own raw disk spelling. The
    // collision needs a normalization-preserving filesystem, so the
    // decision is exercised as a pure function here.
    const decomposed = "café"; // NFD: e + combining acute
    const composed = decomposed.normalize("NFC"); // é as one character
    const rawScope = `/work/${decomposed}`; // the disk's bytes (Linux)
    const scope = `/work/${composed}`; // the grant scope (NFC)
    // A target inside the launch directory by its own decomposed
    // spelling: both forms agree, both raw spellings agree — inside.
    const own = { raw: `/work/${decomposed}/f`, nfc: `/work/${composed}/f` };
    expect(spellingsInsideScope(scope, rawScope, own, own)).toBe(true);
    // The sibling: NFC-inside is true (the fold maps it onto the scope),
    // but the raw bytes are another directory's — outside.
    const sibling = { raw: `/work/${composed}/f`, nfc: `/work/${composed}/f` };
    expect(spellingsInsideScope(scope, rawScope, sibling, sibling)).toBe(false);
    // ASCII paths never notice the rule.
    const ascii = { raw: "/work/plain/f", nfc: "/work/plain/f" };
    expect(spellingsInsideScope("/work/plain", "/work/plain", ascii, ascii)).toBe(true);
  });

  test("an NFD-spelled launch directory still matches its own files (the fold's purpose)", () => {
    // The macOS control for the raw-agreement rule: APFS keeps the
    // decomposed bytes the launch directory was created with, while the
    // grant scope is composed. A plain in-scope target must still allow
    // — the new raw containment may not break the case the fold exists
    // for. (The sibling collision itself cannot be built on this disk:
    // APFS is normalization-insensitive, so the composed-named sibling
    // IS the same directory.)
    const root = tempDir();
    const launch = join(root, "café");
    mkdirSync(launch);
    expect(pathInsideScope(join(launch, "notes.txt"), launch).allowable).toBe(true);
    expect(pathInsideScope(join(launch, "sub", "notes.txt"), launch).allowable).toBe(true);
  });
});
