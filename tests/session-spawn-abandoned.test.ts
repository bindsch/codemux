/**
 * A session spawn its caller abandoned never creates a process (review
 * round 111). The opencode and aider end paths give up on a turn spawn
 * that outlasts the stop grace, and the CLI's cleanup then removes what a
 * turn child would use (opencode's per-turn provider config). A spawn
 * that was stalled in a probe must reject when it resumes, not start a
 * child against the removed state.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSessionChild } from "../src/session/spawn.js";

const REFUSAL = "the session spawn was abandoned before its process started";
const HOOKS = { onLine: () => {}, onFatal: () => {} };

function workspace(): { dir: string; workDir: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), "spawn-abandoned-"));
  const workDir = join(dir, "work");
  mkdirSync(workDir);
  return { dir, workDir, marker: join(dir, "ran") };
}

describe("spawnSessionChild's abandonment gate", () => {
  test("a direct spawn abandoned before it starts rejects and runs nothing", async () => {
    const { dir, workDir, marker } = workspace();
    try {
      const command = ["/bin/sh", "-c", `: > '${marker}'`];
      const env = { PATH: "/usr/bin:/bin", HOME: dir };
      await expect(
        spawnSessionChild(command, env, { cwd: workDir, sandboxed: false, autonomy: "high", abandoned: () => true }, HOOKS)
      ).rejects.toThrow(REFUSAL);
      await Bun.sleep(150);
      expect(existsSync(marker)).toBe(false);
      // The same spawn, not abandoned, runs: the marker proves the probe.
      const proc = await spawnSessionChild(
        command, env, { cwd: workDir, sandboxed: false, autonomy: "high", graceMs: 500, abandoned: () => false }, HOOKS
      );
      await proc.settled;
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a sandboxed spawn abandoned while its probes run rejects when they return", async () => {
    const { dir, workDir, marker } = workspace();
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const scode = join(binDir, "scode");
    // The fake scode answers the version probe and records any real launch.
    writeFileSync(
      scode,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'scode 0.2.1\\n'; exit 0; fi\n: > '${marker}'\nexit 0\n`
    );
    chmodSync(scode, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    try {
      let abandoned = false;
      const spawn = spawnSessionChild(
        ["/bin/echo", "late"],
        { PATH: `${binDir}:/usr/bin:/bin`, HOME: dir },
        { cwd: workDir, sandboxed: true, autonomy: "high", graceMs: 500, abandoned: () => abandoned },
        HOOKS
      );
      // The spawn is inside its awaited resolution now; the end path gives up.
      abandoned = true;
      await expect(spawn).rejects.toThrow(REFUSAL);
      await Bun.sleep(150);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
