import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { turnLaunchFixture } from "./helpers/session-turn-launch.js";
import { runSessionCommand } from "./helpers/session-command.js";
import { SESSION_AGENTS } from "../src/session/cli-agents.js";

test.each(["pi", "gemini", "copilot"] as const)("%s prints a turn sandbox without a turn", async (agent) => {
  const fixture = turnLaunchFixture(agent);
  try {
    const result = await runSessionCommand(fixture.args(["--hermetic", "--print-sandbox"]),
      fixture.binaries, { env: fixture.env, setup: fixture.setup, registryFile: fixture.registryFile });
    expect(result.exitCode, result.stderr).toBe(0);
    const native = SESSION_AGENTS[agent]!.interrupt;
    expect(result.stdout).toContain(native && agent === "gemini" ? "--acp" : native && agent === "copilot" ? "--stdio" : "--session-id");
    expect(result.stdout).toContain(agent);
    expect(result.stdout).toContain("--ro");
    expect(result.stdout).toContain(".codemux-hermetic/session-");
    expect(existsSync(fixture.registryFile)).toBe(false);
    expect(existsSync(join(fixture.state, "argv.jsonl"))).toBe(false);
  } finally { fixture.cleanup(); }
});
