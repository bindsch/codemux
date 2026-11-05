/**
 * The per-session private config directory of a
 * `--hermetic --experiment-project-settings` session
 * (src/claude-project-config.ts): the same isolation a run gets, with a
 * lifetime keyed to the native session id — created at the first
 * command, reused by every `--resume`, removed by `--final` or the
 * two-day dead-owner sweep. Driver-level behavior (the argv and env the
 * harness receives, the deny policy) is covered by
 * tests/session-cli-project-settings.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionHold } from "../src/session/registry.js";
import {
  SESSION_DIR_PREFIX,
  claudeProjectKey,
  generatedGlobalState,
  openProjectSettingsSessionConfigDir,
  projectSettingsSessionDirPath,
} from "../src/claude-project-config.js";

const ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "99999999-8888-4777-8666-555555555555";

describe("a project-settings session's private config directory", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // A fake operator home whose `.claude` is the config root, and a
  // fixture working directory whose ancestors carry none of the refused
  // project-memory names.
  function home(): string {
    const root = mkdtempSync(join(tmpdir(), "codemux-pps-session-home-"));
    scratch.push(root);
    return root;
  }
  function fixtureCwd(root: string): string {
    const cwd = join(root, "work");
    mkdirSync(cwd, { recursive: true });
    return cwd;
  }
  const dirOf = (root: string, id: string): string =>
    join(root, ".claude", ".codemux-hermetic", `${SESSION_DIR_PREFIX}${id}`);

  test("the first command creates session-<id> with the generated trust record", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    const root = home();
    const cwd = fixtureCwd(root);
    const opened = openProjectSettingsSessionConfigDir(ID, false, cwd, { HOME: root });
    expect(opened.dir).toBe(dirOf(root, ID));
    expect(statSync(opened.dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(opened.dir, ".claude.json"), "utf8")).toBe(
      `${generatedGlobalState(claudeProjectKey(cwd))}\n`
    );
    expect(statSync(join(opened.dir, ".claude.json")).mode & 0o777).toBe(0o600);
  });

  test("the directory key refuses anything but a lowercase UUID", () => {
    expect(() => projectSettingsSessionDirPath("/root", "not-a-uuid")).toThrow(/UUID/);
    expect(projectSettingsSessionDirPath("/root", ID)).toBe(
      join("/root", ".codemux-hermetic", `${SESSION_DIR_PREFIX}${ID}`)
    );
  });

  test("a first command whose directory already exists refuses instead of reusing it", () => {
    const root = home();
    const cwd = fixtureCwd(root);
    mkdirSync(dirOf(root, ID), { recursive: true });
    expect(() => openProjectSettingsSessionConfigDir(ID, false, cwd, { HOME: root })).toThrow(
      /refusing to reuse/
    );
  });

  test("a resume of a missing directory refuses; it cannot be silently remade", () => {
    const root = home();
    const cwd = fixtureCwd(root);
    try {
      openProjectSettingsSessionConfigDir(ID, true, cwd, { HOME: root });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain(ID);
      expect((error as Error).message).toContain("transcript");
    }
    // Nothing was created behind the refusal.
    expect(existsSync(dirOf(root, ID))).toBe(false);
  });

  test("a resume opens the recorded directory and never rewrites its state", () => {
    const root = home();
    const cwd = fixtureCwd(root);
    const first = openProjectSettingsSessionConfigDir(ID, false, cwd, { HOME: root });
    // The harness writes its own state under the directory across turns;
    // a sentinel state file stands in for it.
    const sentinel = '{"hasCompletedOnboarding":true,"projects":{"written-by":"the-harness"}}\n';
    writeFileSync(join(first.dir, ".claude.json"), sentinel);
    const resumed = openProjectSettingsSessionConfigDir(ID, true, cwd, { HOME: root });
    expect(resumed.dir).toBe(first.dir);
    expect(readFileSync(join(resumed.dir, ".claude.json"), "utf8")).toBe(sentinel);
  });

  test("a resume refuses a swapped link standing in for the directory", () => {
    const root = home();
    const cwd = fixtureCwd(root);
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(join(root, ".claude", ".codemux-hermetic"), { recursive: true });
    symlinkSync(elsewhere, dirOf(root, ID));
    expect(() => openProjectSettingsSessionConfigDir(ID, true, cwd, { HOME: root })).toThrow();
  });

  test("remove deletes the directory tree and is idempotent — the --final path", () => {
    const root = home();
    const cwd = fixtureCwd(root);
    const opened = openProjectSettingsSessionConfigDir(ID, false, cwd, { HOME: root });
    mkdirSync(join(opened.dir, "projects")); // a nested leaf, like the harness transcript
    writeFileSync(join(opened.dir, "projects", "state.json"), "{}\n");
    opened.remove();
    opened.remove();
    expect(existsSync(opened.dir)).toBe(false);
  });

  test("remove refuses a parent swapped or replaced after the open (round 104)", () => {
    // The session variant used to revalidate only dirname(dir) by lstat, so
    // a symlink swap was caught but another directory put at the same path
    // was not, and the recursive remove then deleted the same-named child
    // under it. The parent's identity is recorded at open and revalidated
    // by remove (src/safe-remove.ts). Both shapes are refused, the victim
    // survives, and a refused remove stays retryable.
    for (const shape of ["symlink", "replacement"] as const) {
      const root = home();
      const cwd = fixtureCwd(root);
      const opened = openProjectSettingsSessionConfigDir(ID, false, cwd, { HOME: root });
      const parent = join(root, ".claude", ".codemux-hermetic");
      // The victim holds a same-named directory with a file inside — what a
      // naive recursive removal would delete.
      const victim = join(root, "victim");
      const victimChild = join(victim, `${SESSION_DIR_PREFIX}${ID}`);
      mkdirSync(victimChild, { recursive: true });
      writeFileSync(join(victimChild, "marker.txt"), "kept\n");
      const moved = join(root, "parent-moved");
      renameSync(parent, moved);
      let decoy: string | null = null;
      if (shape === "symlink") {
        symlinkSync(victim, parent);
      } else {
        // Another real directory at the same path, holding the same-named
        // child: only the recorded device and inode tell it apart.
        mkdirSync(parent);
        decoy = join(parent, `${SESSION_DIR_PREFIX}${ID}`);
        mkdirSync(decoy);
        writeFileSync(join(decoy, "marker.txt"), "kept\n");
      }
      expect(() => opened.remove()).toThrow(/the directory was kept/);
      expect(readFileSync(join(victimChild, "marker.txt"), "utf8")).toBe("kept\n");
      if (decoy !== null) expect(readFileSync(join(decoy, "marker.txt"), "utf8")).toBe("kept\n");
      expect(existsSync(opened.dir)).toBe(true);
      // Restore the real parent and retry: the removal now succeeds.
      if (shape === "symlink") {
        rmSync(parent);
      } else {
        rmSync(parent, { recursive: true, force: true });
      }
      renameSync(moved, parent);
      opened.remove();
      expect(existsSync(opened.dir)).toBe(false);
      expect(readFileSync(join(victimChild, "marker.txt"), "utf8")).toBe("kept\n");
    }
  });

  test("the sweep reclaims an unowned quiet directory and spares everything else", () => {
    const root = home();
    const cwd = fixtureCwd(root);
    const parent = join(root, ".claude", ".codemux-hermetic");
    const HELD_ID = "12345678-1234-4123-8123-123456789abc";
    const holds = new Map<string, SessionHold>([[HELD_ID, "held"]]);
    const holdStateOf = (id: string): SessionHold => holds.get(id) ?? "free";
    const opened = openProjectSettingsSessionConfigDir(ID, false, cwd, { HOME: root }, holdStateOf);
    // An aged owner-gone directory (free), an aged held one (a live
    // owner), and the caller's own: two named survivors.
    const aged = dirOf(root, OTHER_ID);
    mkdirSync(aged, { recursive: true });
    const held = dirOf(root, HELD_ID);
    mkdirSync(held, { recursive: true });
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    for (const dir of [aged, held]) {
      writeFileSync(join(dir, "leaf"), "x");
      utimesSync(join(dir, "leaf"), threeDaysAgo, threeDaysAgo);
      utimesSync(dir, threeDaysAgo, threeDaysAgo);
    }
    // The spare arm: the caller's own directory ages past the gate and
    // the registry would call it free, but the resume itself is the
    // counter-claim — the sweep that just ran inside this open spared it.
    utimesSync(join(opened.dir, ".claude.json"), threeDaysAgo, threeDaysAgo);
    utimesSync(opened.dir, threeDaysAgo, threeDaysAgo);
    const resumed = openProjectSettingsSessionConfigDir(ID, true, cwd, { HOME: root }, holdStateOf);
    expect(resumed.dir).toBe(opened.dir);
    // The held directory and the caller's own survive; free and aged is gone.
    expect(readdirSync(parent).sort()).toEqual([
      `${SESSION_DIR_PREFIX}${ID}`,
      `${SESSION_DIR_PREFIX}${HELD_ID}`,
    ]);
  });
});
