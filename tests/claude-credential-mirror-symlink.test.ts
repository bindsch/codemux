/**
 * The symlink half of the credential copy (review round 3, contracts-2
 * finding 1): a resumed session's private config directory was writable by
 * the previous harness child, so `.credentials.json` may be a planted
 * symlink to a host file. The copy must refuse — naming the path — and the
 * target must stay unchanged byte for byte; a regular file at the path is
 * replaced as before.
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyClaudeCredentialMirror } from "../src/claude-project-config.js";

const ACCESS_ONLY = JSON.stringify({
  claudeAiOauth: { accessToken: "at", refreshToken: "", expiresAt: 4102444800, scopes: [] },
}) + "\n";

describe("copyClaudeCredentialMirror against a planted entry", () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A session-shaped private directory: existing, user-owned, mode 0700.
   * The path is realpath'd: the refusal message records the resolved
   * tree (macOS tmpdir is a symlink), so the assertion must match it. */
  const sessionDirectory = (): string => {
    const root = mkdtempSync(join(tmpdir(), "codemux-mirror-link-"));
    scratch.push(root);
    const dir = join(realpathSync(root), "session-12345678-1234-1234-1234-123456789012");
    // mkdirSync applies umask; pin the mode the private directory carries.
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    return dir;
  };
  const mirrorIn = (dir: string): string => {
    const mirror = join(dir, "mirror.json");
    writeFileSync(mirror, ACCESS_ONLY, { mode: 0o600 });
    return mirror;
  };

  test("a planted symlink at .credentials.json refuses the resume, target unchanged", () => {
    const dir = sessionDirectory();
    const mirror = mirrorIn(dir);
    const hostFile = join(dir, "host-secret.txt");
    const original = "do not touch me\n";
    writeFileSync(hostFile, original, { mode: 0o600 });
    symlinkSync(hostFile, join(dir, ".credentials.json"));
    expect(() => copyClaudeCredentialMirror(dir, mirror)).toThrow(
      `refusing to write ${join(dir, ".credentials.json")}`
    );
    // Byte for byte: the write never followed the link.
    expect(readFileSync(hostFile, "utf8")).toBe(original);
    // The planted link itself still stands; nothing was created through it.
    expect(lstatSync(join(dir, ".credentials.json")).isSymbolicLink()).toBe(true);
  });

  test("a symlinked mirror refuses the run and copies nothing (round 15, edges 1)", () => {
    const dir = sessionDirectory();
    // The link target is a perfectly clean access-only mirror: the old
    // stat-then-read followed the link and copied it. The read side now
    // refuses any mirror that is not a regular file, like the sync path.
    const target = join(dir, "linked-mirror.json");
    writeFileSync(target, ACCESS_ONLY, { mode: 0o600 });
    const mirror = join(dir, "mirror-link.json");
    symlinkSync(target, mirror);
    expect(() => copyClaudeCredentialMirror(dir, mirror)).toThrow(
      `the credential mirror at ${mirror} is not a regular file; refusing`
    );
    // Nothing was written into the private directory.
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
  });

  test("a regular file at .credentials.json is replaced, not refused", () => {
    const dir = sessionDirectory();
    const mirror = mirrorIn(dir);
    const stale = join(dir, ".credentials.json");
    writeFileSync(stale, "stale token\n", { mode: 0o600 });
    copyClaudeCredentialMirror(dir, mirror);
    expect(readFileSync(stale)).toEqual(readFileSync(mirror));
    expect(statSync(stale).mode & 0o777).toBe(0o600);
    // The temp file the safe write used never lingers.
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  test("a FIFO at the mirror path is refused without blocking (round 33, edges 1)", () => {
    const dir = sessionDirectory();
    const fifo = join(dir, "fifo-mirror.json");
    const made = Bun.spawnSync(["mkfifo", fifo]);
    expect(made.exitCode).toBe(0);
    const started = performance.now();
    expect(() => copyClaudeCredentialMirror(dir, fifo)).toThrow("not a regular file");
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
  });

  test("a missing mirror removes the credential copy a previous run left behind (round 31, edges 1)", () => {
    // A persistent session resumed after the operator logged out: the
    // private directory still holds last run's token; it must go, or the
    // resumed child keeps a login the operator no longer has.
    const dir = sessionDirectory();
    const stale = join(dir, ".credentials.json");
    writeFileSync(stale, "stale token\n", { mode: 0o600 });
    expect(() => copyClaudeCredentialMirror(dir, join(dir, "absent-mirror.json"))).not.toThrow();
    expect(existsSync(stale)).toBe(false);
    // A planted link at the copy's path goes the same way, unfollowed.
    const target = join(dir, "elsewhere.txt");
    writeFileSync(target, "keep\n");
    symlinkSync(target, stale);
    expect(() => copyClaudeCredentialMirror(dir, join(dir, "absent-mirror.json"))).not.toThrow();
    expect(existsSync(stale)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("keep\n");
  });

  test("a missing mirror means no login; any other stat failure refuses (round 20, minor 16)", () => {
    const dir = sessionDirectory();
    // ENOENT is the one stat answer that means "no operator login".
    const missing = join(dir, "absent-mirror.json");
    expect(() => copyClaudeCredentialMirror(dir, missing)).not.toThrow();
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
    // Any other lstat failure — permissions here — refuses with its own
    // message instead of silently running without the credential.
    const mirror = mirrorIn(dir);
    const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const lstat = spyOn(fs, "lstatSync").mockImplementation((() => {
      throw eacces;
    }) as typeof fs.lstatSync);
    try {
      expect(() => copyClaudeCredentialMirror(dir, mirror)).toThrow(
        `cannot read the credential mirror at ${mirror}: EACCES: permission denied`
      );
    } finally {
      lstat.mockRestore();
    }
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
  });
});
