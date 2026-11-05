// Distribution check: build a Homebrew-shaped tree from this checkout
// (prefix/Cellar/codemux/<version> keg, prefix/bin/codemux symlink) and run
// the installed binary through the symlink. Catches launchers that only work
// from the checkout, and docs whose relative links break once installed.
// Referenced from the distribution section of docs/RELEASE-GATE.md.

import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const CHECKOUT = resolve(import.meta.dir, "..");

// The Homebrew formula installs the whole non-hidden checkout into libexec
// (Dir["*"]), which is what makes docs links into ../tests resolve in a real
// install. The synthetic keg mirrors that: everything except node_modules
// (symlinked, too heavy to copy) and scratch (absent from a tag checkout).
const KEG_SKIP = new Set(["node_modules", "scratch"]);
const KEG_REQUIRED = ["bin/codemux", "src", "bunfig.runtime.toml", "package.json", "docs"] as const;

// The launcher's pinned-bun line, the token the Homebrew formula rewrites
// at install time (inreplace): the formula sets it to the keg's bun so the
// installed launcher never searches PATH. The token must appear exactly
// once — a launcher edit that drops or duplicates it breaks the formula's
// install, so this check applies the same rewrite and fails without it.
export const LAUNCHER_PIN_TOKEN = "codemux_pinned_bun=";

/** Applies the formula's install-time transformation to a keg's launcher:
 * pins the bun at `bunPath` exactly as the formula's inreplace would.
 * Idempotent per path: the whole `codemux_pinned_bun=` line is replaced
 * (a bare token replace appended the new path to an old one while the
 * occurrence count still read one), re-pinning the same path is a no-op,
 * and a launcher already pinned to a different path is refused — the
 * formula installs into a fresh keg, so a second different pin is an
 * operator error, not a re-pin (review round 16, minor 5). */
export function pinLauncherBun(keg: string, bunPath: string): void {
  const launcher = join(keg, "libexec/bin/codemux");
  const text = readFileSync(launcher, "utf8");
  const count = text.split(LAUNCHER_PIN_TOKEN).length - 1;
  if (count !== 1) {
    throw new Error(
      `bin/codemux must carry the ${LAUNCHER_PIN_TOKEN}line exactly once for the Homebrew formula to pin (found ${count}); the install would abort`
    );
  }
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.startsWith(LAUNCHER_PIN_TOKEN));
  const pinned = index === -1 ? "" : lines[index]!.slice(LAUNCHER_PIN_TOKEN.length);
  if (pinned === bunPath || pinned === launcherAssignmentValue(bunPath)) return;
  if (pinned !== "") {
    throw new Error(
      `bin/codemux is already pinned to ${pinned}; refusing to re-pin to ${bunPath} (rebuild the keg instead)`
    );
  }
  if (index === -1) {
    // The token sits mid-line, not at a line start: replace the bare
    // token, the only shape left.
    writeFileSync(launcher, text.replace(LAUNCHER_PIN_TOKEN, `${LAUNCHER_PIN_TOKEN}${launcherAssignmentValue(bunPath)}`));
    return;
  }
  lines[index] = `${LAUNCHER_PIN_TOKEN}${launcherAssignmentValue(bunPath)}`;
  writeFileSync(launcher, lines.join("\n"));
}

export interface InstalledLayout {
  /** The Homebrew-style prefix: <prefix>/bin holds the public symlink. */
  prefix: string;
  /** <prefix>/Cellar/codemux/<version>: everything the launcher needs. */
  keg: string;
}

