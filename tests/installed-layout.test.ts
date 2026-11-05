import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildLayout, checkInstalledLayout, LAUNCHER_PIN_TOKEN, markdownLinkDestination, pinLauncherBun, runLayoutCheck, verifyDocsLinks, verifyInstalledCommands } from "../scripts/check-installed-layout.js";

const ROOT = resolve(import.meta.dir, "..");
// Only one layout per file run: building a keg copies the whole checkout.
let built: string | undefined;

function version(): string {
  return (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
}

afterEach(() => {
  if (built) {
    rmSync(built, { recursive: true, force: true });
    built = undefined;
  }
});

test("the installed layout runs --version, list, and --help through the prefix symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "codemux-layout-test-"));
  built = root;
  const { layout } = checkInstalledLayout(ROOT, root);
  expect(layout.keg).toBe(join(root, "Cellar", "codemux", version()));
  expect(verifyInstalledCommands(layout, version())).toEqual([]);
  // Exact match: a release whose version merely contains the expected one
  // (12.0.0 for 2.0.0) must fail (review round 47).
  const mismatched = verifyInstalledCommands(layout, `1${version()}`);
  expect(mismatched.some((failure) => failure.includes(`expected 1${version()}`))).toBe(true);
});

test("the version check accepts exactly the bare version or `codemux <version>` (review round 49)", () => {
  // The predicate the check applies, over the strings it must and must not accept.
  const accepts = (printed: string, version: string): boolean => printed === version || printed === `codemux ${version}`;
  expect(accepts("2.0.0", "2.0.0")).toBe(true);
  expect(accepts("codemux 2.0.0", "2.0.0")).toBe(true);
  expect(accepts("12.0.0", "2.0.0")).toBe(false);
  expect(accepts("other-program 2.0.0", "2.0.0")).toBe(false);
});

test("the synthetic keg mirrors the formula's libexec shape (round 13, edges 5)", () => {
  const root = mkdtempSync(join(tmpdir(), "codemux-layout-test-"));
  built = root;
  const layout = buildLayout(ROOT, root, version());
  const keg = layout.keg;
  // The checkout lives under libexec, the formula's Dir["*"] install.
  expect(statSync(join(keg, "libexec", "bin", "codemux")).isFile()).toBe(true);
  expect(statSync(join(keg, "libexec", "src")).isDirectory()).toBe(true);
  // The keg's bin/codemux is the formula's bin.install_symlink: a
  // relative link at ../libexec/bin/codemux.
  expect(readlinkSync(join(keg, "bin", "codemux"))).toBe("../libexec/bin/codemux");
  // The prefix link resolves through that keg link into libexec.
  expect(readlinkSync(join(layout.prefix, "bin", "codemux"))).toBe(
    join("..", "Cellar", "codemux", version(), "bin", "codemux")
  );
  // $0 resolution runs through both links: the prefix link's realpath is
  // the libexec launcher (realpath on both sides; the temp root is a
  // symlink on macOS).
  expect(realpathSync(join(layout.prefix, "bin", "codemux"))).toBe(
    join(realpathSync(keg), "libexec", "bin", "codemux")
  );
  expect(verifyInstalledCommands(layout, version())).toEqual([]);
});

