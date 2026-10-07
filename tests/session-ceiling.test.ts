import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeCeiling,
  foldForProtectedLookup,
  knownClaudeTools,
  pathInsideScope,
  spellingsInsideScope,
} from "../src/session/ceiling.js";

/** Tools present in the recorded init `tools` fixture but absent from
 * the ceiling table would fall to default deny — correct but silent.
 * Anything here is a deliberate extra: named by claude versions other
 * than the recorded one, kept so drift shows up in the diff below. */
const DOCUMENTED_EXTRAS = [
  "Agent",
  "BashOutput",
  "Glob",
  "Grep",
  "KillShell",
  "LS",
  "SlashCommand",
  "TodoWrite",
];

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cmx-ceiling-"));
}

describe("the tool table tracks the recorded harness", () => {
  test("every tool in the recorded init fixture is known to the ceiling", () => {
    const text = readFileSync(
      join(import.meta.dir, "fixtures/live/zai-permission3.ndjson"),
      "utf8"
    );
    const tools = (text
      .trim()
      .split("\n")
      .map((record) => JSON.parse(record))
      .filter((entry: { dir: string }) => entry.dir === "out")
      .map((entry: { line: string }) => JSON.parse(entry.line))
      .find((event: { type?: string; subtype?: string }) =>
        event.type === "system" && event.subtype === "init"
      )!.tools) as string[];
    expect(tools.length).toBe(26);
    const known = new Set(knownClaudeTools());
    const missing = tools.filter((tool) => !known.has(tool));
    expect(missing).toEqual([]);
  });

  test("the table holds the fixture tools plus the documented extras only", () => {
    const known = knownClaudeTools();
    const fixtureAndExtras = new Set([
      "Task", "AskUserQuestion", "Bash", "CronCreate", "CronDelete",
      "CronList", "DesignSync", "Edit", "EnterPlanMode", "EnterWorktree",
      "ExitPlanMode", "ExitWorktree", "ListAgents", "Monitor",
      "NotebookEdit", "PushNotification", "Read", "ReportFindings",
      "ScheduleWakeup", "SendMessage", "Skill", "TaskStop", "WebFetch",
      "WebSearch", "Workflow", "Write",
      ...DOCUMENTED_EXTRAS,
    ]);
    expect(known.sort()).toEqual([...fixtureAndExtras].sort());
  });
});

describe("claude ceiling by level", () => {
  test("read-only denies everything, including the editing tools", () => {
    const dir = tempDir();
    for (const [tool, input] of [
      ["Edit", { file_path: join(dir, "a.ts"), old_string: "x", new_string: "y" }],
      ["Write", { file_path: join(dir, "a.ts"), content: "x" }],
      ["Bash", { command: "ls" }],
      ["Read", { file_path: join(dir, "a.ts") }],
      ["mcp__x__y", {}],
      ["NeverHeardOf", {}],
    ] as const) {
      const verdict = claudeCeiling("read-only", tool, input as Record<string, unknown>, dir);
      expect(verdict.allowable).toBe(false);
      expect(verdict.reason.length).toBeGreaterThan(0);
    }
  });

  test("low allows everything, unknown tools included (the caller answers)", () => {
    const dir = tempDir();
    expect(claudeCeiling("low", "Bash", { command: "rm -rf /" }, dir).allowable).toBe(true);
    expect(claudeCeiling("low", "mcp__x__y", {}, dir).allowable).toBe(true);
    expect(claudeCeiling("low", "Whatever", { odd: true }, dir).allowable).toBe(true);
    expect(claudeCeiling("low", "WebFetch", { url: "https://x" }, dir).allowable).toBe(true);
  });

  test("low still denies a known tool whose arguments codemux cannot read", () => {
    const dir = tempDir();
    const verdict = claudeCeiling("low", "Bash", { command: "ls", sneaky: 1 }, dir);
    expect(verdict.allowable).toBe(false);
    expect(verdict.reason).toContain("known schema");
  });

  test("medium allows the editing tools inside the launch directory", () => {
    const dir = tempDir();
    expect(
      claudeCeiling("medium", "Edit", { file_path: join(dir, "a.ts"), old_string: "x", new_string: "y" }, dir).allowable
    ).toBe(true);
    expect(
      claudeCeiling("medium", "Write", { file_path: join(dir, "sub", "new.ts"), content: "x" }, dir).allowable
    ).toBe(true);
    expect(
      claudeCeiling("medium", "NotebookEdit", { notebook_path: `${dir}/nb.ipynb`, new_source: "x" }, dir).allowable
    ).toBe(true);
    // A relative target resolves against the launch directory.
    expect(
      claudeCeiling("medium", "Edit", { file_path: "notes/x.txt", old_string: "x", new_string: "y" }, dir).allowable
    ).toBe(true);
  });

  test("medium denies targets outside the launch directory", () => {
    const dir = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "victim.ts"), "x");
    expect(
      claudeCeiling("medium", "Edit", { file_path: join(outside, "victim.ts"), old_string: "x", new_string: "y" }, dir).allowable
    ).toBe(false);
    expect(
      claudeCeiling("medium", "Write", { file_path: "/etc/passwd", content: "x" }, dir).allowable
    ).toBe(false);
    // `..` cannot walk out of the scope.
    expect(
      claudeCeiling("medium", "Write", { file_path: join(dir, "..", "escape.ts"), content: "x" }, dir).allowable
    ).toBe(false);
  });

  test("medium denies Bash, reads, and ungranted tools", () => {
    const dir = tempDir();
    expect(claudeCeiling("medium", "Bash", { command: "ls" }, dir).allowable).toBe(false);
    expect(claudeCeiling("medium", "Read", { file_path: join(dir, "a.ts") }, dir).allowable).toBe(false);
    expect(claudeCeiling("medium", "WebFetch", { url: "https://x" }, dir).allowable).toBe(false);
    expect(claudeCeiling("medium", "mcp__x__y", {}, dir).allowable).toBe(false);
    expect(claudeCeiling("medium", "NeverHeardOf", {}, dir).allowable).toBe(false);
  });

  test("high grants the mapping's list and denies the rest", () => {
    const dir = tempDir();
    const outside = tempDir();
    expect(
      claudeCeiling("high", "Edit", { file_path: join(outside, "anywhere.ts"), old_string: "x", new_string: "y" }, dir).allowable
    ).toBe(true);
    expect(claudeCeiling("high", "Write", { file_path: "/etc/hosts", content: "x" }, dir).allowable).toBe(true);
    expect(claudeCeiling("high", "NotebookEdit", { notebook_path: "/tmp/n.ipynb", new_source: "x" }, dir).allowable).toBe(true);
    expect(claudeCeiling("high", "Bash", { command: "ls" }, dir).allowable).toBe(true);
    expect(claudeCeiling("high", "Read", { file_path: join(dir, "a.ts") }, dir).allowable).toBe(false);
    expect(claudeCeiling("high", "WebFetch", { url: "https://x" }, dir).allowable).toBe(false);
    expect(claudeCeiling("high", "NeverHeardOf", {}, dir).allowable).toBe(false);
  });
});

