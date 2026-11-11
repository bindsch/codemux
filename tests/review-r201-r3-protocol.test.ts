import { afterAll, expect, test } from "bun:test";
import * as claude from "./helpers/session-e2e.js";
import * as codex from "./session-codex-e2e-helpers.js";
import * as agy from "./helpers/session-agy-e2e.js";
import * as aider from "./helpers/session-aider-e2e.js";
import * as kimi from "./helpers/session-kimi-e2e.js";
import * as opencode from "./helpers/session-opencode-e2e.js";
import { assertSessionConformance } from "./helpers/session-conformance.js";
import { SESSION_AGENTS } from "../src/session/cli-agents.js";
import { TURN_AGENT_PROFILES } from "../src/session/turn-driver-launch.js";
import { engineSession, fakeTurnProcess } from "./helpers/session-turn-engine.js";
import { buildEvent } from "../src/session/protocol.js";

afterAll(async () => {
  await codex.cleanupSessions();
  for (const fixture of [claude, agy, aider, kimi, opencode]) {
    while (fixture.cleanups.length) await fixture.cleanups.pop()!();
  }
});

const native = {
  claude: () => claude.startSession(), zai: () => claude.startSession({ agent: "zai" }),
  codex: () => codex.startSession(), agy: () => agy.startSession(),
  aider: () => aider.startSession(), kimi: () => kimi.startSession(), opencode: () => opencode.startSession(),
};
for (const [agent, start] of Object.entries(native)) {
  test(`${agent} driver emits conforming envelopes and preserves mirrored line bytes`, async () => {
    const h = await start();
    const rawLines = new Set<string>();
    const original = h.driver.handleHarnessLine.bind(h.driver);
    h.driver.handleHarnessLine = (line: string) => {
      // Keep the wire valid, but give it spacing and duplicate keys a reserialization loses.
      const raw = line.trimStart().startsWith("{") ? ` { "conformance":0,"conformance":1, ${line.trim().slice(1)} ` : line;
      rawLines.add(raw); original(raw);
    };
    const before = h.events.length;
    h.driver.handleCallerLine(JSON.stringify({ type: "user", text: "scenario:tools conformance" }));
    await claude.waitFor(h.events, claude.of("turn_completed"), "protocol completion");
    h.driver.handleCallerLine(JSON.stringify({ type: "shutdown" }));
    expect(await h.code).toBe(0);
    assertSessionConformance(h.events);
    const mirrored = h.events.slice(before).filter((e) => e.raw !== null);
    expect(mirrored.length).toBeGreaterThan(0);
    for (const event of mirrored) expect(rawLines.has(event.raw)).toBe(true);
  });
}

const id = "11111111-1111-4111-8111-111111111111";
const whole = {
  cursor: [{ type: "result", subtype: "success", is_error: false, result: "answer", session_id: id }],
  droid: [{ type: "result", subtype: "success", is_error: false, result: "answer", session_id: id }],
  qwen: [[{ type: "result", subtype: "success", is_error: false, result: "answer", session_id: id }]],
  goose: [{ session_id: "20261109_120000", content: "answer" }],
  openhands: [{ kind: "MessageEvent", source: "agent", llm_message: { content: [{ type: "text", text: "answer" }] } }],
};
for (const [agent, frames] of Object.entries(whole)) {
  test(`${agent} whole-output driver emits conforming synthetic events with null raw`, async () => {
    const child = fakeTurnProcess();
    const profile = TURN_AGENT_PROFILES[agent as keyof typeof whole];
    const h = engineSession({ options: { profile, resumeSessionId: agent === "goose" ? "20261109_120000" : id, spawnTurn: async () => child } });
    try {
      h.user(); await h.wait("turn_started");
      for (const frame of frames) h.line(JSON.stringify(frame));
      if (agent === "openhands") h.line(`Conversation ID: ${id.replaceAll("-", "")}`);
      child.exit(0); const completed = await h.wait("turn_completed");
      expect(completed.finish).toBe("end");
      h.close(); expect(await h.code()).toBe(0);
      assertSessionConformance(h.events);
      expect(h.events.every((e) => e.raw === null)).toBe(true);
    } finally { child.exit(0); h.close(); await h.code(); h.dispose(); }
  });
}

test("conformance coverage names every session agent, including the four native RPC/ACP suites", () => {
  expect([...Object.keys(native), ...Object.keys(whole), "pi", "copilot", "gemini", "cline"].sort())
    .toEqual(Object.keys(SESSION_AGENTS).sort());
});

test.each([undefined, null, [], "{bad", 1, false, { command: "ls" }].map((input) => [input]))("tool input contract handles %j", (input) => {
  const raw = ` { "arguments":${JSON.stringify(input) ?? "null"}, "x":1, "x":2 } `;
  const event = JSON.parse(buildEvent(1, id, "tool_call", raw, { call_id: "call", name: "tool", input }));
  assertSessionConformance([event]); expect(event.raw).toBe(raw);
  expect(event.input).toEqual(input && typeof input === "object" && !Array.isArray(input) ? input : {});
});
