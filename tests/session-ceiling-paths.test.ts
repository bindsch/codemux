import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
