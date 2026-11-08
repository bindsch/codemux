/**
 * Review round 401, item 10: the private write validated its directory
 * (lstat), then wrote and renamed through the path again — a same-uid
 * writer with access to the parent could swap the directory for a symlink
 * inside that window and land codemux-owned 0600 content at a path it
 * never chose. The fix revalidates the directory's identity (dev and ino)
 * after the staged write and refuses the rename when it moved; the test
 * swaps the directory mid-write through the fs seam the suite's other
 * module tests use.
 */

import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { lstatSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateFile } from "../src/private-write.js";
import { durableFs } from "../src/fs-durable.js";

describe("writePrivateFile refuses a directory swapped mid-write (round 401, item 10)", () => {
  test("a swap between the trusted check and the staged write refuses and lands nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "cmx-pw-toctou-"));
    const directory = join(root, "dir");
    fs.mkdirSync(directory, { mode: 0o700 });
    const evil = join(root, "evil");
    fs.mkdirSync(evil, { mode: 0o700 });
    const realWrite = fs.writeFileSync;
    const realRename = fs.renameSync;
    const realFsync = durableFs.fsyncSync;
    let swapped = false;
    const swap = (): void => {
      if (swapped) return;
      swapped = true;
      realRename(directory, join(root, "stolen"));
      symlinkSync(evil, directory);
    };
    // Two hooks for the same swap, one per implementation shape: the
    // pre-fix writer staged with a bare writeFileSync, the fixed writer
    // stages through the durableFs seam — whichever runs, the directory
    // is swapped inside the check-to-rename window.
    const write = spyOn(fs, "writeFileSync").mockImplementation(((
      path: fs.PathLike | number,
      data: string | NodeJS.ArrayBufferView,
      options: fs.WriteFileOptions | null
    ) => {
      if (String(path).endsWith(".tmp")) swap();
      return realWrite(path, data, options);
    }) as typeof fs.writeFileSync);
    durableFs.fsyncSync = (fd: number) => {
      swap();
      return realFsync(fd);
    };
    try {
      expect(() => writePrivateFile(directory, "secret.txt", "top secret")).toThrow(
        "the directory changed during the write"
      );
      expect(readdirSync(evil)).toEqual([]);
      expect(lstatSync(directory).isSymbolicLink()).toBe(true);
    } finally {
      write.mockRestore();
      durableFs.fsyncSync = realFsync;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an existing entry that is a symlink is refused, never followed", () => {
    const root = mkdtempSync(join(tmpdir(), "cmx-pw-link-"));
    try {
      const elsewhere = join(root, "elsewhere");
      fs.mkdirSync(elsewhere, { mode: 0o700 });
      fs.mkdirSync(join(root, "dir"), { mode: 0o700 });
      symlinkSync(elsewhere, join(root, "dir", "planted"));
      expect(() => writePrivateFile(join(root, "dir"), "planted", "bytes")).toThrow(
        "not a regular file owned by this user"
      );
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
