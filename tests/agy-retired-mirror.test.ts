import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETIRED_AGY_MIRROR_FILES, removeRetiredAgyMirror } from "../src/agy-auth.js";

test("the retired agy login copy from 2.0.1-2.0.3 is removed and nothing else is", () => {
  const dir = mkdtempSync(join(tmpdir(), "codemux-retired-mirror-"));
  try {
    for (const name of RETIRED_AGY_MIRROR_FILES) writeFileSync(join(dir, name), "synthetic");
    writeFileSync(join(dir, "calls.jsonl"), "kept");
    mkdirSync(join(dir, "credential-backups"));
    removeRetiredAgyMirror(dir);
    for (const name of RETIRED_AGY_MIRROR_FILES) expect(existsSync(join(dir, name))).toBe(false);
    expect(existsSync(join(dir, "calls.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "credential-backups"))).toBe(true);
    removeRetiredAgyMirror(dir); // absent files are not an error
    removeRetiredAgyMirror(join(dir, "missing"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory or a link in place of a retired file is left alone or unlinked, never followed", () => {
  const dir = mkdtempSync(join(tmpdir(), "codemux-retired-mirror-"));
  try {
    const target = join(dir, "target");
    writeFileSync(target, "kept");
    symlinkSync(target, join(dir, RETIRED_AGY_MIRROR_FILES[0]));
    mkdirSync(join(dir, RETIRED_AGY_MIRROR_FILES[1]));
    removeRetiredAgyMirror(dir);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(dir, RETIRED_AGY_MIRROR_FILES[1]))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
