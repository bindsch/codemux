import { afterAll, expect, test } from "bun:test";
import { hermeticFixture, HERMETIC_AGENTS } from "./helpers/session-cli-hermetic.js";
import { turnLaunchFixture, TURN_LAUNCH_AGENTS } from "./helpers/session-turn-launch.js";
import * as claude from "./helpers/session-e2e.js";
import * as opencode from "./helpers/session-opencode-e2e.js";
import { readRegistry } from "../src/session/registry.js";

afterAll(async () => {
  for (const cleanup of [...claude.cleanups, ...opencode.cleanups].reverse()) await cleanup();
});

test.each(HERMETIC_AGENTS)("%s records the disabled login store; only a native-store agent requires it on resume", async (agent) => {
  const fixture = hermeticFixture(agent);
  try {
    const fresh = await fixture.run(["--sandbox-no-login-store"], { scodeVersion: "0.6.11" });
    expect(fresh.exitCode, fresh.stderr).toBe(0);
    const record = fixture.record();
    expect(record.sandbox_no_login_store).toBe(true);
    // Review round 5: the restriction withholds grants only Claude and agy
    // have, so codex and kimi resume without it.
    const dropped = await fixture.run(["--resume", record.id], { scodeVersion: "0.6.11" });
    if (agent === "agy") {
      expect(dropped.exitCalls, dropped.stderr).toContain(78);
      expect(dropped.stderr).toContain("--sandbox-no-login-store");
    } else expect(dropped.exitCode, dropped.stderr).toBe(0);
    const resumed = await fixture.run(["--sandbox-no-login-store", "--resume", record.id], { scodeVersion: "0.6.11" });
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(fixture.record().sandbox_no_login_store).toBe(true);
  } finally { fixture.cleanup(); }
}, 30_000);

test.each(TURN_LAUNCH_AGENTS)("%s records the disabled login store for per-turn children", async (agent) => {
  const fixture = turnLaunchFixture(agent);
  try {
    const result = await fixture.run(["--sandbox-no-login-store"], { scodeVersion: "0.6.11" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(fixture.record().sandbox_no_login_store).toBe(true);
  } finally { fixture.cleanup(); }
});

test("Claude and OpenCode registry writers retain the login-store restriction", async () => {
  for (const harness of [claude, opencode]) {
    const session = await harness.startSession({ sandboxNoLoginStore: true });
    harness.send(session.driver as never, { type: "user", text: "scenario:basic synthetic" });
    await harness.waitFor(session.events, harness.of("turn_completed"), "turn completed");
    harness.send(session.driver as never, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const read = readRegistry(session.options.registryPath as string);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") expect(read.file.sessions[0]?.sandbox_no_login_store).toBe(true);
  }
});
