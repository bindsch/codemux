// Review m4 (scratch/fix/review-owner-integration.md): a turn agent's
// --print-sandbox preview carries the per-turn inputs a real turn does,
// so the printed scode line is the one a turn would exec.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { turnLaunchFixture } from "./helpers/session-turn-launch.js";
import { runSessionCommand } from "./helpers/session-command.js";

test("goose: --tools none reaches the printed turn argv", async () => {
  const fixture = turnLaunchFixture("goose");
  try {
    const result = await runSessionCommand(fixture.args(["--print-sandbox", "--tools", "none"]),
      fixture.binaries, { env: fixture.env, setup: fixture.setup, registryFile: fixture.registryFile });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.split("\n")).toContain("--no-profile");
    expect(existsSync(join(fixture.state, "argv.jsonl"))).toBe(false);
  } finally { fixture.cleanup(); }
});

test("pi: --enable-playwright-mcp reaches the printed turn argv", async () => {
  const fixture = turnLaunchFixture("pi");
  try {
    const args = fixture.args(["--print-sandbox", "--enable-playwright-mcp"]);
    args[args.indexOf("--auto") + 1] = "low";
    const result = await runSessionCommand(args,
      { ...fixture.binaries, "playwright-mcp": "exit 0" },
      { env: fixture.env, setup: fixture.setup, registryFile: fixture.registryFile });
    expect(result.exitCode, result.stderr).toBe(0);
    const lines = result.stdout.split("\n");
    const extension = lines.indexOf("--extension");
    expect(extension, result.stdout).toBeGreaterThan(-1);
    expect(lines[extension + 1]).toContain("playwright");
    expect(existsSync(join(fixture.state, "argv.jsonl"))).toBe(false);
  } finally { fixture.cleanup(); }
});