export function buildLayout(checkout: string, prefix: string, version: string): InstalledLayout {
  const keg = join(prefix, "Cellar", "codemux", version);
  for (const missing of KEG_REQUIRED.filter((item) => !existsSync(join(checkout, item)))) {
    throw new Error(`checkout has no ${missing}`);
  }
  // The real formula's shape (review round 13, edges 5): the checkout
  // lands under libexec (Dir["*"]), the formula's
  // `bin.install_symlink libexec/"bin/codemux"` links the keg-level
  // bin/codemux at ../libexec/bin/codemux, and Homebrew's prefix link
  // resolves through that keg link. Two chained symlinks, so the
  // launcher's $0 resolution and the docs-link walk run the path a real
  // install runs, not a shortcut that hides libexec-only defects.
  const libexec = join(keg, "libexec");
  mkdirSync(libexec, { recursive: true });
  for (const entry of readdirSync(checkout)) {
    if (entry.startsWith(".") || KEG_SKIP.has(entry)) continue;
    cpSync(join(checkout, entry), join(libexec, entry), { recursive: true });
  }
  chmodSync(join(libexec, "bin/codemux"), 0o755);
  // The formula's transformation, so the checked launcher is the one a real
  // install runs: pinned to this process's bun, PATH resolution disabled.
  pinLauncherBun(keg, process.execPath);
  // node_modules is too heavy to copy for a layout check; a symlink keeps
  // module resolution inside the keg working (bun follows it transparently).
  if (existsSync(join(checkout, "node_modules"))) {
    symlinkSync(join(checkout, "node_modules"), join(libexec, "node_modules"), "dir");
  }
  mkdirSync(join(keg, "bin"));
  symlinkSync("../libexec/bin/codemux", join(keg, "bin/codemux"), "file");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  symlinkSync(join("..", "Cellar", "codemux", version, "bin", "codemux"), join(prefix, "bin", "codemux"), "file");
  return { prefix, keg };
}

/** Runs every command the release checklist exercises through the prefix
 * symlink. The PATH holds no bun, so a launcher whose pin the formula
 * could not set (or that still searched PATH) refuses here instead of
 * passing. Returns one failure line per problem; empty means the installed
 * layout works. */