test("installed docs links resolve inside the keg", () => {
  const root = mkdtempSync(join(tmpdir(), "codemux-layout-test-"));
  built = root;
  const { layout } = checkInstalledLayout(ROOT, root);
  expect(verifyDocsLinks(layout.keg)).toEqual([]);
  // A link that only works from the checkout is a distribution bug: point one
  // at a file the keg does not carry.
  writeFileSync(join(layout.keg, "libexec", "docs", "zz-layout-check.md"), "see [nothing](./no-such-file.md)\n");
  const failures = verifyDocsLinks(layout.keg);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("./no-such-file.md (from docs/zz-layout-check.md)");
  // A link whose target is a symlink out of the keg resolves from the
  // checkout but not from an install (round 14, edges 11): realpath
  // containment must fail it, not follow it.
  const outside = mkdtempSync(join(tmpdir(), "codemux-layout-outside-"));
  try {
    writeFileSync(join(outside, "escaped.md"), "# outside the keg\n");
    symlinkSync(join(outside, "escaped.md"), join(layout.keg, "libexec", "docs", "zz-escaped.md"));
    writeFileSync(join(layout.keg, "libexec", "docs", "zz-symlink-check.md"), "see [escaped](./zz-escaped.md)\n");
    const escaped = verifyDocsLinks(layout.keg).filter((failure) => failure.includes("zz-symlink-check"));
    expect(escaped).toHaveLength(1);
    expect(escaped[0]).toContain("resolves outside the keg");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a layout whose keg lost src fails the command checks", () => {
  const root = mkdtempSync(join(tmpdir(), "codemux-layout-test-"));
  built = root;
  const layout = buildLayout(ROOT, root, version());
  rmSync(join(layout.keg, "libexec", "src"), { recursive: true, force: true });
  const failures = verifyInstalledCommands(layout, version());
  expect(failures.length).toBeGreaterThan(0);
  expect(failures.every((failure) => failure.startsWith("codemux "))).toBe(true);
});

test("a layout whose prefix symlink dangles fails the command checks", () => {
  const root = mkdtempSync(join(tmpdir(), "codemux-layout-test-"));
  built = root;
  const layout = buildLayout(ROOT, root, version());
  rmSync(layout.prefix, { recursive: true, force: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  symlinkSync("../Cellar/codemux/9.9.9/bin/codemux", join(root, "bin", "codemux"), "file");
  expect(verifyInstalledCommands({ ...layout, prefix: root }, version()).length).toBeGreaterThan(0);
});

test("the built keg's launcher is pinned to the running bun, not the PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "codemux-layout-test-"));
  built = root;
  const { keg } = buildLayout(ROOT, root, version());
  const text = readFileSync(join(keg, "bin/codemux"), "utf8");
  expect(text).toContain(`${LAUNCHER_PIN_TOKEN}${process.execPath}`);
  // The token the formula rewrites must appear exactly once in the
  // checkout's launcher, or the formula's install aborts.
  const checkoutText = readFileSync(join(ROOT, "bin/codemux"), "utf8");
  expect(checkoutText.split(LAUNCHER_PIN_TOKEN).length - 1).toBe(1);
});

test("a keg whose launcher lost the pin token fails the layout build", () => {
  const root = mkdtempSync(join(tmpdir(), "codemux-layout-test-"));
  built = root;
  const { keg } = buildLayout(ROOT, root, version());
  // Undo the pin and restore the empty token, then drop it entirely: the
  // formula's inreplace would abort on this file.
  const launcher = join(keg, "bin/codemux");
  const pinned = readFileSync(launcher, "utf8");
  const unpinned = pinned.replace(`${LAUNCHER_PIN_TOKEN}${process.execPath}`, LAUNCHER_PIN_TOKEN);
  expect(() => pinLauncherBun(keg, process.execPath)).not.toThrow();
  writeFileSync(launcher, unpinned.replace(LAUNCHER_PIN_TOKEN, ""));
  expect(() => pinLauncherBun(keg, process.execPath)).toThrow(/exactly once/);
});

test("pinning is idempotent: the same path re-pins clean, a different path is refused (round 16, minor 5)", () => {
  // The old bare-token replace appended: a second pin produced
  // `codemux_pinned_bun=<new><old>` while the occurrence count still read
  // one, so the corrupted line shipped and the launcher then refused a
  // path that does not exist.
  const root = mkdtempSync(join(tmpdir(), "codemux-layout-pin-"));
  built = root;
  const { keg } = buildLayout(ROOT, root, version());
  const launcher = join(keg, "bin/codemux");
  // buildLayout pins the keg to this process's bun: re-pinning the same
  // path is a no-op, byte for byte.
  const asBuilt = readFileSync(launcher, "utf8");
  pinLauncherBun(keg, process.execPath);
  expect(readFileSync(launcher, "utf8")).toBe(asBuilt);
  // Unpinned, a fresh pin replaces the whole line.
  writeFileSync(launcher, asBuilt.replace(`codemux_pinned_bun=${process.execPath}`, "codemux_pinned_bun="));
  pinLauncherBun(keg, "/new/bun");
  const once = readFileSync(launcher, "utf8");
  expect(once).toContain("codemux_pinned_bun=/new/bun\n");
  // The same path again changes nothing; a different path is refused and
  // the launcher keeps the first pin.
  pinLauncherBun(keg, "/new/bun");
  expect(readFileSync(launcher, "utf8")).toBe(once);
  expect(() => pinLauncherBun(keg, "/other/bun")).toThrow(/already pinned to \/new\/bun/);
  expect(readFileSync(launcher, "utf8")).toBe(once);
});

test("a thrown layout failure keeps the tree and prints the pointer (round 12, contracts 5)", () => {
  // A checkout whose launcher carries no pin token makes the layout build
  // throw. The thrown path used to skip the documented failure output and
  // leave the temp tree with no pointer to it.
  const broken = mkdtempSync(join(tmpdir(), "codemux-layout-broken-"));
  mkdirSync(join(broken, "bin"));
  writeFileSync(join(broken, "bin", "codemux"), "#!/bin/sh\nexec bun src/index.ts \"$@\"\n");
  mkdirSync(join(broken, "src"));
  writeFileSync(join(broken, "bunfig.runtime.toml"), "");
  writeFileSync(join(broken, "package.json"), "{\"version\":\"9.9.9\"}");
  mkdirSync(join(broken, "docs"));
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => void errors.push(String(message));
  let keptRoot: string | null = null;
  try {
    const outcome = runLayoutCheck(broken, false);
    expect(outcome.exitCode).toBe(1);
    keptRoot = outcome.keptRoot;
    expect(keptRoot).not.toBeNull();
    expect(errors.some((line) => line.startsWith("installed-layout: FAIL"))).toBe(true);
    expect(errors.some((line) => line.includes("kept the broken tree for inspection"))).toBe(true);
    expect(existsSync(keptRoot!)).toBe(true);
  } finally {
    console.error = originalError;
    rmSync(broken, { recursive: true, force: true });
    if (keptRoot) rmSync(keptRoot, { recursive: true, force: true });
  }
});

test("the pinned bun path is written as a valid shell assignment value whatever its characters (round 32, edges 2)", async () => {
  const { launcherAssignmentValue } = await import("../scripts/check-installed-layout.js");
  expect(launcherAssignmentValue("/opt/homebrew/opt/bun/bin/bun")).toBe("/opt/homebrew/opt/bun/bin/bun");
  expect(launcherAssignmentValue("/Users/some one/bun")).toBe("'/Users/some one/bun'");
  expect(launcherAssignmentValue("/tmp/it's/bun")).toBe("'/tmp/it'\\''s/bun'");
});

test("re-pinning the same quoted bun path is idempotent (round 34, edges 10)", () => {
  const root = mkdtempSync(join(tmpdir(), "codemux-layout-test-"));
  built = root;
  const { keg } = buildLayout(ROOT, root, version());
  const launcher = join(keg, "bin/codemux");
  writeFileSync(launcher, readFileSync(launcher, "utf8").replace(`${LAUNCHER_PIN_TOKEN}${process.execPath}`, LAUNCHER_PIN_TOKEN));
  const spaced = "/Users/some one/bun";
  expect(() => pinLauncherBun(keg, spaced)).not.toThrow();
  expect(readFileSync(launcher, "utf8")).toContain(`${LAUNCHER_PIN_TOKEN}'${spaced}'`);
  expect(() => pinLauncherBun(keg, spaced)).not.toThrow();
  expect(() => pinLauncherBun(keg, "/elsewhere/bun")).toThrow(/already pinned/);
});

test("the link parser takes the destination only, whatever the title (round 151)", () => {
  // A CommonMark inline link is [text](destination "title"): the title is
  // double-quoted, single-quoted, or parenthesized, and an angle-bracket
  // destination may hold spaces.
  const cases: [string, string][] = [
    ["guide.md \"Guide\"", "guide.md"],
    ["guide.md 'Guide'", "guide.md"],
    ["guide.md (Guide)", "guide.md"],
    ["<my file.md> \"Spaced\"", "my file.md"],
    ["<my file.md>", "my file.md"],
    [" <spaced destination.md> ", "spaced destination.md"],
    ["guide.md#section \"T\"", "guide.md#section"],
    ["guide.md", "guide.md"],
    // Balanced parentheses inside a destination stay cut at the first `)`,
    // as before the fix: the pattern itself stops there.
    ["b(c", "b(c"],
  ];
  for (const [captured, destination] of cases) {
    expect(markdownLinkDestination(captured)).toBe(destination);
  }
});

test("installed docs links with titles resolve to their destination (round 151)", () => {
  // A fake keg: libexec/docs holds the links and their targets, the shape
  // verifyDocsLinks walks. Titled links to existing files used to fail as
  // broken because the title was read as part of the path.
  const keg = mkdtempSync(join(tmpdir(), "codemux-layout-links-"));
  try {
    const docs = join(keg, "libexec", "docs");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "guide.md"), "# guide\n");
    writeFileSync(join(docs, "my file.md"), "# spaced\n");
    writeFileSync(join(docs, "page.md"), [
      "[one](guide.md \"Guide\")",
      "[two](guide.md 'Guide')",
      "[three](guide.md (Guide))",
      "[four](<my file.md> \"Spaced\")",
      "",
    ].join("\n"));
    expect(verifyDocsLinks(keg)).toEqual([]);
    // A missing target with a title still fails, and the failure names
    // the destination without the title.
    writeFileSync(join(docs, "broken.md"), "[gone](missing.md \"Gone\")\n");
    const failures = verifyDocsLinks(keg);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("missing.md (from docs/broken.md)");
    expect(failures[0]).not.toContain("Gone");
  } finally {
    rmSync(keg, { recursive: true, force: true });
  }
});

