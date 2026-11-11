import { afterAll, expect, test } from "bun:test";
import { hermeticFixture, HERMETIC_AGENTS } from "./helpers/session-cli-hermetic.js";
import { turnLaunchFixture, TURN_LAUNCH_AGENTS } from "./helpers/session-turn-launch.js";
import * as claude from "./helpers/session-e2e.js";
import * as opencode from "./helpers/session-opencode-e2e.js";
import { readRegistry } from "../src/session/registry.js";

afterAll(async () => {
  for (const cleanup of [...claude.cleanups, ...opencode.cleanups].reverse()) await cleanup();
});

// Existing protocol fakes exercise recording and resume without provider calls.
test.each(HERMETIC_AGENTS)("%s records strict through the CLI driver and refuses a downgraded resume", async (agent) => {
  const fixture = hermeticFixture(agent);
  try {
    const fresh = await fixture.run(["--sandbox-strict"]);
    expect(fresh.exitCode, fresh.stderr).toBe(0);
    const record = fixture.record();
    expect(record.sandbox_strict).toBe(true);
    const refused = await fixture.run(["--resume", record.id]);
    expect(refused.exitCalls, refused.stderr).toContain(78);
    expect(refused.stderr).toContain("--sandbox-strict");
    const resumed = await fixture.run(["--sandbox-strict", "--resume", record.id]);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(fixture.record().sandbox_strict).toBe(true);
  } finally { fixture.cleanup(); }
});

test.each(HERMETIC_AGENTS)("%s refuses a private wrapped fixture with exit 64 before spawning it", async (agent) => {
  const fixture = hermeticFixture(agent);
  try {
    const result = await fixture.run(["--hermetic", "--sandbox-strict"]);
    expect(result.exitCode, result.stderr + result.stdout).toBe(64);
    expect(result.stderr + result.stdout).toContain("strict sandbox cannot read env-wrapped executable");
  } finally { fixture.cleanup(); }
});

test.each(TURN_LAUNCH_AGENTS)("%s records strict for per-turn children", async (agent) => {
  const fixture = turnLaunchFixture(agent);
  try {
    const result = await fixture.run(["--sandbox-strict"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(fixture.record().sandbox_strict).toBe(true);
  } finally { fixture.cleanup(); }
});

test("claude and opencode registry writers preserve strict", async () => {
  for (const harness of [claude, opencode]) {
    const session = await harness.startSession({ sandboxStrict: true });
    harness.send(session.driver as never, { type: "user", text: "scenario:basic synthetic" });
    await harness.waitFor(session.events, harness.of("turn_completed"), "turn completed");
    harness.send(session.driver as never, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const read = readRegistry(session.options.registryPath as string);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") expect(read.file.sessions[0]?.sandbox_strict).toBe(true);
  }
});
