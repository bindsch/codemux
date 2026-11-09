// Review m5 (scratch/fix/review-owner-integration.md): a second-wave
// session that aborts after its driver arm opened a fresh private home
// and before the driver ran removes that home, instead of leaving it to
// the two-day sweep.
import { expect, spyOn, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import * as cliRecord from "../src/session/cli-record.js";
import { turnLaunchFixture } from "./helpers/session-turn-launch.js";
import { runSessionCommand } from "./helpers/session-command.js";

test.each(["pi", "copilot", "droid"] as const)("%s: an abort before the driver runs removes the fresh home", async (agent) => {
  const fixture = turnLaunchFixture(agent);
  let opened: string[] = [];
  try {
    const result = await runSessionCommand(fixture.args(["--hermetic"]), fixture.binaries, {
      env: fixture.env, registryFile: fixture.registryFile,
      setup: () => {
        const restore = fixture.setup();
        const record = spyOn(cliRecord, "recordSessionBeforeSpawn").mockImplementation(() => {
          // The driver arm opened the home before this step.
          opened = existsSync(fixture.parent) ? readdirSync(fixture.parent) : [];
          throw new Error("synthetic pre-spawn failure");
        });
        return () => { record.mockRestore(); restore(); };
      },
    });
    expect(result.stderr).toContain("synthetic pre-spawn failure");
    expect(opened.length, "the home existed before the abort").toBe(1);
    expect(existsSync(fixture.parent) ? readdirSync(fixture.parent) : []).toEqual([]);
  } finally { fixture.cleanup(); }
});
