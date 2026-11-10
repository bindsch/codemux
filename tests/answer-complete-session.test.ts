/**
 * Lane AN1 for sessions: a turn's assistant text is every message the
 * agent wrote after the user turn, in order, never only the last one.
 * Each fake stream is text, tool call, text, tool call, empty final
 * message; the turn must report both texts.
 */
import { describe, expect, test } from "bun:test";
import { CodexStreamParser } from "../src/session/codex-session.js";
import { GeminiAcpSessionDriver, GEMINI_ACP_DRIVER_PROFILE } from "../src/session/gemini-acp-driver.js";
import { ClineSessionDriver } from "../src/session/cline-driver.js";
import { CLINE_ACP_DRIVER_PROFILE } from "../src/session/cline-session.js";
import { aiderTurnAnswer, aiderTurnAnswerLoose } from "../src/session/aider-turn-answer.js";
import { aiderHistoryHeader } from "../src/aider-history-text.js";
import { buildDroidSessionCommand, parseDroidSessionTurn } from "../src/session/droid-session.js";
import type { TurnAgentDriverOptions } from "../src/session/turn-driver-types.js";
import { fakeTurnProcess, type FakeTurnProcess } from "./helpers/session-turn-engine.js";

type Event = Record<string, any>;
const FULL = "Findings 1 to 19.\n\nFinding 20.";
async function tick() { for (let index = 0; index < 30; index++) await Promise.resolve(); }

function baseOptions(events: Event[], children: FakeTurnProcess[], onSpawn: (child: FakeTurnProcess) => void) {
  return {
    resumeSessionId: null, autonomy: "high" as const, cwd: process.cwd(), hermetic: false, sandboxed: false,
    sandboxTrust: "standard" as const, sandboxNoNet: false, sandboxScrubEnv: false, passEnv: [],
    authorPrefix: false, sessionTimeoutMs: null, registryPath: null, harnessHome: process.cwd(),
    providerBaseUrl: null, privateHome: null, final: false,
    spawnTurn: async (build: (env: Record<string, string>) => string[]) => {
      build({});
      const child = fakeTurnProcess();
      child.endInput = () => child.exit(0);
      child.requestStop = () => child.exit(0);
      onSpawn(child);
      children.push(child);
      return child;
    },
    sink: (line: string) => { events.push(JSON.parse(line)); },
  };
}

