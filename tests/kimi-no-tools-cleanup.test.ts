import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { writeKimiNoToolsFile } from "../src/kimi-no-tools.js";

// Review round 104, findings 1 and 4: the kimi no-tools finalizer removed
// its file with a bare rm after an lstat-only parent check, and it marked
// itself finalized before the removal ran — so a parent swapped between
// creation and cleanup removed the same-named file wherever the replacement
// pointed, and a transiently failed removal left the file behind with the
// exit hook already disarmed. The finalizer now revalidates the parent by
// the identity recorded at creation (src/safe-remove.ts) and arms off only
// after the removal succeeds. Every test restores the real parent and
// finalizes before deleting its temp root, so no exit hook leaks past the
// file that registered it.

// The realpathed temp root: on macOS the OS temp directory is a symlink
// (/var/folders -> /private/var/folders), and the paths compared below are
// built from this root, so it is resolved once up front.
function freshRoot(): string {
  return mkdtempSync(join(realpathSync(tmpdir()), "codemux-kimi-f104-"));
}

/** A brand home with the parent standing and one generated file in it. */
function prepared(root: string): ReturnType<typeof writeKimiNoToolsFile> {
  const brand = join(root, ".kimi-code");
  mkdirSync(brand);
  return writeKimiNoToolsFile(brand);
}

describe("kimi no-tools cleanup (round 104)", () => {
  test("a parent replaced by a symlink is refused; the victim's file survives", () => {
    const root = freshRoot();
    try {
      const file = prepared(root);
      const parent = dirname(file.path);
      // The victim the swapped parent points at, holding a file with the
      // same name as this run's — the one a naive rm would delete.
      const victim = join(root, "victim");
      mkdirSync(victim);
      const victimFile = join(victim, basename(file.path));
      writeFileSync(victimFile, "kept");
      const moved = join(root, "parent-moved");
      renameSync(parent, moved);
      symlinkSync(victim, parent);
      expect(() => file.finalize()).toThrow(/the directory was kept/);
      expect(victimFile && existsSync(victimFile)).toBe(true);
      // This run's own file is untouched too: nothing was removed at all.
      expect(existsSync(file.path)).toBe(true);
      // Restore the real parent and finalize, releasing the exit hook.
      rmSync(parent);
      renameSync(moved, parent);
      file.finalize();
      expect(existsSync(file.path)).toBe(false);
      expect(existsSync(victimFile)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a parent replaced by another directory is refused by identity", () => {
    // The round-104 shape the lstat check could not catch: the replacement
    // is a real, user-owned directory at the same path, so only the
    // recorded device and inode tell it from the parent this run made.
    const root = freshRoot();
    try {
      const file = prepared(root);
      const parent = dirname(file.path);
      const moved = join(root, "parent-moved");
      renameSync(parent, moved);
      mkdirSync(parent);
      const decoy = join(parent, basename(file.path));
      writeFileSync(decoy, "decoy");
      expect(() => file.finalize()).toThrow(/no longer the directory.*the directory was kept/);
      expect(existsSync(decoy)).toBe(true);
      expect(existsSync(file.path)).toBe(true);
      // Restore and finalize, releasing the exit hook.
      rmSync(parent, { recursive: true, force: true });
      renameSync(moved, parent);
      file.finalize();
      expect(existsSync(file.path)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failed removal stays retryable: the finalizer arms off only after success", () => {
    // Finding 1's core: `finalized` used to be set before the removal, so a
    // removal that failed left the file behind with the exit hook already
    // disarmed. The parent is made unwritable for one attempt; the file
    // stays, the hook stays registered, and the second attempt succeeds.
    const root = freshRoot();
    const parentOf = (path: string): string => dirname(path);
    try {
      const before = new Set(process.listeners("exit"));
      const file = prepared(root);
      const parent = parentOf(file.path);
      const hooks = process.listeners("exit").filter((hook) => !before.has(hook));
      expect(hooks).toHaveLength(1);
      chmodSync(parent, 0o500);
      expect(() => file.finalize()).toThrow(/could not remove.*the directory was kept/);
      expect(existsSync(file.path)).toBe(true);
      // The failed attempt did not disarm the exit hook.
      expect(process.listeners("exit")).toContain(hooks[0]!);
      chmodSync(parent, 0o700);
      file.finalize();
      expect(existsSync(file.path)).toBe(false);
      expect(process.listeners("exit")).not.toContain(hooks[0]!);
    } finally {
      try {
        chmodSync(join(root, ".kimi-code", ".codemux"), 0o700);
      } catch {
        // The parent may never have been made, or is already gone.
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
