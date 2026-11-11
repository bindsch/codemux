import { expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { refusingCall } from "./helpers/session-cli-hermetic.js";
import { turnLaunchFixture } from "./helpers/session-turn-launch.js";

test("aider fresh, resumed, and final sessions use one private home", async () => {
  const fixture = turnLaunchFixture("aider");
  try {
    const first = await fixture.run(["--hermetic"]);
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.driveError).toBeUndefined();
    const started = first.events.find((event) => event.type === "session_started")!;
    const id = started.session_id as string;
    const home = started.private_home as string;
    expect(home).toBe(join(fixture.parent, `session-${id}`));
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "history.md")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "analytics.jsonl")).mode & 0o777).toBe(0o600);
    expect(fixture.record().harness_home).toBe(home);
    const context = refusingCall(() => fixture.context(id));
    expect(context.code, context.message).toBeNull();
    expect(context.value?.harnessHome).toBe(home);
    const resumed = await fixture.run(["--hermetic", "--resume", id]);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.events.find((event) => event.type === "session_started")?.private_home).toBe(home);
    const final = await fixture.run(["--hermetic", "--resume", id, "--final"]);
    expect(final.exitCode, final.stderr).toBe(0);
    expect(fixture.record().final).toBe(true);
    expect(final.events.find((event) => event.type === "session_ended")?.resumable).toBe(false);
    expect(existsSync(home)).toBe(false);
    expect(fixture.observations().map((entry) => entry.redirected)).toEqual([home, home, home]);
  } finally { fixture.cleanup(); }
});

test("aider final on its first session stamps the newly minted record", async () => {
  const fixture = turnLaunchFixture("aider");
  try {
    const final = await fixture.run(["--hermetic", "--final"]);
    expect(final.exitCode, final.stderr).toBe(0);
    expect(fixture.record().final).toBe(true);
    expect(final.events.find((event) => event.type === "session_ended")?.resumable).toBe(false);
    expect(existsSync(fixture.record().harness_home)).toBe(false);
  } finally { fixture.cleanup(); }
});
