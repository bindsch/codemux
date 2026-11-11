import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_IDS } from "../src/adapters/index.js";
import { sessionPreviewFixture } from "./helpers/session-preview.js";
import { treeSnapshot } from "./helpers/tree-snapshot.js";

for (const agent of AGENT_IDS) {
  for (const state of ["missing", "directory", "symlink", "file", "parent-symlink", "parent-writable"] as const) {
    test(`${agent} resumed preview validates ${state} without creating or sweeping state`, async () => {
      const f = sessionPreviewFixture(agent);
      try {
        expect(f.privateDir.startsWith(f.home + "/")).toBe(true);
        if (state === "parent-symlink") {
          const target = join(f.home, "redirected-parent");
          mkdirSync(join(target, `session-${f.id}`), { recursive: true });
          mkdirSync(dirname(f.parent), { recursive: true }); symlinkSync(target, f.parent);
        } else if (state !== "missing") {
          mkdirSync(f.parent, { recursive: true });
          if (state === "symlink") symlinkSync(f.cwd, f.privateDir);
          else if (state === "file") writeFileSync(f.privateDir, "not a home");
          else mkdirSync(f.privateDir);
          if (state === "parent-writable") chmodSync(f.parent, 0o777);
          const stale = join(f.parent, "run-2147483647-stale");
          mkdirSync(stale); writeFileSync(join(stale, "sentinel"), "preserve");
          const old = new Date(Date.now() - 4 * 86_400_000); utimesSync(stale, old, old);
        }
        const before = treeSnapshot(f.home);
        if (state === "directory" || agent === "cursor" || agent === "qwen") {
          expect((await f.prepare(f.id)).child.printedSandbox).toBe(true);
        } else {
          await expect(f.prepare(f.id)).rejects.toThrow(state === "missing" ? "so it cannot resume" : /directory|symlink/);
        }
        expect(treeSnapshot(f.home)).toEqual(before);
      } finally { f.cleanup(); }
    });
  }
}