/** The ACP update sequence both ACP drivers share. */
function acpTurn(update: (value: unknown) => void): void {
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Findings 1 " } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "to 19." } });
  update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "read", rawInput: {} });
  update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [] });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Finding 20." } });
  update({ sessionUpdate: "tool_call", toolCallId: "t2", title: "read", rawInput: {} });
  update({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed", content: [] });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } });
}

describe("lane AN1: session turns carry every assistant message", () => {
  test("gemini ACP joins the turn's messages with a blank line", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const events: Event[] = [];
    const children: FakeTurnProcess[] = [];
    const options = { ...baseOptions(events, children, () => {}), profile: GEMINI_ACP_DRIVER_PROFILE,
      mintedSessionId: id } as unknown as TurnAgentDriverOptions;
    const driver = new GeminiAcpSessionDriver(options);
    const code = driver.run();
    const line = (event: unknown) => driver.handleHarnessLine(JSON.stringify(event));
    const reply = async (result: unknown) => {
      const request = JSON.parse(children[0]!.wrote.at(-1)!);
      line({ jsonrpc: "2.0", id: request.id, result });
      await tick();
    };
    try {
      driver.handleCallerLine(JSON.stringify({ type: "user", text: "audit" }));
      await tick();
      await reply({ protocolVersion: 1 });
      await reply({ sessionId: id });
      acpTurn((update) => line({ jsonrpc: "2.0", method: "session/update", params: { sessionId: id, update } }));
      await reply({ stopReason: "end_turn" });
      const messages = events.filter((event) => event.type === "assistant_message");
      expect(messages.map((event) => event.text)).toEqual([FULL]);
      expect(events.find((event) => event.type === "turn_completed")!.finish).toBe("end");
      driver.handleCallerEnd();
      expect(await code).toBe(0);
    } finally { driver.dispose(); }
  });

  test("cline ACP joins the turn's messages with a blank line", async () => {
    const id = "1794230000000_Ab-12_cli";
    const events: Event[] = [];
    const children: FakeTurnProcess[] = [];
    const base = baseOptions(events, children, (child) => { child.awaitEndAnswer = () => child.exited.then(() => {}); });
    const driver = new ClineSessionDriver({ ...base, profile: CLINE_ACP_DRIVER_PROFILE, autonomy: "low",
      model: "custom/m", harnessHome: "/synthetic/cline",
      readUsage: async () => ({ input_tokens: 5, output_tokens: 3, cached_input_tokens: 3, total_tokens: 11, cost_usd: 0.25 }),
    } as never);
    const code = driver.run();
    const line = (value: unknown) => driver.handleHarnessLine(JSON.stringify(value));
    const last = () => JSON.parse(children.at(-1)!.wrote.at(-1)!);
    const reply = async (result: unknown) => { line({ jsonrpc: "2.0", id: last().id, result }); await tick(); };
    try {
      driver.handleCallerLine(JSON.stringify({ type: "user", text: "audit" }));
      await tick();
      await reply({ protocolVersion: 1 });
      await reply({ sessionId: id });
      await reply({ configOptions: [] });
      expect(last().method).toBe("session/set_mode");
      await reply({});
      const prompt = last();
      expect(prompt.method).toBe("session/prompt");
      acpTurn((update) => line({ jsonrpc: "2.0", method: "session/update", params: { sessionId: id, update } }));
      line({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } });
      await tick();
      const messages = events.filter((event) => event.type === "assistant_message");
      expect(messages.map((event) => event.text)).toEqual([FULL]);
      expect(events.find((event) => event.type === "turn_completed")!.finish).toBe("end");
      driver.handleCallerEnd();
      await tick();
      await code;
    } finally { driver.dispose(); }
  });

  test("codex maps every completed agentMessage, commentary included, to assistant text", () => {
    const THREAD = "0123456789abcdef";
    const TURN = "turn-fake-1";
    const parser = new CodexStreamParser();
    const ctx = { threadId: THREAD, activeTurnId: TURN };
    const feed = (item: Record<string, unknown>, method = "item/completed") =>
      parser.feed(JSON.stringify({ method, params: { threadId: THREAD, turnId: TURN, item } }), ctx);
    const texts: string[] = [];
    const collect = (parses: { kind: string; text?: string }[]) => {
      for (const parse of parses) if (parse.kind === "assistant_text") texts.push(parse.text!);
    };
    collect(feed({ type: "agentMessage", id: "m1", text: "Findings 1 to 19.", phase: "commentary" }));
    collect(feed({ type: "commandExecution", id: "c1", command: "ls", cwd: "/" }, "item/started"));
    collect(feed({ type: "agentMessage", id: "m2", text: "Finding 20.", phase: "commentary" }));
    collect(feed({ type: "commandExecution", id: "c2", command: "ls", cwd: "/" }, "item/started"));
    collect(feed({ type: "agentMessage", id: "m3", text: "", phase: "final_answer" }));
    expect(texts).toEqual(["Findings 1 to 19.", "Finding 20.", ""]);
  });

  test("aider keeps every reply of the turn, reflected replies included", () => {
    const header = aiderHistoryHeader("audit");
    const delta = [
      "", "Findings 1 to 19.", "",
      "> Applied edit to a.py", "> Fix lint errors? (Y)es/(N)o [Yes]: y", "",
      "Finding 20.", "",
      "> Applied edit to a.py", "",
    ].join("\n");
    expect(aiderTurnAnswer(delta)).toBe(FULL);
    expect(aiderTurnAnswerLoose(`${header}${delta}`)).toBe(FULL);
    // One reply with no chatter stays verbatim (the pre-AN1 extraction).
    expect(aiderTurnAnswer("\nOK\n\n")).toBe("OK");
    expect(aiderTurnAnswer("> chatter only\n")).toBe("");
  });
});

describe("droid session turns read the stream", () => {
  test("a droid turn launches on stream-json and its answer is every message", () => {
    expect(buildDroidSessionCommand({})).toEqual(["droid", "exec", "--output-format", "stream-json"]);
    const stream = [
      { type: "message", role: "assistant", id: "a1", text: "Findings 1 to 19." },
      { type: "tool_call", id: "t1", messageId: "a1", toolName: "Read", parameters: {} },
      { type: "tool_result", id: "t1", value: "x" },
      { type: "message", role: "assistant", id: "a2", text: "Finding 20." },
      { type: "tool_call", id: "t2", messageId: "a2", toolName: "Read", parameters: {} },
      { type: "tool_result", id: "t2", value: "y" },
      { type: "completion", finalText: "Finding 20.", session_id: "s1" },
    ].map((event) => JSON.stringify(event)).join("\n");
    expect(parseDroidSessionTurn(stream, { knownSessionId: null })).toMatchObject({ answer: FULL, sessionId: "s1" });
  });
});