describe("claude ceiling argument checks", () => {
  test("missing or non-string target path denies", () => {
    const dir = tempDir();
    expect(claudeCeiling("medium", "Edit", { old_string: "x", new_string: "y" }, dir).allowable).toBe(false);
    expect(claudeCeiling("medium", "Edit", { file_path: 42, old_string: "x", new_string: "y" }, dir).allowable).toBe(false);
    expect(claudeCeiling("medium", "Edit", { file_path: "", old_string: "x", new_string: "y" }, dir).allowable).toBe(false);
    expect(claudeCeiling("medium", "NotebookEdit", { new_source: "x" }, dir).allowable).toBe(false);
  });

  test("an argument outside the tool's schema denies at every judgeable level", () => {
    const dir = tempDir();
    const input = { file_path: join(dir, "a.ts"), old_string: "x", new_string: "y", extra: true };
    // read-only already denies with its own reason; the schema rule is
    // what gates the levels that could otherwise allow.
    expect(claudeCeiling("read-only", "Edit", input, dir).allowable).toBe(false);
    for (const level of ["low", "medium", "high"] as const) {
      expect(claudeCeiling(level, "Edit", input, dir).reason).toContain("known schema");
    }
  });

  test("a symlink pointing outside the scope denies; one staying inside allows", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "real"));
    const outsideTarget = tempDir();
    writeFileSync(join(dir, "real", "stay.ts"), "x");
    writeFileSync(join(outsideTarget, "flee.ts"), "x");
    symlinkSync(join(dir, "real"), join(dir, "stay-link"));
    symlinkSync(outsideTarget, join(dir, "flee-link"));
    expect(
      claudeCeiling("medium", "Edit", { file_path: join(dir, "stay-link", "stay.ts"), old_string: "x", new_string: "y" }, dir).allowable
    ).toBe(true);
    expect(
      claudeCeiling("medium", "Edit", { file_path: join(dir, "flee-link", "flee.ts"), old_string: "x", new_string: "y" }, dir).allowable
    ).toBe(false);
  });

  test("a dangling symlink denies, even though its name sits inside the scope", () => {
    // Review live3, security 1: `repo/notes -> <outside>/not-there-yet`
    // made realpathSync throw ENOENT, and the resolver used to glue the
    // link's name back onto the resolved parent — an in-scope verdict for
    // a Write that follows the link and creates the target OUTSIDE the
    // launch directory. A link whose destination cannot be resolved is
    // unjudgeable: deny (the codex fileChange ceiling shares
    // pathInsideScope, so the same verdict covers patch approvals).
    const dir = tempDir();
    const outsideTarget = tempDir();
    symlinkSync(
      join(outsideTarget, "not-there-yet"),
      join(dir, "notes")
    );
    const verdict = claudeCeiling("medium", "Write", { file_path: join(dir, "notes"), content: "x" }, dir);
    expect(verdict.allowable).toBe(false);
    expect(verdict.reason).toContain("cannot resolve target path");
    expect(pathInsideScope(join(dir, "notes"), dir).allowable).toBe(false);
    // The control: an ordinary missing file inside the scope still
    // allows — a Write creating a new file is the normal case.
    expect(
      claudeCeiling("medium", "Write", { file_path: join(dir, "brand-new.ts"), content: "x" }, dir).allowable
    ).toBe(true);
  });

  test("a launch directory whose grammar cannot carry a grant denies instead of throwing", () => {
    const hostile = mkdtempSync(join(tmpdir(), "cmx-star-*-"));
    const verdict = claudeCeiling(
      "medium",
      "Edit",
      { file_path: join(hostile, "a.ts"), old_string: "x", new_string: "y" },
      hostile
    );
    expect(verdict.allowable).toBe(false);
    expect(verdict.reason).toContain("safe grant");
  });
});

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

