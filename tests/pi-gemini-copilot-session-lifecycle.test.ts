import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { turnLaunchFixture } from "./helpers/session-turn-launch.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";

registerNoLeakedSignals();

// Each binary and scode resolve through the helper's fake PATH. The
// observer checks the real child environment without consulting credentials.
describe.each(["pi", "gemini", "copilot"] as const)("%s session parity", (agent) => {
  test("fresh, resumed, and final turns preserve identity and private state", async () => {
    const fixture = turnLaunchFixture(agent);
    try {
      const first = await fixture.run(["--hermetic"]);
      expect(first.exitCode, first.stderr).toBe(0);
      expect(first.driveError).toBeUndefined();
      const started = first.events.find((event) => event.type === "session_started")!;
      const id = started.session_id as string;
      const home = join(fixture.parent, `session-${id}`);
      expect(started).toMatchObject({ agent, private_home: home });
      expect(statSync(home).mode & 0o777).toBe(0o700);
      expect(fixture.record()).toMatchObject({ agent, hermetic: true, harness_home: home });
      expect(first.events.find((event) => event.type === "turn_completed")?.finish).toBe("end");

      const resumed = await fixture.run(["--hermetic", "--resume", id]);
      expect(resumed.exitCode, resumed.stderr).toBe(0);
      expect(resumed.driveError).toBeUndefined();
      expect(resumed.events.find((event) => event.type === "session_started"))
        .toMatchObject({ session_id: id, private_home: home });
      const observations = fixture.observations();
      expect(observations).toHaveLength(2);
      expect(observations[1]!.redirected).toBe(home);
      expect(observations[1]!.previous).toBe(observations[0]!.state);
      expect(observations[1]!.previous).not.toBeNull();
      const argv = readFileSync(join(fixture.state, "argv.jsonl"), "utf8")
        .trim().split("\n").map((line) => (JSON.parse(line) as { args: string[] }).args);
      if (agent === "copilot") {
        const rpc = readFileSync(join(fixture.state, "rpc.jsonl"), "utf8").trim().split("\n")
          .map((line) => JSON.parse(line) as { method: string; params: { sessionId: string } });
        expect(rpc.find((packet) => packet.method === "session.create")?.params.sessionId).toBe(id);
        expect(rpc.find((packet) => packet.method === "session.resume")?.params.sessionId).toBe(id);
        expect(argv[0]).toContain("--stdio");
      } else if (agent === "gemini") {
        expect(argv[0]).toContain("--acp");
        expect(argv[1]).toContain("--acp");
        const frames = readFileSync(join(fixture.state, "acp.jsonl"), "utf8")
          .trim().split("\n").map((line) => JSON.parse(line));
        expect(frames.filter((frame) => frame.method === "session/new")).toHaveLength(1);
        expect(frames.find((frame) => frame.method === "session/load")?.params.sessionId).toBe(id);
      } else {
        expect(argv[0]).toContain("--session-id");
        expect(argv[1]).toContain(agent === "pi" ? "--session-id" : "--resume");
        expect(argv[1]).toContain(id);
      }

      const final = await fixture.run(["--hermetic", "--resume", id, "--final"]);
      expect(final.exitCode, final.stderr).toBe(0);
      expect(final.driveError).toBeUndefined();
      expect(final.events.at(-1)).toMatchObject({ type: "session_ended", resumable: false });
      expect(existsSync(home)).toBe(false);
      expect(fixture.observations()[2]!.previous).toBe(observations[0]!.state);
      expect(readFileSync(join(fixture.state, "scode.txt"), "utf8").split("BEGIN\n"))
        .toHaveLength(4);
    } finally {
      fixture.cleanup();
    }
  }, 30_000);
});

test.each(["pi", "gemini", "copilot"] as const)("%s publishes native session usage", async (agent) => {
  const fixture = turnLaunchFixture(agent);
  try {
    const turn = await fixture.run(["--hermetic", "--final"]);
    expect(turn.exitCode, turn.stderr).toBe(0);
    const usage = turn.events.find((event) => event.type === "turn_completed")?.usage;
    expect(usage).toMatchObject(agent === "pi"
      ? { input_tokens: 120, output_tokens: 30, cached_input_tokens: 10, total_tokens: 160, cost_usd: 0.01 }
      : agent === "gemini" ? { input_tokens: 90, output_tokens: 20, cached_input_tokens: 10, total_tokens: 120 }
      : { input_tokens: 5, output_tokens: 5, cached_input_tokens: 0, total_tokens: 10 });
    expect(turn.events.at(-1)?.usage).toEqual(usage);
  } finally {
    fixture.cleanup();
  }
}, 30_000);
