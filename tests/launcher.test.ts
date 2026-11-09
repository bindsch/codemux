/**
 * The launcher's runtime resolution (audit gap 4): bun comes from the first
 * absolute PATH entry that holds it, and a directory that is not owned by
 * this user or root, or is world-writable (sticky or not), is refused
 * before anything runs. A group-writable directory passes — the usagemux
 * backend rule, so a shared /usr/local/bin (admin group) works — while the
 * bun file itself must carry no group or world write bit.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LAUNCHER = resolve("bin/codemux");

describe("bin/codemux bun resolution", () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fakeBunDirectory(mode: number): string {
    const root = mkdtempSync(join(tmpdir(), "codemux-launcher-"));
    scratch.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin, { mode: 0o755 });
    chmodSync(bin, mode);
    writeFileSync(join(bin, "bun"), "#!/bin/sh\necho FAKE-BUN-RAN \"$@\"\n", { mode: 0o755 });
    chmodSync(join(bin, "bun"), 0o755);
    return bin;
  }

  const runLauncher = (path: string, cwd: string = process.cwd()) =>
    Bun.spawnSync(["/bin/sh", LAUNCHER, "arg"], { cwd, env: { PATH: path } });

  // Runs the launcher with the pin set, exactly as the Homebrew formula
  // installs it: a copy with the codemux_pinned_bun= line rewritten to the
  // pinned path (the formula's inreplace), PATH untouched.
  const runPinnedLauncher = (pinnedBun: string, path: string) => {
    const root = mkdtempSync(join(tmpdir(), "codemux-launcher-pin-"));
    scratch.push(root);
    const pinned = join(root, "codemux");
    writeFileSync(
      pinned,
      readFileSync(LAUNCHER, "utf8").replace("codemux_pinned_bun=", `codemux_pinned_bun=${pinnedBun}`)
    );
    chmodSync(pinned, 0o755);
    return Bun.spawnSync(["/bin/sh", pinned, "arg"], { cwd: process.cwd(), env: { PATH: path } });
  };

  test("a relative codemux_pinned_bun is refused, never walked (review round 25)", () => {
    const result = runPinnedLauncher("bun", "/usr/bin:/bin");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("codemux_pinned_bun must be an absolute path: bun");
  });

  // A cycle must die on its own: the timeout is the regression guard, so
  // a removed hop cap cannot hang the suite — the refusal below would
  // spin forever without it.
  const runLauncherBounded = (path: string, cwd: string = process.cwd()) =>
    Bun.spawnSync(["/bin/sh", LAUNCHER, "arg"], { cwd, env: { PATH: path }, timeout: 10_000 });

  test("a bun in a world-writable directory is refused, not executed", () => {
    const bin = fakeBunDirectory(0o777);
    const result = runLauncher(bin);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("refusing to run bun");
    expect(result.stderr.toString()).toContain("world-writable");
    expect(result.stderr.toString()).not.toContain("group-");
    expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });

  test("a bun in a group-writable directory is accepted", () => {
    // /usr/local/bin is group-writable (admin) on many macOS installs; the
    // directory rule refuses world-writable only, the usagemux backend rule.
    const bin = fakeBunDirectory(0o775);
    const result = runLauncher(bin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("FAKE-BUN-RAN --no-env-file");
  });

  test("a bun file that is itself group-writable is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "codemux-launcher-file-"));
    scratch.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin, { mode: 0o755 });
    writeFileSync(join(bin, "bun"), "#!/bin/sh\necho FAKE-BUN-RAN \"$@\"\n", { mode: 0o775 });
    // writeFileSync applies umask; pin the mode explicitly.
    chmodSync(join(bin, "bun"), 0o775);
    const result = runLauncher(bin);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("refusing to run bun");
    expect(result.stderr.toString()).toContain("group- or world-writable");
    expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });

  test("a bun file that is world-writable but not group-writable is refused", () => {
    // 0o757 (-rwxr-xrwx): the world write bit sits at mode position 9, the
    // group bit at position 6. A pattern testing position 6 alone accepted
    // this file (review round 12, edges 1).
    const bin = fakeBunDirectory(0o755);
    chmodSync(join(bin, "bun"), 0o757);
    const result = runLauncher(bin);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("group- or world-writable");
    expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });

  test("a bun in a trusted directory is executed by its absolute path", () => {
    const bin = fakeBunDirectory(0o755);
    const result = runLauncher(bin);
    expect(result.exitCode).toBe(0);
    // The fake receives the launcher's runtime arguments, then the caller's.
    expect(result.stdout.toString()).toContain("FAKE-BUN-RAN --no-env-file");
    expect(result.stdout.toString().trim().endsWith("arg")).toBe(true);
  });

  test("a relative PATH entry is skipped even when it holds bun", () => {
    const bin = fakeBunDirectory(0o755);
    const result = runLauncher(".", bin);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("no bun executable in any absolute PATH entry");
    expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });

  test("a world-writable PATH entry is refused even when the resolved bun sits elsewhere", () => {
    const root = mkdtempSync(join(tmpdir(), "codemux-launcher-link-"));
    scratch.push(root);
    const trusted = fakeBunDirectory(0o755);
    const loose = join(root, "loose");
    mkdirSync(loose, { mode: 0o755 });
    chmodSync(loose, 0o777);
    symlinkSync(join(trusted, "bun"), join(loose, "bun"));
    const result = runLauncher(loose);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("refusing to run bun");
    expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });

  test("a two-link symlink cycle is refused at the hop cap, not followed forever", () => {
    // bun -> bun2 -> bun: each hop is within one trusted directory, so
    // only the hop count ends it. Before the cap this loop never
    // terminated (review round 2, edges minor 4).
    const root = mkdtempSync(join(tmpdir(), "codemux-launcher-cycle-"));
    scratch.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin, { mode: 0o755 });
    symlinkSync("bun2", join(bin, "bun"));
    symlinkSync("bun", join(bin, "bun2"));
    const result = runLauncherBounded(bin);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "its path is a symlink chain longer than 32 hops; it does not resolve to a real file"
    );
    expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });

  test("a pinned bun runs even when PATH holds no bun at all", () => {
    // The Homebrew install contract: the formula pins the keg's bun, so
    // PATH resolution never runs — an empty PATH is the proof.
    const trusted = fakeBunDirectory(0o755);
    const result = runPinnedLauncher(join(trusted, "bun"), "");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("FAKE-BUN-RAN --no-env-file");
    expect(result.stdout.toString().trim().endsWith("arg")).toBe(true);
  });

  test("a pinned bun in a world-writable directory is refused, not executed", () => {
    // The pinned path gets the same trust checks as a PATH-resolved one:
    // a writable pin cannot choose the runtime.
    const bin = fakeBunDirectory(0o777);
    const result = runPinnedLauncher(join(bin, "bun"), "");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("refusing to run bun");
    expect(result.stderr.toString()).toContain("world-writable");
    expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });

  test("a pinned bun that is itself group-writable is refused, not executed", () => {
    const bin = fakeBunDirectory(0o755);
    chmodSync(join(bin, "bun"), 0o775);
    const result = runPinnedLauncher(join(bin, "bun"), "");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("group- or world-writable");
    expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });

  test("a non-executable bun target is refused by the launcher, not at exec (round 16, edges 5)", () => {
    // A pin skips discovery and the trust checks never look at the
    // execute bit, so a 0644 target passed every check and died at exec
    // with the shell's exit 126 instead of the launcher's refusal. The
    // PATH form reaches the same check through a symlink: a link passes
    // discovery even when its target is not executable.
    const bin = fakeBunDirectory(0o755);
    chmodSync(join(bin, "bun"), 0o644);
    const pinned = runPinnedLauncher(join(bin, "bun"), "");
    expect(pinned.exitCode).toBe(1);
    expect(pinned.stderr.toString()).toContain("is not executable");
    expect(pinned.stdout.toString()).not.toContain("FAKE-BUN-RAN");

    const root = mkdtempSync(join(tmpdir(), "codemux-launcher-nox-"));
    scratch.push(root);
    const linkDir = join(root, "link-bin");
    mkdirSync(linkDir, { mode: 0o755 });
    symlinkSync(join(bin, "bun"), join(linkDir, "bun"));
    const viaLink = runLauncher(linkDir);
    expect(viaLink.exitCode).toBe(1);
    expect(viaLink.stderr.toString()).toContain("is not executable");
    expect(viaLink.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });

  test("an empty pin falls back to the PATH search", () => {
    // The checkout launcher (empty pin) resolves from PATH as before.
    const bin = fakeBunDirectory(0o755);
    const result = runLauncher(bin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("FAKE-BUN-RAN --no-env-file");
  });

  test("a PATH entry that is a symlink to a trusted directory is accepted", () => {
    // GNU stat without -L reads the link's own mode (always 0777) and
    // refuses every such entry as world-writable; BSD stat needed -L all
    // along. The launcher must judge the target directory.
    const trusted = fakeBunDirectory(0o755);
    const root = mkdtempSync(join(tmpdir(), "codemux-launcher-dirlink-"));
    scratch.push(root);
    const linked = join(root, "linked-bin");
    symlinkSync(trusted, linked, "dir");
    const result = runLauncher(linked);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("FAKE-BUN-RAN --no-env-file");
  });

  test("the launcher decides the stat dialect once and spells each variant exactly once", () => {
    // The BSD-form-first probe garbled GNU stat's output on Linux (review
    // round 11, contracts blocker): the dialect must be picked from
    // --version and each variant invoked exactly once, with no fallback
    // chain whose output could be appended to a captured variable. The
    // shape rule itself runs on this machine's BSD stat in every test
    // above; the Linux (GNU) path is covered by CI's ubuntu runner
    // (./bin/codemux --help smoke and the installed-layout gate). An
    // environment override of the trust-checking stat binary is not an
    // acceptable test seam, so the variant structure is pinned statically.
    const text = readFileSync(LAUNCHER, "utf8");
    expect(text.match(/"\$stat_tool" --version 2>\/dev\/null \|\| "\$stat_tool" --help 2>&1 \|\| true/g)).toHaveLength(1);
    // BusyBox stat takes the GNU format (review round 25, edges 1), and so
    // does uutils, Ubuntu 26.04's /usr/bin/stat (CI run 42681779732).
    expect(text).toContain('*"GNU coreutils"*|*"uutils coreutils"*|*BusyBox*|*oybox*)');
    expect(text.match(/"\$stat_tool" -L -f '%u %Sp' "\$1" 2>\/dev\/null/g)).toHaveLength(1);
    expect(text.match(/"\$stat_tool" -L -c '%u %A' "\$1" 2>\/dev\/null/g)).toHaveLength(1);
    expect(text).not.toContain("&& return 0");
  });

  test("the trust-checking tools resolve from a fixed location list, never PATH (round 17, edges 3)", () => {
    // /usr/bin hardcoding broke distributions whose coreutils live
    // elsewhere (NixOS); a PATH lookup would let a planted entry
    // substitute the tools that verify the runtime. The launcher must
    // name the candidate list once and invoke readlink, id, and stat
    // only through the resolved variables.
    const text = readFileSync(LAUNCHER, "utf8");
    expect(text.match(
      /tool_dirs='\/usr\/bin \/bin \/run\/current-system\/sw\/bin \/usr\/local\/bin \/opt\/homebrew\/bin'/g
    )).toHaveLength(1);
    // No hardcoded absolute call to any of the three tools remains.
    for (const tool of ["readlink", "id", "stat"]) {
      expect(text).not.toContain(`/usr/bin/${tool} `);
      expect(text).not.toContain(`/bin/${tool} "`);
    }
    // Every invocation rides the resolved variables, spelled exactly as
    // often as the launcher uses them.
    expect(text.match(/"\$readlink_tool" "/g)).toHaveLength(2);
    expect(text.match(/"\$id_probe" -u/g)).toHaveLength(1);
    // The baseline is re-taken from the validated id (round 32, contracts 1).
    expect(text.match(/"\$id_tool" -u/g)).toHaveLength(1);
    expect(text.match(/trusted_tool readlink/g)).toHaveLength(1);
    expect(text.match(/trusted_tool id/g)).toHaveLength(1);
    expect(text.match(/trusted_tool stat/g)).toHaveLength(1);
  });

  test("a bun under a world-writable non-sticky ancestor is refused", () => {
    // The directory checks cover the bun directory itself, not its
    // parents: a trusted-looking directory under a world-writable
    // non-sticky ancestor can be renamed and replaced by any other user
    // between the check and the exec (review round 11, edges finding 3).
    const root = mkdtempSync(join(tmpdir(), "codemux-launcher-ancestor-"));
    scratch.push(root);
    const loose = join(root, "loose");
    mkdirSync(loose, { mode: 0o777 });
    // mkdir applies umask; pin the mode explicitly.
    chmodSync(loose, 0o777);
    const bin = join(loose, "bin");
    mkdirSync(bin, { mode: 0o755 });
    writeFileSync(join(bin, "bun"), "#!/bin/sh\necho FAKE-BUN-RAN \"$@\"\n", { mode: 0o755 });
    const result = runLauncher(bin);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("world-writable without the sticky bit");
    expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });

  // The scenario needs a temp root whose own ancestors the launcher trusts;
  // a sandbox whose TMPDIR sits under a world-writable, non-sticky directory
  // (review round 22, the edges lane's) makes the launcher refuse the tree
  // for that ancestor, which is the launcher being right about the
  // environment, not about the sticky rule under test.
  const tmpAncestorsTrusted = ((): boolean => {
    let path = realpathSync(tmpdir());
    for (;;) {
      const mode = statSync(path).mode;
      if ((mode & 0o002) !== 0 && (mode & 0o1000) === 0) return false;
      const parent = resolve(path, "..");
      if (parent === path) return true;
      path = parent;
    }
  })();
  test.skipIf(!tmpAncestorsTrusted)("a bun under a sticky world-writable ancestor is accepted", () => {
    // The /tmp rule: the sticky bit protects the trusted name below the
    // world-writable ancestor, so it passes as it always has.
    const root = mkdtempSync(join(tmpdir(), "codemux-launcher-sticky-"));
    scratch.push(root);
    const sticky = join(root, "sticky");
    mkdirSync(sticky, { mode: 0o1777 });
    // mkdir applies umask, and Bun 1.3.14 on macOS silently drops the
    // sticky bit from chmodSync — the mode lands 0777 and the test below
    // then exercises the refusal, not the acceptance (review round 23,
    // edges 7). The chmod binary sets the bit, and the stat asserts it
    // landed rather than trusting either call.
    const chmod = Bun.spawnSync(["chmod", "1777", sticky]);
    expect(chmod.exitCode).toBe(0);
    expect(statSync(sticky).mode & 0o1000).toBe(0o1000);
    const bin = join(sticky, "bin");
    mkdirSync(bin, { mode: 0o755 });
    writeFileSync(join(bin, "bun"), "#!/bin/sh\necho FAKE-BUN-RAN \"$@\"\n", { mode: 0o755 });
    const result = runLauncher(bin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("FAKE-BUN-RAN --no-env-file");
  });

  test("a symlinked bun directory is judged by its resolved ancestors too", () => {
    // owned/link -> ww/bin with ww world-writable and non-sticky: the
    // spelled ancestors (owned, the scratch root) are all trusted, but the
    // exec reaches the bun through ww, whose own ancestors the lexical walk
    // never visited (review round 12, edges 2). The refusal names the real
    // ancestor.
    const root = mkdtempSync(join(tmpdir(), "codemux-launcher-resolved-"));
    scratch.push(root);
    const owned = join(root, "owned");
    mkdirSync(owned, { mode: 0o755 });
    const ww = join(root, "ww");
    mkdirSync(ww, { mode: 0o777 });
    // mkdir applies umask; pin the mode explicitly.
    chmodSync(ww, 0o777);
    const bin = join(ww, "bin");
    mkdirSync(bin, { mode: 0o755 });
    writeFileSync(join(bin, "bun"), "#!/bin/sh\necho FAKE-BUN-RAN \"$@\"\n", { mode: 0o755 });
    symlinkSync(bin, join(owned, "link"), "dir");
    const result = runLauncher(join(owned, "link"));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("world-writable without the sticky bit");
    expect(result.stderr.toString()).toContain(realpathSync(ww));
    expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });

  test("a PATH entry containing a glob character is a literal entry, never an expanded one", () => {
    // The PATH word split used to pathname-expand the entries, so an entry
    // "<dir>/*" selected <dir>/selected/bun — a directory no PATH entry
    // literally names (review round 12, contracts-2 2). The literal entry
    // holds no bun, so resolution falls through to the next literal entry.
    const root = mkdtempSync(join(tmpdir(), "codemux-launcher-glob-"));
    scratch.push(root);
    const selected = join(root, "selected");
    mkdirSync(selected, { mode: 0o755 });
    writeFileSync(join(selected, "bun"), "#!/bin/sh\necho GLOB-BUN-RAN \"$@\"\n", { mode: 0o755 });
    const trusted = fakeBunDirectory(0o755);
    const result = runLauncher(`${root}/*:${trusted}`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("FAKE-BUN-RAN --no-env-file");
    expect(result.stdout.toString()).not.toContain("GLOB-BUN-RAN");
  });
});
