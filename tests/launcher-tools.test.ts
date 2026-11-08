/**
 * The launcher's tool-resolution branches (audit round 2, C-2): the
 * GNU/BusyBox/Toybox stat dialects, the `tool_dirs` precedence, and every
 * `trusted_tool` refusal — executed, not pinned as source text. The seam
 * is the copy-and-rewrite one `runPinnedLauncher` established in
 * tests/launcher.test.ts: the copy's `tool_dirs=` assignment is rewritten
 * to a temp directory of fake `stat`, `id`, and `readlink` scripts, so
 * bin/codemux itself carries no test hook. The fake stat answers the GNU
 * `-L -c '%u %A'` form by delegating to the host stat, which keeps every
 * ownership judgment real.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LAUNCHER = resolve("bin/codemux");
const TOOL_DIRS_LINE = "tool_dirs='/usr/bin /bin /run/current-system/sw/bin /usr/local/bin /opt/homebrew/bin'";

describe("bin/codemux tool resolution", () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratch.push(dir);
    return dir;
  }

  function fakeBunDirectory(mode = 0o755): string {
    const root = tempDir("codemux-launcher-tools-bun-");
    const bin = join(root, "bin");
    mkdirSync(bin, { mode: 0o755 });
    chmodSync(bin, mode);
    writeFileSync(join(bin, "bun"), "#!/bin/sh\necho FAKE-BUN-RAN \"$@\"\n", { mode: 0o755 });
    chmodSync(join(bin, "bun"), 0o755);
    return bin;
  }

  // The host stat the fake delegates to: BSD on macOS, GNU on Linux. The
  // fake's own dialect is what the launcher decides, not what the host is.
  const HOST_STAT_FORM = process.platform === "darwin" ? "-f '%u %Sp'" : "-c '%u %A'";

  /** A fake tool directory. `stat` identifies as `dialect` ("gnu",
   * "busybox", "toybox", or "other" — anything the launcher does not
   * recognize, which falls to the BSD form). It answers ONLY the form its
   * dialect implies — the other form's flags fail, as they do on the real
   * binaries — and the answer is produced by delegating to the host stat,
   * so every ownership judgment stays real. A path containing BADSHAPE
   * gets a three-token line instead (the shape-refusal probe). `id`
   * answers `uid` for `-u`. `brokenStat` makes the stat claim its dialect
   * but fail every ownership query: a probe that cannot judge anyone. */
  function fakeToolDir(options: {
    dialect?: "gnu" | "busybox" | "toybox" | "other";
    uid?: string;
    statMode?: number;
    brokenStat?: boolean;
  } = {}): string {
    const dir = tempDir("codemux-launcher-tools-");
    const dialect = options.dialect ?? "gnu";
    const helpText =
      dialect === "busybox"
        ? "BusyBox v1.36.1 (2023-11-07 21:32:26 UTC) multi-call binary.\\nUsage: stat [OPTIONS] FILE...\\n"
        : dialect === "toybox"
          ? "toybox 0.8.12\\nusage: stat [-c FORMAT] FILE...\\n"
          : dialect === "other"
            ? "some other stat 1.0\\nusage: stat FILE\\n"
            : "";
    const versionText = dialect === "gnu" ? "stat (GNU coreutils) 9.4\\n" : "";
    // GNU, BusyBox, and Toybox take -c; an unrecognized stat falls to -f.
    const answerForm = dialect === "other" ? "-f" : "-c";
    writeFileSync(
      join(dir, "stat"),
      [
        "#!/bin/sh",
        'case "$1" in',
        `  --version) printf '${versionText}'; exit ${dialect === "gnu" ? 0 : 1} ;;`,
        `  --help) printf '${helpText}'; exit 0 ;;`,
        "esac",
        ...(options.brokenStat === true ? ["exit 1"] : []),
        // The launcher calls: stat -L <form-flag> <format> <path>. A stat
        // of the other dialect rejects the flags, exactly as the real one
        // does, so a wrong dialect decision is observable.
        `if [ "$2" != "${answerForm}" ]; then exit 1; fi`,
        'case "$4" in',
        '  *BADSHAPE*) echo "0 drwxr-xr-x extra"; exit 0 ;;',
        "esac",
        `exec /usr/bin/stat -L ${HOST_STAT_FORM} "$4"`,
        "",
      ].join("\n"),
      { mode: 0o755 }
    );
    chmodSync(join(dir, "stat"), options.statMode ?? 0o755);
    writeFileSync(
      join(dir, "id"),
      ["#!/bin/sh", `echo ${JSON.stringify(options.uid ?? String(process.getuid?.() ?? 0))}`, ""].join("\n"),
      { mode: 0o755 }
    );
    chmodSync(join(dir, "id"), 0o755);
    writeFileSync(join(dir, "readlink"), "#!/bin/sh\nexec /usr/bin/readlink \"$@\"\n", { mode: 0o755 });
    chmodSync(join(dir, "readlink"), 0o755);
    return dir;
  }

  /** A launcher copy with `tool_dirs` rewritten to `dirs` (space
   * separated), the same inreplace idea the Homebrew pin uses. */
  function launcherWithToolDirs(dirs: string): string {
    const root = tempDir("codemux-launcher-tools-copy-");
    const copy = join(root, "codemux");
    const text = readFileSync(LAUNCHER, "utf8");
    expect(text).toContain(TOOL_DIRS_LINE);
    writeFileSync(copy, text.replace(TOOL_DIRS_LINE, `tool_dirs='${dirs}'`), { mode: 0o755 });
    chmodSync(copy, 0o755);
    return copy;
  }

  const runLauncher = (launcher: string, path: string) =>
    Bun.spawnSync(["/bin/sh", launcher, "arg"], { cwd: process.cwd(), env: { PATH: path }, timeout: 20_000 });

  test("a GNU stat selects the GNU dialect and runs a trusted bun", () => {
    const tools = fakeToolDir({ dialect: "gnu" });
    const bin = fakeBunDirectory();
    const result = runLauncher(launcherWithToolDirs(tools), bin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("FAKE-BUN-RAN --no-env-file");
  });

  test("a BusyBox stat is matched from its --help text and takes the GNU form", () => {
    // BusyBox rejects --version (the 2>/dev/null arm) and names itself in
    // the usage text --help prints (review round 25, edges 1).
    const tools = fakeToolDir({ dialect: "busybox" });
    const bin = fakeBunDirectory();
    const result = runLauncher(launcherWithToolDirs(tools), bin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("FAKE-BUN-RAN --no-env-file");
  });

  test("a Toybox stat is matched and takes the GNU form", () => {
    const tools = fakeToolDir({ dialect: "toybox" });
    const bin = fakeBunDirectory();
    const result = runLauncher(launcherWithToolDirs(tools), bin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("FAKE-BUN-RAN --no-env-file");
  });

  test("an unrecognized stat falls to the BSD form and runs when that form answers", () => {
    const tools = fakeToolDir({ dialect: "other" });
    const bin = fakeBunDirectory();
    const result = runLauncher(launcherWithToolDirs(tools), bin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("FAKE-BUN-RAN --no-env-file");
  });

  test("the runtime arguments name the copy's package root (P-4)", () => {
    const tools = fakeToolDir();
    const launcher = launcherWithToolDirs(tools);
    const bin = fakeBunDirectory();
    const result = runLauncher(launcher, bin);
    // package_root is resolved through the copy's own location, symlinks
    // included; /var vs /private/var makes a literal comparison wrong.
    const packageRoot = realpathSync(join(launcher, "..", ".."));
    expect(result.stdout.toString()).toContain(`--config=${packageRoot}/bunfig.runtime.toml`);
    expect(result.stdout.toString()).toContain(`${packageRoot}/src/index.ts`);
  });

  test("tool_dirs precedence: a planted earlier stat that fails trust cannot shadow the trusted later one", () => {
    // The planted stat is honest (it answers real ownership lines, so it
    // can judge the later candidates) but its own file is world-writable:
    // the full rule skips it, and the trusted later stat wins even though
    // the bootstrap probed the planted one first. The run succeeding is
    // the proof the later tool was resolved and used.
    const planted = fakeToolDir({ statMode: 0o777 });
    const trusted = fakeToolDir();
    const bin = fakeBunDirectory();
    const result = runLauncher(launcherWithToolDirs(`${planted} ${trusted}`), bin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("FAKE-BUN-RAN --no-env-file");
  });

  test("a probe stat that fails trust redecides the dialect before id and readlink are judged", () => {
    // The probe (first existing stat) identifies as GNU and answers the
    // GNU form, so it can judge the candidates; it fails trust on its own
    // world-writable file, and the trusted later stat speaks the BSD form
    // only. Without the re-decision (round 28, contracts 2) the resolved
    // stat would keep receiving -c flags it rejects, and trusted_tool id
    // and readlink would refuse.
    const planted = fakeToolDir({ dialect: "gnu", statMode: 0o777 });
    const trusted = fakeToolDir({ dialect: "other" });
    const bin = fakeBunDirectory();
    const result = runLauncher(launcherWithToolDirs(`${planted} ${trusted}`), bin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("FAKE-BUN-RAN --no-env-file");
    // The same shape with the probe as the ONLY stat directory: it is
    // skipped for world-writability and nothing resolves past it.
    const alone = runLauncher(launcherWithToolDirs(planted), bin);
    expect(alone.exitCode).toBe(1);
    expect(alone.stderr.toString()).toContain("codemux: no trusted stat found in");
  });

  test("a stat candidate is judged with its own dialect's flags, not the probe's (review round 372)", () => {
    // Item 5: the probe stat identifies as GNU but fails every ownership
    // query, so it cannot judge anyone, and the only passing stat speaks
    // the BSD form alone. Judging every candidate through the probe's
    // dialect skipped that stat too and the launcher refused to start
    // ("no trusted stat found") even though a valid trusted stat existed
    // — the dialect redecision below the scan exists for exactly this
    // cross-dialect selection and could never reach it while the probe
    // was the only judge.
    const probe = fakeToolDir({ dialect: "gnu", brokenStat: true });
    const bsd = fakeToolDir({ dialect: "other" });
    const bin = fakeBunDirectory();
    const result = runLauncher(launcherWithToolDirs(`${probe} ${bsd}`), bin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("FAKE-BUN-RAN --no-env-file");
  });

  test("an id probe whose -u call fails refuses with a diagnostic, not a silent exit (review round 372)", () => {
    // Item 6: `owner_uid=$("$id_probe" -u)` had no `|| refusal`, so a
    // failing probe id exited the launcher with the tool's own status and
    // no diagnostic under `set -e`.
    const probe = fakeToolDir();
    writeFileSync(join(probe, "id"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    chmodSync(join(probe, "id"), 0o755);
    const bin = fakeBunDirectory();
    const result = runLauncher(launcherWithToolDirs(probe), bin);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      `codemux: ${join(probe, "id")} -u failed; cannot verify the runtime`
    );
    expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });

  /** A readlink that fails for any path containing FAILLINK: the
   * swap-between-check-and-use race the ancestor walk treats as
   * in-model, made deterministic. */
  function failLinkReadlinkDir(): string {
    const dir = fakeToolDir();
    writeFileSync(
      join(dir, "readlink"),
      ['#!/bin/sh', 'case "$*" in *FAILLINK*) exit 1 ;; esac', 'exec /usr/bin/readlink "$@"', ""].join("\n"),
      { mode: 0o755 }
    );
    chmodSync(join(dir, "readlink"), 0o755);
    return dir;
  }

  test("a readlink failure in the launcher's own symlink walk refuses with a diagnostic (review round 372)", () => {
    // Item 6: `link_target=$("$readlink_tool" "$script_path")` had no
    // `|| refusal`, so a readlink that failed on a link the walk had just
    // seen exited silently with the tool's status.
    const tools = failLinkReadlinkDir();
    const root = tempDir("codemux-launcher-linkfail-");
    const copy = join(root, "codemux");
    const text = readFileSync(LAUNCHER, "utf8");
    expect(text).toContain(TOOL_DIRS_LINE);
    writeFileSync(copy, text.replace(TOOL_DIRS_LINE, `tool_dirs='${tools}'`), { mode: 0o755 });
    chmodSync(copy, 0o755);
    // The launcher is reached THROUGH the link, so its $0 is a symlink
    // the walk must resolve.
    const link = join(root, "FAILLINK-codemux");
    symlinkSync(copy, link);
    const bin = fakeBunDirectory();
    const result = runLauncher(link, bin);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      `codemux: refusing to resolve the launcher: readlink failed on ${link}`
    );
    expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });

  test("a readlink failure in the bun symlink walk refuses with a diagnostic (review round 372)", () => {
    // Item 6: the bun-side `link_target=$("$readlink_tool" "$bun_path")`
    // had no `|| refusal` either.
    const tools = failLinkReadlinkDir();
    const root = tempDir("codemux-launcher-bunlinkfail-");
    const entry = join(root, "FAILLINK-bin");
    mkdirSync(entry, { mode: 0o755 });
    const real = fakeBunDirectory();
    symlinkSync(join(real, "bun"), join(entry, "bun"));
    const result = runLauncher(launcherWithToolDirs(tools), entry);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      `codemux: refusing to run bun from ${entry}: readlink failed on ${entry}/bun`
    );
    expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });

  test("a world-writable stat file is skipped and, with no other candidate, refused", () => {
    const tools = fakeToolDir({ statMode: 0o777 });
    const bin = fakeBunDirectory();
    const result = runLauncher(launcherWithToolDirs(tools), bin);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(`codemux: no trusted stat found in ${tools}`);
    expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });

  test("a stat whose output has extra tokens is skipped by the shape rule", () => {
    // A GNU stat whose line carries a third word (a filesystem block, a
    // foreign dialect's output) must never be read as ownership+mode.
    const tools = fakeToolDir();
    const bin = fakeBunDirectory();
    const root = realpathSync(join(bin, ".."));
    // The stat prints a three-token line only for the BADSHAPE directory;
    // the PATH entry directory check is the first stat it is used for.
    const bad = join(root, "BADSHAPE-bin");
    mkdirSync(bad, { mode: 0o755 });
    writeFileSync(join(bad, "bun"), "#!/bin/sh\necho FAKE-BUN-RAN \"$@\"\n", { mode: 0o755 });
    const result = runLauncher(launcherWithToolDirs(tools), bad);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("has unreadable ownership or mode");
    expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });

  test("no stat in any tool directory refuses at the bootstrap", () => {
    const empty = tempDir("codemux-launcher-empty-");
    const bin = fakeBunDirectory();
    const result = runLauncher(launcherWithToolDirs(empty), bin);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(`codemux: no stat found in ${empty}`);
    expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });

  test("an id that answers no numeric uid refuses", () => {
    // The bootstrap baseline comes from the FIRST existing id, so it must
    // answer numerically for trusted_tool to run at all; the refusal is
    // reachable when the probe id fails trust (world-writable) and the
    // first TRUSTED id answers garbage — the baseline is re-taken from
    // the validated tool (round 32, contracts 1).
    const probe = fakeToolDir();
    chmodSync(join(probe, "id"), 0o777);
    const broken = fakeToolDir({ uid: "nope" });
    // The broken directory must not contribute a stat: the probe's own
    // would be re-judged first and win anyway, so remove it to keep the
    // shape of the scenario single-cause.
    rmSync(join(broken, "stat"));
    const bin = fakeBunDirectory();
    const result = runLauncher(launcherWithToolDirs(`${probe} ${broken}`), bin);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      `codemux: ${join(broken, "id")} -u did not answer a numeric uid; cannot verify the runtime`
    );
    expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });

  test("a launcher reached without a slash in $0 resolves through command -v", () => {
    // `codemux` typed at a shell: $0 has no slash, so the launcher looks
    // itself up on PATH before resolving symlinks.
    const tools = fakeToolDir();
    const root = tempDir("codemux-launcher-bare-");
    const copy = join(root, "codemux");
    const text = readFileSync(LAUNCHER, "utf8");
    writeFileSync(copy, text.replace(TOOL_DIRS_LINE, `tool_dirs='${tools}'`), { mode: 0o755 });
    chmodSync(copy, 0o755);
    const bin = fakeBunDirectory();
    const result = Bun.spawnSync(["/bin/sh", "-c", "codemux arg"], {
      cwd: process.cwd(),
      env: { PATH: `${root}:${bin}` },
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("FAKE-BUN-RAN --no-env-file");
  });

  // The launcher's own $0 hop cap is reachable only where the kernel
  // resolves more than 32 symlink hops itself: Linux allows 40, so a
  // 34-hop chain opens and the launcher's walk must refuse it. macOS caps
  // path resolution at 32 hops, so the kernel refuses the open (exit 126,
  // ELOOP) before the launcher runs — the cap is still exercised on the
  // Linux half of CI.
  test.skipIf(process.platform === "darwin")(
    "a launcher $0 symlink chain longer than 32 hops is refused",
    () => {
      const root = tempDir("codemux-launcher-hops-");
      let previous = LAUNCHER;
      for (let hop = 0; hop < 34; hop += 1) {
        const link = join(root, `hop-${hop}`);
        symlinkSync(previous, link);
        previous = link;
      }
      const entry = previous;
      const bin = fakeBunDirectory();
      const result = runLauncher(entry, bin);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(
        `codemux: refusing to resolve the launcher: ${entry} is a symlink chain longer than 32 hops`
      );
      expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
    }
  );

  test("a dangling bun symlink is refused as not a regular file", () => {
    const root = tempDir("codemux-launcher-dangling-");
    const bin = join(root, "bin");
    mkdirSync(bin, { mode: 0o755 });
    symlinkSync(join(root, "missing"), join(bin, "bun"));
    const result = runLauncher(LAUNCHER, bin);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("is not a regular file");
    expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });

  test("a directory named bun is refused as not a regular file", () => {
    const root = tempDir("codemux-launcher-dirbun-");
    const bin = join(root, "bin");
    mkdirSync(bin, { mode: 0o755 });
    mkdirSync(join(bin, "bun"), { mode: 0o755 });
    const result = runLauncher(LAUNCHER, bin);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("is not a regular file");
    expect(result.stdout.toString()).not.toContain("FAKE-BUN-RAN");
  });
});