describe("medium executable-configuration refusal (review live17)", () => {
  test("medium denies the harness, editor, hook, and shell config paths", () => {
    // Review live17, security major: medium blocked only `.git`, so a
    // caller `allow` let an injected turn write `<cwd>/.claude/settings.json`
    // with a SessionStart hook — the next interactive claude in that
    // directory runs it outside scode. Every path below runs code without
    // anyone running it on purpose; each must deny at medium.
    const dir = tempDir();
    const protectedTargets = [
      join(dir, ".claude", "settings.json"),
      join(dir, ".claude", "settings.local.json"),
      join(dir, ".codex", "config.toml"),
      join(dir, ".gemini", "settings.json"),
      join(dir, ".cursor", "mcp.json"),
      join(dir, ".vscode", "tasks.json"),
      join(dir, ".idea", "workspace.xml"),
      join(dir, ".husky", "pre-commit"),
      join(dir, "pkg", ".envrc"),
      join(dir, ".mcp.json"),
      join(dir, ".gitmodules"),
      join(dir, ".zshrc"),
      join(dir, ".Claude", "Settings.json"),
      join(dir, ".ENVRC"),
    ];
    for (const target of protectedTargets) {
      const verdict = claudeCeiling("medium", "Write", { file_path: target, content: "x" }, dir);
      expect({ target, allowable: verdict.allowable }).toEqual({ target, allowable: false });
      expect(verdict.reason).toContain("executable configuration");
    }
    // The codex fileChange ceiling shares the predicate.
    expect(pathInsideScope(join(dir, ".claude", "settings.json"), dir).allowable).toBe(false);
    // Ordinary files whose names merely resemble the set still allow.
    for (const target of [
      join(dir, "claude", "settings.json"),
      join(dir, "docs", "envrc.md"),
      join(dir, "src", "vscode.ts"),
    ]) {
      expect(
        claudeCeiling("medium", "Write", { file_path: target, content: "x" }, dir).allowable
      ).toBe(true);
    }
    // Only the part below the launch directory is judged: an operator who
    // launched inside such a directory granted its tree.
    const inner = join(dir, ".claude", "skills", "demo");
    mkdirSync(inner, { recursive: true });
    expect(
      claudeCeiling("medium", "Write", { file_path: join(inner, "SKILL.md"), content: "x" }, inner)
        .allowable
    ).toBe(true);
    // High keeps the bare grant; low leaves the answer to the caller.
    const settings = { file_path: join(dir, ".claude", "settings.json"), content: "x" };
    expect(claudeCeiling("high", "Write", settings, dir).allowable).toBe(true);
    expect(claudeCeiling("low", "Write", settings, dir).allowable).toBe(true);
  });

  test("the protected-name fold is Unicode's: long s, Kelvin, and ligatures deny", () => {
    // Review live22, security minor: `toLowerCase` left `ſ` (U+017F) as is,
    // so `.vſcode/tasks.json` passed the check while APFS's case-insensitive
    // lookup opens the real `.vscode`. Every spelling below folds to a
    // protected name and must deny at medium.
    const dir = tempDir();
    for (const target of [
      join(dir, ".vſcode", "tasks.json"),
      join(dir, ".huſky", "pre-commit"),
      join(dir, ".mcp.jſon"),
      join(dir, ".zſhrc"),
      join(dir, ".gitmoduleſ"),
      join(dir, ".claude.jſon"),
      join(dir, ".bash_proﬁle"),
    ]) {
      const verdict = claudeCeiling("medium", "Write", { file_path: target, content: "x" }, dir);
      expect({ target, allowable: verdict.allowable }).toEqual({ target, allowable: false });
    }
    expect(foldForProtectedLookup(".vſcode")).toBe(".vscode");
    expect(foldForProtectedLookup("K")).toBe("k");
    expect(foldForProtectedLookup(".zſhrc")).toBe(".zshrc");
  });
});
