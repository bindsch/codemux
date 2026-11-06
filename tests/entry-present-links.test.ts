/** "Is there an entry at this path" for the guards that refuse an existing
 * path or choose between a file and a default (review rounds 169 and
 * 174). Only ENOENT and ENOTDIR mean "no entry". A symlink is an entry
 * even when its target is missing: the look does not follow it, so a
 * guard cannot be passed with a dangling link that a later write or
 * rename would replace or that the harness would read once its target
 * appears. Any other failure of the look reaches the caller's refusal. */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoProjectScodePolicy } from "../src/cli-runtime/scode.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { readFileBytesBounded, statEntryPresent } from "../src/file-io.js";
import { assertNoAiderProjectExecutionConfig } from "../src/project-safety.js";

const dirs: string[] = [];
const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "codemux-entry-present-"));
  dirs.push(dir);
  return dir;
}

/** Makes the look at `path` fail with EIO, a code that is neither ENOENT
 * nor ENOTDIR and needs no permissions to produce. */
function failLookAt(path: string): void {
  const original = fs.lstatSync;
  type LstatArgs = Parameters<typeof fs.lstatSync>;
  spies.push(spyOn(fs, "lstatSync").mockImplementation(((...args: LstatArgs) => {
    if (args[0] === path) throw Object.assign(new Error("input/output error"), { code: "EIO" });
    return original(...args);
  }) as typeof fs.lstatSync));
}

const refuse = (code: string): never => {
  throw new Error(`refused (${code})`);
};

describe("statEntryPresent", () => {
  test("a file, a directory, and a link with a missing target are entries", () => {
    const dir = scratch();
    writeFileSync(join(dir, "file"), "x");
    mkdirSync(join(dir, "directory"));
    symlinkSync(join(dir, "missing-target"), join(dir, "dangling"));
    symlinkSync("loop", join(dir, "loop"));
    expect(statEntryPresent(join(dir, "file"), refuse)).toBe(true);
    expect(statEntryPresent(join(dir, "directory"), refuse)).toBe(true);
    expect(statEntryPresent(join(dir, "dangling"), refuse)).toBe(true);
    expect(statEntryPresent(join(dir, "loop"), refuse)).toBe(true);
  });

  test("a missing path and a path under a file are no entry", () => {
    const dir = scratch();
    writeFileSync(join(dir, "file"), "x");
    expect(statEntryPresent(join(dir, "absent"), refuse)).toBe(false);
    expect(statEntryPresent(join(dir, "file", "below"), refuse)).toBe(false);
  });

  test("any other failure of the look reaches the refusal with its code", () => {
    const dir = scratch();
    const path = join(dir, "unreadable");
    failLookAt(path);
    expect(() => statEntryPresent(path, refuse)).toThrow("refused (EIO)");
  });
});

describe("the guards built on it", () => {
  test("a dangling .scode.yaml link refuses sandbox execution like a present policy", () => {
    const workdir = scratch();
    symlinkSync(join(workdir, "missing-policy"), join(workdir, ".scode.yaml"));
    expect(() => assertNoProjectScodePolicy(workdir)).toThrow(".scode.yaml");
  });

  test("a .scode.yaml that cannot be inspected refuses naming the code", () => {
    const workdir = scratch();
    failLookAt(join(workdir, ".scode.yaml"));
    expect(() => assertNoProjectScodePolicy(workdir)).toThrow("could not be inspected (EIO)");
  });

  test("a dangling project configuration link refuses like a present file", () => {
    const repo = scratch();
    mkdirSync(join(repo, ".git"));
    symlinkSync(join(repo, "missing-settings"), join(repo, ".aider.model.settings.yml"));
    expect(() => assertNoAiderProjectExecutionConfig(repo)).toThrow(
      "refuses repository executable configuration"
    );
  });

  test("a project configuration path that cannot be inspected refuses naming the code", () => {
    // The walk resolves the directory first, so the path it looks at is
    // the resolved one.
    const repo = fs.realpathSync(scratch());
    mkdirSync(join(repo, ".git"));
    failLookAt(join(repo, ".aider.model.settings.yml"));
    expect(() => assertNoAiderProjectExecutionConfig(repo)).toThrow("could not be inspected (EIO)");
  });

  test("a configuration link with a missing target refuses instead of giving the defaults", () => {
    const dir = scratch();
    const configPath = join(dir, "config.yaml");
    symlinkSync(join(dir, "missing-config.yaml"), configPath);
    expect(() => loadConfig(configPath)).toThrow(ConfigError);
  });
});

describe("the no-follow read where the open has no no-follow flag", () => {
  test("a file swapped for a link between the look and the open is refused", () => {
    // Review round 174: Windows has no O_NOFOLLOW, so the link check is a
    // look at the path before the open. The opened file must be the one
    // the look saw. Here the look is answered with another regular file's
    // identity, which is what a swap after the look amounts to.
    if (process.platform === "win32") return;
    const dir = scratch();
    const target = join(dir, "target");
    const other = join(dir, "other");
    const link = join(dir, "link");
    writeFileSync(target, "secret");
    writeFileSync(other, "decoy");
    symlinkSync(target, link);
    const original = fs.lstatSync;
    type LstatArgs = Parameters<typeof fs.lstatSync>;
    spies.push(spyOn(fs, "lstatSync").mockImplementation(((...args: LstatArgs) =>
      args[0] === link ? original(other) : original(...args)) as typeof fs.lstatSync));
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      expect(() => readFileBytesBounded(link, { maxBytes: 16, label: "credential", noFollow: true }))
        .toThrow("credential changed while it was opened");
      // An unchanged regular file still reads.
      expect(readFileBytesBounded(target, { maxBytes: 16, label: "credential", noFollow: true }).toString())
        .toBe("secret");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
