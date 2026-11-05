import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import * as fs from "node:fs";
import { claudeCeiling } from "../src/session/ceiling.js";
import { tempDir } from "./helpers/session-ceiling.js";

describe("claude ceiling path normalization", () => {
  test("a `..` after a missing directory cannot walk out of the scope", () => {
    // The review's worked example: `/repo/nonexist/../../etc/x` survives a
    // naive deepest-existing-ancestor realpath as a literal string that
    // starts with `/repo/`, but the harness resolves it to `/etc/x`. The
    // re-attached tail must be normalized before the comparison — hence
    // the hand-built string: `join` would lexically fold the `..`s away
    // and never exercise the path.
    const dir = tempDir();
    const verdict = claudeCeiling(
      "medium",
      "Write",
      { file_path: `${dir}/nonexist/../../etc/x`, content: "x" },
      dir
    );
    expect(verdict.allowable).toBe(false);
    expect(verdict.reason).toContain("resolves outside the launch directory");
  });

  test("a `..` over a missing directory cannot route through a symlink, in either spelling", () => {
    // Review live5, security 1: `resolveRealPath` re-attaches the
    // not-yet-existing tail with `resolve`, which collapses `..`
    // lexically — so the kernel spelling of `<scope>/gone/../flee/x`
    // keeps the link's NAME inside the scope and never follows it, while
    // the real write goes wherever the link points. The mirror image
    // (`<scope>/flee/../x`) hides behind the kernel spelling instead.
    // Both spellings are judged; either disagreement denies. (The codex
    // fileChange ceiling shares pathInsideScope, so this covers patch
    // approvals too.)
    const dir = tempDir();
    const outsideTarget = tempDir();
    writeFileSync(join(outsideTarget, "settings.json"), "secret");
    symlinkSync(outsideTarget, join(dir, "flee-link"));
    const edit = (file_path: string) =>
      claudeCeiling("medium", "Edit", { file_path, old_string: "x", new_string: "y" }, dir);
    // The kernel spelling stays in scope, the lexical spelling follows
    // the link out: deny.
    expect(edit(`${dir}/gone/../flee-link/settings.json`).allowable).toBe(false);
    // The lexical spelling stays in scope, the kernel spelling follows
    // the link out: deny.
    expect(edit(`${dir}/flee-link/../settings.json`).allowable).toBe(false);
    // The control: the same `..` over the same missing directory, with
    // no symlink anywhere, still allows — only the disagreement denies.
    expect(edit(`${dir}/gone/../plain/settings.json`).allowable).toBe(true);
  });

  test("the root launch directory grants every absolute path at medium", () => {
    // grantRule("/") is `Edit(///**)`; the scope it encodes is the root
    // itself, so a session launched at / must not deny every medium edit
    // with "cannot build a safe grant".
    const existing = "/etc/hosts";
    const verdict = claudeCeiling(
      "medium",
      "Edit",
      { file_path: existing, old_string: "x", new_string: "y" },
      "/"
    );
    expect(verdict.allowable).toBe(true);
  });

  test("a relative `..` cannot route through a symlink out of the scope", () => {
    // Review live7, security 1, in the finding's own shape — homebrew's:
    // `<opt>/bun` links to `../Cellar/bun/1.4.2`, so from `<opt>` the
    // spelling `bun/../1.4.2/INSTALL_RECEIPT.json` names, after the
    // kernel follows the link and only then applies `..`, a file under
    // Cellar — outside the scope. The join used to `resolve` the target
    // before symlink expansion, collapsing `..` first and handing both
    // spellings the lexical form `<scope>/1.4.2/…`: the link never
    // mattered and the read was called inside. Relative components now
    // survive until expansion, the kernel spelling lands outside, and
    // the disagreement denies. (The codex fileChange ceiling shares
    // pathInsideScope, so patch approvals get the same judgment.)
    const parent = mkdtempSync(join(tmpdir(), "cmx-ceiling-"));
    const scope = join(parent, "opt");
    const cellar = join(parent, "Cellar", "bun", "1.4.2");
    mkdirSync(scope, { recursive: true });
    mkdirSync(cellar, { recursive: true });
    writeFileSync(join(cellar, "INSTALL_RECEIPT.json"), "{}");
    symlinkSync("../Cellar/bun/1.4.2", join(scope, "bun"), "dir");
    const edit = (file_path: string) =>
      claudeCeiling("medium", "Edit", { file_path, old_string: "x", new_string: "y" }, scope);
    expect(edit("bun/../1.4.2/INSTALL_RECEIPT.json").allowable).toBe(false);
    // The equivalent absolute spelling denies too — the parity the
    // finding noted.
    expect(edit(`${scope}/bun/../1.4.2/INSTALL_RECEIPT.json`).allowable).toBe(false);
    // The control: the same relative `..` over the same missing `gone`,
    // with no symlink anywhere, still allows — only the disagreement
    // denies.
    expect(edit("gone/../1.4.2/INSTALL_RECEIPT.json").allowable).toBe(true);
  });

  test("a `..` inside a relative symlink target applies after the links it names", () => {
    // Review live10, correctness 1: the walk used `resolve` to join a
    // relative link target onto the link's directory, collapsing the
    // target's own `..` before the links INSIDE that target were
    // expanded. The finding's layout: `S -> <outside>` (absolute),
    // `L -> S/../.ssh` (relative), an empty `<dir>/.ssh` — so a Write to
    // `L/../.zshrc` produced two in-scope spellings while the kernel,
    // following L then S and applying `..` to the resolved target,
    // writes `<outside>/../.zshrc`. The join is literal now; the kernel
    // spelling lands outside and the disagreement denies. (The codex
    // fileChange ceiling shares pathInsideScope, so patch approvals get
    // the same judgment.)
    const dir = tempDir();
    const outside = tempDir();
    mkdirSync(join(dir, ".ssh"));
    symlinkSync(outside, join(dir, "S"));
    symlinkSync("S/../.ssh", join(dir, "L"));
    const verdict = claudeCeiling(
      "medium",
      "Write",
      { file_path: `${dir}/L/../.zshrc`, content: "x" },
      dir
    );
    expect(verdict.allowable).toBe(false);
    // Controls pin that only the colliding-dots shape denies: a dot-free
    // relative link target still allows, and so does a dotted target
    // whose dots traverse directories that exist on both spellings (the
    // tightening never denies a kernel-resolvable target).
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "f.ts"), "x");
    symlinkSync("real", join(dir, "L2"));
    expect(
      claudeCeiling("medium", "Edit", { file_path: `${dir}/L2/f.ts`, old_string: "x", new_string: "y" }, dir).allowable
    ).toBe(true);
    mkdirSync(join(dir, "inside"));
    writeFileSync(join(dir, "inside", "g.ts"), "x");
    symlinkSync("real/../inside", join(dir, "L3"));
    expect(
      claudeCeiling("medium", "Edit", { file_path: `${dir}/L3/g.ts`, old_string: "x", new_string: "y" }, dir).allowable
    ).toBe(true);
  });

  test("a ~-spelled or whitespace-padded target denies: codemux cannot judge where the write lands", () => {
    // Review live6, security 1: Claude Code trims surrounding whitespace
    // and expands a leading `~`/`~/…` to the home directory BEFORE it
    // writes, while the scope check resolved both as ordinary relative
    // names inside the launch directory — the ceiling called `~/.bashrc`
    // and `" /etc/hosts"` inside while the harness wrote outside. Those
    // spellings deny instead. The `~` refusal is blanket on `~`-initial
    // spellings (the fail-closed side: a file literally named `~x` is
    // pathological, and splitting `~` from `~user` would lean on
    // unverified expansion rules). (The codex fileChange ceiling shares
    // pathInsideScope, so patch approvals get the same refusal.)
    const dir = tempDir();
    const write = (file_path: string) =>
      claudeCeiling("medium", "Write", { file_path, content: "x" }, dir);
    expect(write("~/.bashrc").allowable).toBe(false);
    expect(write("~").allowable).toBe(false);
    expect(write("~zshrc").allowable).toBe(false);
    expect(write(" /etc/hosts").allowable).toBe(false);
    expect(write("/etc/hosts ").allowable).toBe(false);
    expect(write(" ~").allowable).toBe(false);
    // The control: plain relative targets are still judged, not refused —
    // a medium edit of a workspace-relative file is the level's core case.
    expect(write("notes/new.ts").allowable).toBe(true);
    expect(write("./notes/new.ts").allowable).toBe(true);
  });

  test("exactly forty symlink substitutions resolve; forty-one deny (review round 137)", () => {
    // The expansion bound denied its own boundary: the fortieth
    // substitution updated the path, the loop ended, and the result was
    // never looked at, so a valid chain of exactly the bound's links read
    // as unresolvable. The chain is served through fs spies because the
    // macOS kernel itself refuses chains over 32 links (ELOOP at 33, the
    // probe for this test), so a real 40-link chain cannot ask this host
    // the question; the walk under test is the code's own, on a virtual
    // chain whose every link the test controls.
    const dir = realpathSync(tempDir());
    writeFileSync(join(dir, "settings.txt"), "x");
    const linkStats = {
      isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false, dev: 0, ino: 0,
    } as unknown as fs.Stats;
    const edit = (links: number) => {
      const virtual = new Map<string, string>(); // link path -> read target
      for (let i = 1; i <= links; i += 1) {
        virtual.set(join(dir, `chain-${i}`), i === 1 ? "settings.txt" : `chain-${i - 1}`);
      }
      const resolveVirtual = (path: string): string => {
        let current = path;
        for (;;) {
          const target = virtual.get(current);
          if (target === undefined) return current;
          current = isAbsolute(target) ? target : join(dirname(current), target);
        }
      };
      const original = {
        lstat: fs.lstatSync, readlink: fs.readlinkSync, realpath: fs.realpathSync,
      };
      type LstatArgs = Parameters<typeof fs.lstatSync>;
      const stat = spyOn(fs, "lstatSync").mockImplementation(((...args: LstatArgs) =>
        virtual.has(String(args[0])) ? linkStats : original.lstat(...args)) as typeof fs.lstatSync);
      type ReadlinkArgs = Parameters<typeof fs.readlinkSync>;
      const read = spyOn(fs, "readlinkSync").mockImplementation(((...args: ReadlinkArgs) =>
        virtual.get(String(args[0])) ?? original.readlink(...args)) as typeof fs.readlinkSync);
      type RealpathArgs = Parameters<typeof fs.realpathSync>;
      const real = spyOn(fs, "realpathSync").mockImplementation(((...args: RealpathArgs) =>
        virtual.has(String(args[0])) ? resolveVirtual(String(args[0])) : original.realpath(...args)) as typeof fs.realpathSync);
      try {
        return claudeCeiling(
          "medium", "Edit",
          { file_path: join(dir, `chain-${links}`), old_string: "x", new_string: "y" },
          dir
        );
      } finally {
        stat.mockRestore();
        read.mockRestore();
        real.mockRestore();
      }
    };
    expect(edit(39).allowable).toBe(true);
    expect(edit(40).allowable).toBe(true); // the bound's own count
    const denied = edit(41);
    expect(denied.allowable).toBe(false);
    expect(denied.reason).toContain("cannot resolve target path");
  });
});
