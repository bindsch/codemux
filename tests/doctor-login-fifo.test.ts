/**
 * A credential store that is a FIFO never blocks the machine check (review
 * round 50): the reader opens only bounded regular files, so a FIFO at the
 * claude mirror path reads as unknown at once instead of waiting for a writer.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLoginState } from "../src/harness-health.js";

test("a FIFO at the claude mirror path is unknown and the read returns at once", () => {
  const home = mkdtempSync(join(tmpdir(), "codemux-doctor-fifo-"));
  try {
    mkdirSync(join(home, ".claude"));
    const fifo = join(home, ".claude", ".credentials.json");
    const made = Bun.spawnSync(["mkfifo", fifo]);
    if (made.exitCode !== 0) return; // no mkfifo here: nothing to prove
    const started = performance.now();
    const state = claudeLoginState(home);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(state.state).toBe("unknown");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
