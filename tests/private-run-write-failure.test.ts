/**
 * A write that fails between a private per-run artifact's creation and its
 * finalizer's registration must remove the artifact at once (review round
 * 123): the provider config directories, the kimi no-tools agent file,
 * and the aider history file all wrote their file or directory before any
 * cleanup existed, so an ENOSPC there left it behind for the days-later
 * stale sweep. Each row drives one writer with a writeFileSync that fails
 * only for that run's own path, through the fs seam the suite's other
 * module tests use (spyOn on the node:fs namespace).
 */

import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOpencodeProviderConfig } from "../src/opencode-provider.js";
import { writePiProviderAgentDir } from "../src/pi-provider.js";
import { writeDroidProviderSettings } from "../src/droid-provider.js";
import { writeKimiNoToolsFile } from "../src/kimi-no-tools.js";
import { createAiderHistoryFile } from "../src/aider-history.js";

const OVERRIDE = { baseUrl: "https://override.example/v1", apiKey: "lift-key" };

interface Case {
  label: string;
  /** The writer call, expected to throw the injected write failure. */
  make: (root: string) => unknown;
  /** The shared parent that holds this run's entry. */
  parent: (root: string) => string;
  /** The entry-name prefix unique to this run. */
  prefix: string;
}

const CASES: Case[] = [
  {
    label: "opencode provider config directory",
    make: (root) => writeOpencodeProviderConfig(root, OVERRIDE, "glm-5.3"),
    parent: (root) => join(root, ".codemux"),
    prefix: `provider-${process.pid}-`,
  },
  {
    label: "pi agent directory",
    make: (root) => writePiProviderAgentDir(root, OVERRIDE, "lift-model"),
    parent: (root) => join(root, ".codemux"),
    prefix: `provider-${process.pid}-`,
  },
  {
    label: "droid provider settings directory",
    make: (root) => writeDroidProviderSettings(root, OVERRIDE, "lift-model"),
    parent: (root) => join(root, ".codemux"),
    prefix: `provider-${process.pid}-`,
  },
  {
    label: "kimi no-tools agent file",
    make: (root) => writeKimiNoToolsFile(root),
    parent: (root) => join(root, ".codemux"),
    prefix: `no-tools-${process.pid}-`,
  },
  {
    label: "aider history file",
    make: (root) => createAiderHistoryFile(root),
    parent: (root) => join(root, ".aider", ".codemux"),
    prefix: `history-${process.pid}-`,
  },
];

describe("a failed artifact write removes what it created (review round 123)", () => {
  test.each(CASES)("$label", async (one) => {
    const root = mkdtempSync(join(tmpdir(), "codemux-write-fail-"));
    const parent = one.parent(root);
    const real = fs.writeFileSync;
    const write = spyOn(fs, "writeFileSync").mockImplementation(((
      path: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options: fs.WriteFileOptions | null
    ) => {
      // Only this run's own write fails; everything else passes through.
      if (String(path).startsWith(parent)) {
        throw Object.assign(new Error("ENOSPC: no space left on device"), {
          code: "ENOSPC",
        });
      }
      return real(path, data, options);
    }) as typeof fs.writeFileSync);
    try {
      expect(() => one.make(root)).toThrow("ENOSPC: no space left on device");
      // The parent survives (it is the shared, persistent directory); it
      // holds no entry of this run afterwards.
      expect(readdirSync(parent).filter((name) => name.startsWith(one.prefix))).toEqual([]);
    } finally {
      write.mockRestore();
      // No finalizer was ever registered — the write failed first — so
      // only the temp root needs to go.
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a failed creation removes nothing: what already sits at the name is not this run's (review round 124)", () => {
  // The first three rows create a directory, the last two a file.
  test.each(CASES.map((one, index) => ({ ...one, directory: index < 3 })))("$label", (one) => {
    const root = mkdtempSync(join(tmpdir(), "codemux-create-fail-"));
    const parent = one.parent(root);
    const realMkdir = fs.mkdirSync;
    const realWrite = fs.writeFileSync;
    const exists = (): Error => Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
    const ours = (path: unknown): boolean => String(path).startsWith(join(parent, one.prefix));
    // Another entry gets to the generated name first: the spy plants it,
    // with a file inside, and then fails the creation the way the kernel
    // would.
    const plant = (path: string): void => {
      realMkdir(path, { mode: 0o700 });
      realWrite(join(path, "keep"), "not this run's");
    };
    const mkdir = spyOn(fs, "mkdirSync").mockImplementation(((path: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      if (one.directory && ours(path)) {
        plant(String(path));
        throw exists();
      }
      return realMkdir(path, options);
    }) as typeof fs.mkdirSync);
    const write = spyOn(fs, "writeFileSync").mockImplementation(((
      path: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options: fs.WriteFileOptions | null
    ) => {
      if (!one.directory && ours(path)) {
        // The exclusive create is what makes EEXIST possible at all.
        expect((options as { flag?: string } | null)?.flag).toBe("wx");
        plant(String(path));
        throw exists();
      }
      return realWrite(path, data, options);
    }) as typeof fs.writeFileSync);
    try {
      expect(() => one.make(root)).toThrow("EEXIST: file already exists");
      const left = readdirSync(parent).filter((name) => name.startsWith(one.prefix));
      expect(left).toHaveLength(1);
      expect(readdirSync(join(parent, left[0]!))).toEqual(["keep"]);
    } finally {
      mkdir.mockRestore();
      write.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
