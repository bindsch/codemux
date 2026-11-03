import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRegistry, recordSessionStart } from "../src/session/registry.js";
import { craftEntry, makeRoot, newRecord, registryIn, seedRegistry } from "./helpers/session-registry.js";

describe("placement checks", () => {
  test("a healthy file passes; wrong mode, a symlinked registry directory, and a symlinked file fail", () => {
    const root = makeRoot();
    const path = registryIn(root);
    seedRegistry(path, [craftEntry()]);
    expect(readRegistry(path).outcome).toBe("ok");

    chmodSync(path, 0o644);
    const loose = readRegistry(path);
    expect(loose.outcome).toBe("untrusted");
    if (loose.outcome === "untrusted") expect(loose.reason).toContain("0600");

    // The symlink is the registry's own directory — a leaf, not an
    // ancestor — so it is refused on the original spelling; genuine
    // symlinked ancestors are resolved away (pinned by the test below).
    const linkRoot = makeRoot();
    const realDir = join(linkRoot, "real");
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, join(linkRoot, "link"));
    const throughLink = join(linkRoot, "link", "live-sessions.json");
    seedRegistry(throughLink, [craftEntry()]);
    const leafDir = readRegistry(throughLink);
    expect(leafDir.outcome).toBe("untrusted");
    if (leafDir.outcome === "untrusted") expect(leafDir.reason).toContain("symbolic link");

    const leafLinkRoot = makeRoot();
    const leafReal = join(leafLinkRoot, "file.json");
    writeFileSync(leafReal, "{}", { mode: 0o600 });
    const leafPath = join(leafLinkRoot, "link.json");
    symlinkSync(leafReal, leafPath);
    const leaf = readRegistry(leafPath);
    expect(leaf.outcome).toBe("untrusted");

    const wideDir = makeRoot();
    const widePath = join(wideDir, "live-sessions.json");
    mkdirSync(wideDir, { recursive: true });
    // chmod, not mkdir's mode: the process umask would strip the bits.
    chmodSync(wideDir, 0o770);
    const wide = readRegistry(widePath);
    expect(wide.outcome).toBe("untrusted");
  });

  test("a missing registry is a clean missing, not untrusted", () => {
    const root = makeRoot();
    expect(readRegistry(registryIn(root)).outcome).toBe("missing");
  });

  test("a registry directory that cannot be inspected refuses, and nothing is written (audit round 2, test 6)", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    const root = makeRoot();
    const path = registryIn(root);
    // The registry's own directory sits under a parent this process cannot
    // search, so the placement walk cannot even lstat it.
    chmodSync(root, 0o000);
    try {
      const refused = readRegistry(path);
      expect(refused.outcome).toBe("untrusted");
      if (refused.outcome === "untrusted") {
        expect(refused.reason).toContain("cannot inspect registry directory");
        expect(refused.reason).toContain(join(root, "reg"));
      }
      expect(recordSessionStart(path, newRecord()).ok).toBe(false);
    } finally {
      chmodSync(root, 0o700);
    }
    // The refusal wrote nothing: with the parent searchable again there is
    // still no registry and no lock residue.
    expect(readRegistry(path).outcome).toBe("missing");
    expect(existsSync(join(root, "reg"))).toBe(false);
  });

  test("a registry directory owned by another user refuses, and nothing is written (audit round 2, test 6)", () => {
    const root = makeRoot();
    const path = registryIn(root);
    mkdirSync(join(root, "reg"), { mode: 0o700 });
    // Ownership is read from the leaf directory's lstat; another uid there
    // is a registry this codemux must not touch, whatever its mode says.
    const realLstat = fs.lstatSync;
    const foreignUid = (typeof process.getuid === "function" ? process.getuid() : 0) + 1;
    const lstat = spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, options?: unknown) => {
      // lstatSync's broadest overload may return undefined (the
      // throwIfNoEntry option); a plain lstat never does.
      const stats = realLstat(target, options as fs.StatOptions) as fs.Stats;
      if (target === join(root, "reg")) {
        return Object.assign(Object.create(stats), { uid: foreignUid });
      }
      return stats;
    }) as typeof fs.lstatSync);
    try {
      const refused = readRegistry(path);
      expect(refused.outcome).toBe("untrusted");
      if (refused.outcome === "untrusted") {
        expect(refused.reason).toContain("registry directory");
        expect(refused.reason).toContain("not owned by the invoking user");
      }
      expect(recordSessionStart(path, newRecord()).ok).toBe(false);
    } finally {
      lstat.mockRestore();
    }
    // Nothing was created or staged inside the foreign directory.
    expect(existsSync(path)).toBe(false);
  });

  test("a symlinked ancestor resolves; the registry lands in the real directory", () => {
    // The macOS `/var -> /private/var` class: a registry reached through
    // a symlinked ancestor of its own directory (not a symlinked leaf)
    // must work — the ancestor is resolved away, never refused — and the
    // file must land in the real directory, with the link spelling
    // reading back the same registry.
    const real = makeRoot();
    const linkParent = makeRoot();
    const link = join(linkParent, "home-link");
    symlinkSync(real, link);
    const throughLink = join(link, "reg", "live-sessions.json");
    const outcome = recordSessionStart(throughLink, newRecord());
    expect(outcome.ok).toBe(true);
    const landed = join(real, "reg", "live-sessions.json");
    expect(existsSync(landed)).toBe(true);
    expect(existsSync(join(linkParent, "reg"))).toBe(false);
    const read = readRegistry(landed);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") expect(read.file.sessions.length).toBe(1);
    expect(readRegistry(throughLink).outcome).toBe("ok");
  });
});