export function verifyInstalledCommands(layout: InstalledLayout, version: string): string[] {
  const binary = join(layout.prefix, "bin", "codemux");
  const failures: string[] = [];
  const commands: { args: string[]; label: string }[] = [
    { args: ["--version"], label: "codemux --version" },
    { args: ["list"], label: "codemux list" },
    { args: ["--help"], label: "codemux --help" },
  ];
  for (const command of commands) {
    let result: Bun.SyncSubprocess<"pipe", "pipe">;
    try {
      result = Bun.spawnSync([binary, ...command.args], {
        cwd: layout.prefix,
        env: { ...process.env, PATH: "/usr/bin:/bin" },
        stdout: "pipe", stderr: "pipe",
      });
    } catch (error) {
      failures.push(`${command.label} could not start: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (result.exitCode !== 0) {
      failures.push(`${command.label} exited ${result.exitCode}: ${result.stderr.toString().trim().slice(0, 160)}`);
      continue;
    }
    // Exact match on the printed version (a substring let 12.0.0 pass for
    // 2.0.0, round 47; a suffix let `other-program 2.0.0` pass, round 49):
    // the bare version or `codemux <version>`, nothing else.
    const printed = result.stdout.toString().trim();
    if (command.args[0] === "--version" && printed !== version && printed !== `codemux ${version}`) {
      failures.push(`codemux --version printed ${printed}, expected ${version}`);
    }
  }
  return failures;
}

function markdownFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...markdownFiles(path));
    else if (entry.endsWith(".md")) files.push(path);
  }
  return files;
}

const LINK_PATTERN = /\]\(([^)]+)\)/g;

/** The destination of a CommonMark inline link `[text](destination
 * "title")`, from the text LINK_PATTERN captured between `](` and the
 * first closing parenthesis (review round 151: the whole capture used to
 * be read as the path, so a titled link to an existing file failed). The
 * destination is either `<...>`, which may hold spaces, or the run up to
 * the first whitespace; the optional title — double quotes, single
 * quotes, or parentheses — is dropped. A destination with balanced
 * parentheses such as `b(c).md` stays unsupported, cut at the first `)`
 * exactly as before this fix: the pattern itself stops there, and
 * supporting it is optional, not a case this checker ever passed. */
export function markdownLinkDestination(captured: string): string {
  const text = captured.trim();
  if (text.startsWith("<")) {
    const close = text.indexOf(">");
    return close === -1 ? text.slice(1) : text.slice(1, close);
  }
  const space = /\s/.exec(text);
  return space === null ? text : text.slice(0, space.index);
}

/** Every relative markdown link in the installed docs must resolve inside the
 * keg — through symlinks too: a link whose target is a symlink out of the
 * keg resolves from the checkout but not from an install (review round 14,
 * edges 11). */
export function verifyDocsLinks(keg: string): string[] {
  const failures: string[] = [];
  const docsRoot = join(keg, "libexec/docs");
  // Containment root is the keg's libexec, not docs itself: the formula
  // installs the whole checkout there, so a docs link into ../src or
  // ../tests resolves inside the install; only a link whose target lands
  // outside libexec (a symlink out of the keg) fails.
  const canonicalRoot = realpathSync(join(keg, "libexec"));
  for (const file of markdownFiles(docsRoot)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(LINK_PATTERN)) {
      const target = markdownLinkDestination(match[1]!);
      if (/^(https?:|mailto:|\/|#)/.test(target)) continue;
      const path = target.split("#")[0]!;
      if (path === "") continue;
      const from = `docs/${relative(docsRoot, file)}`;
      let resolved: string;
      try {
        resolved = realpathSync(resolve(file, "..", path));
      } catch {
        failures.push(`${target} (from ${from})`);
        continue;
      }
      const inside = relative(canonicalRoot, resolved);
      // `..` or `../x` escapes; a name that merely begins with two dots
      // (`..notes/file.md`) is inside the keg (review round 54).
      if (inside === ".." || inside.startsWith("../") || isAbsolute(inside)) {
        failures.push(`${target} (from ${from}) resolves outside the keg`);
      }
    }
  }
  return failures;
}

export function checkInstalledLayout(checkout: string, root: string): { layout: InstalledLayout; failures: string[] } {
  const version = (JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")) as { version: string }).version;
  const layout = buildLayout(checkout, root, version);
  const failures = [...verifyInstalledCommands(layout, version), ...verifyDocsLinks(layout.keg)];
  return { layout, failures };
}

/** The script's entry: runs the layout check over a checkout, prints the
 * PASS or FAIL lines, and keeps a broken tree for inspection whether
 * checkInstalledLayout RETURNED its failures or THREW one (a launcher
 * without the pin token among them) — a throw must not leak the temp tree
 * or skip the kept-tree pointer (review round 12, contracts 5). Returns
 * the exit code and the kept root when the tree was kept. */
export function runLayoutCheck(
  checkout: string,
  keep: boolean
): { exitCode: number; keptRoot: string | null } {
  const root = mkdtempSync(join(tmpdir(), "codemux-installed-layout-"));
  try {
    const { layout, failures } = checkInstalledLayout(checkout, root);
    if (failures.length > 0) {
      for (const failure of failures) console.error(`installed-layout: FAIL ${failure}`);
      console.error(`installed-layout: kept the broken tree for inspection: ${layout.prefix}`);
      return { exitCode: 1, keptRoot: layout.prefix };
    }
    console.log(`installed-layout: PASS --version, list, --help through ${join(layout.prefix, "bin", "codemux")}; docs links resolve`);
    if (keep) {
      console.log(`installed-layout: kept the tree: ${layout.prefix}`);
      return { exitCode: 0, keptRoot: layout.prefix };
    }
    rmSync(root, { recursive: true, force: true });
    return { exitCode: 0, keptRoot: null };
  } catch (error) {
    console.error(`installed-layout: FAIL ${error instanceof Error ? error.message : String(error)}`);
    console.error(`installed-layout: kept the broken tree for inspection: ${root}`);
    return { exitCode: 1, keptRoot: root };
  }
}

if (import.meta.main) {
  let keep = false;
  for (const argument of process.argv.slice(2)) {
    if (argument === "--keep") keep = true;
    else {
      console.error(`installed-layout: unknown argument ${argument}`);
      process.exitCode = 1;
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    process.exitCode = runLayoutCheck(CHECKOUT, keep).exitCode;
  }
}

/** The pinned path as a POSIX shell assignment value: bare when it is made
 * of path-safe characters (the spelling the Homebrew formula writes), single
 * quoted otherwise so whitespace or shell metacharacters cannot break the
 * launcher (round 32, edges 2). */
export function launcherAssignmentValue(path: string): string {
  return /^[A-Za-z0-9/._+-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

