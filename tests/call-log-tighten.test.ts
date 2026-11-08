/**
 * Review round 401, item 10 (the call-log half): tightenFile and
 * tightenDirectory lstat'd the path and chmod'd the path — a symlink
 * swapped in between the two was chmod'd through, stripping permissions
 * from whatever it named, exactly what the comments claimed could not
 * happen. The fix opens without following a final symlink (and with
 * O_DIRECTORY for the directory) and fchmods the open descriptor, so the
 * mode change is pinned to the inode that was inspected. The tests swap
 * the entry for a symlink at chmod time through the fs seam; the widened
 * target keeps its mode.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendCallRecord, callLogPath, CALL_LOG_ENV, resetCallLogWarningForTests } from "../src/call-log.js";
import { tightenDirectory, tightenFile } from "../src/call-log-tighten.js";
import { BASE_RECORD, tempEnv } from "./helpers/call-log.js";

afterEach(() => {
  resetCallLogWarningForTests();
});

describe("tightening never chmods through a swapped symlink (round 401, item 10)", () => {
  test("a widened ledger file swapped for a symlink at chmod time keeps its target's mode", () => {
    const { env, dir, cleanup } = tempEnv();
    const ledger = join(dir, "calls.jsonl");
    // The ledger arrives wider than 0600, so tightening wants to chmod it.
    writeFileSync(ledger, "", { mode: 0o600 });
    chmodSync(ledger, 0o666);
    // The wide file the swapped link would name, created up front so its
    // mode is assertable whether or not the swap ever fires.
    const victim = join(dir, "victim");
    writeFileSync(victim, "not codemux's\n");
    chmodSync(victim, 0o666);
    const realChmod = fs.chmodSync;
    const realRename = fs.renameSync;
    let swapped = false;
    const chmod = spyOn(fs, "chmodSync").mockImplementation(((path: fs.PathLike, mode: number) => {
      if (String(path) === ledger && !swapped) {
        // The attacker wins the old window: between the lstat and the
        // chmod, the entry becomes a symlink to the wide file.
        swapped = true;
        realRename(ledger, join(dir, "ledger-real"));
        symlinkSync(victim, ledger);
      }
      return realChmod(path, mode);
    }) as typeof fs.chmodSync);
    try {
      appendCallRecord(BASE_RECORD, { ...env, [CALL_LOG_ENV]: ledger });
      // The fd-based tighten never chmods the path, so the swap the old
      // window allowed never happens and the victim keeps its mode.
      expect(swapped).toBe(false);
      expect(statSync(victim).mode & 0o777).toBe(0o666);
    } finally {
      chmod.mockRestore();
      cleanup();
    }
  });

  test("a widened state directory swapped for a symlink at chmod time keeps its target's mode", () => {
    const { env, cleanup } = tempEnv();
    const stateDir = dirname(callLogPath(env)!);
    // The one existing directory an append may tighten, arriving wider
    // than 0700 so tightening wants to chmod it (the ul2 shape).
    mkdirSync(stateDir, { recursive: true, mode: 0o777 });
    chmodSync(stateDir, 0o777);
    const parent = dirname(stateDir);
    const victim = join(parent, "victim-dir");
    mkdirSync(victim, { mode: 0o777 });
    chmodSync(victim, 0o777);
    const realChmod = fs.chmodSync;
    const realRename = fs.renameSync;
    let swapped = false;
    const chmod = spyOn(fs, "chmodSync").mockImplementation(((path: fs.PathLike, mode: number) => {
      if (String(path) === stateDir && !swapped) {
        swapped = true;
        realRename(stateDir, join(parent, "state-real"));
        symlinkSync(victim, stateDir);
      }
      return realChmod(path, mode);
    }) as typeof fs.chmodSync);
    try {
      // The env names the path inside the default state directory, so the
      // append tightens the directory itself.
      appendCallRecord(BASE_RECORD, { ...env, [CALL_LOG_ENV]: join(stateDir, "calls.jsonl") });
      expect(swapped).toBe(false);
      expect(statSync(victim).mode & 0o777).toBe(0o777);
    } finally {
      chmod.mockRestore();
      cleanup();
    }
  });

  test("a missing entry or a planted symlink is refused by the open and leaves the target alone", () => {
    // The open is the only check: a name that resolves to nothing returns
    // without a throw, and a symlink already at the name is refused by
    // O_NOFOLLOW, so its widened target keeps its mode. Tightening is
    // hygiene; neither case reaches the caller.
    const { env, cleanup } = tempEnv();
    const root = dirname(callLogPath(env)!);
    mkdirSync(root, { recursive: true });
    const victimFile = join(root, "victim-file");
    const victimDir = join(root, "victim-dir");
    writeFileSync(victimFile, "x", { mode: 0o666 });
    chmodSync(victimFile, 0o666);
    mkdirSync(victimDir, { mode: 0o777 });
    chmodSync(victimDir, 0o777);
    symlinkSync(victimFile, join(root, "file-link"));
    symlinkSync(victimDir, join(root, "dir-link"));
    try {
      expect(() => tightenFile(join(root, "absent"))).not.toThrow();
      expect(() => tightenDirectory(join(root, "absent"), true)).not.toThrow();
      tightenFile(join(root, "file-link"));
      tightenDirectory(join(root, "dir-link"), true);
      expect(statSync(victimFile).mode & 0o777).toBe(0o666);
      expect(statSync(victimDir).mode & 0o777).toBe(0o777);
    } finally {
      cleanup();
    }
  });
});
