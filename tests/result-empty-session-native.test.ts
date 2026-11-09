import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { readCallLog } from "../src/call-log.js";
import { CopilotAdapter } from "../src/adapters/copilot.js";
import { KimiSessionDriver } from "../src/session/kimi-driver.js";
import { PiRpcSessionDriver } from "../src/session/pi-rpc-driver.js";
import { PI_DRIVER_PROFILE } from "../src/session/pi-driver.js";
import { GeminiAcpSessionDriver, GEMINI_ACP_DRIVER_PROFILE } from "../src/session/gemini-acp-driver.js";
import { CopilotRpcSessionDriver } from "../src/session/copilot-rpc-driver.js";
import { COPILOT_DRIVER_PROFILE } from "../src/session/copilot-driver.js";
import { CopilotRpcFramer, encodeCopilotRpc } from "../src/session/copilot-rpc-framing.js";
import type { TurnAgentDriverOptions } from "../src/session/turn-driver-types.js";
import { fakeTurnProcess, type FakeTurnProcess } from "./helpers/session-turn-engine.js";

const ID = "11111111-2222-4333-8444-555555555555";
const KIMI_ID = `session_${ID}`;
type Event = Record<string, any>;
async function tick() { for (let index = 0; index < 20; index++) await Promise.resolve(); }

test("kimi whitespace success fails in both the event and the session ledger", async () => {
  const root = mkdtempSync(join(import.meta.dir, "../scratch/fix/empty-kimi-"));
  const previous = process.env.CODEMUX_CALL_LOG;
  const ledgerPath = join(root, "calls.jsonl");
  process.env.CODEMUX_CALL_LOG = ledgerPath;
  const events: Event[] = [];
  const children: FakeTurnProcess[] = [];
  const driver = new KimiSessionDriver({
    resumeSessionId: KIMI_ID, autonomy: "high", cwd: root, hermetic: false,
    sandboxed: true, sandboxTrust: "standard", sandboxNoNet: false, sandboxScrubEnv: false,
    passEnv: [], authorPrefix: false, sessionTimeoutMs: null, registryPath: null,
    harnessHome: root, providerBaseUrl: null,
    spawnTurn: async () => { const child = fakeTurnProcess(); children.push(child); return child; },
    sink: (line) => { events.push(JSON.parse(line)); },
  });
  const code = driver.run();
  try {
    for (const [index, text] of [" \n\t", "answer"].entries()) {
      driver.handleCallerLine(JSON.stringify({ type: "user", text: "question" }));
      await tick();
      driver.handleHarnessLine(JSON.stringify({ role: "assistant", content: text }));
      driver.handleHarnessLine(JSON.stringify({ role: "meta", type: "session.resume_hint",
        session_id: KIMI_ID, command: `kimi -r ${KIMI_ID}`,
        content: `To resume this session: kimi -r ${KIMI_ID}` }));
      children[index]!.exit(0);
      await tick();
      const completed = events.filter((event) => event.type === "turn_completed").at(-1)!;
      expect(completed.finish).toBe(index === 0 ? "failed" : "end");
      if (index === 0) expect(completed.reason).toBe("empty answer");
      expect(readCallLog(ledgerPath).entries.at(-1)?.record?.finish).toBe(completed.finish);
    }
    driver.handleCallerEnd();
    expect(await code).toBe(0);
  } finally {
    driver.dispose();
    if (previous === undefined) delete process.env.CODEMUX_CALL_LOG;
    else process.env.CODEMUX_CALL_LOG = previous;
  }
});

function rpcFixture(agent: "pi" | "gemini" | "copilot") {
  const events: Event[] = [];
  const children: FakeTurnProcess[] = [];
  let driver: PiRpcSessionDriver | GeminiAcpSessionDriver | CopilotRpcSessionDriver;
  const options: TurnAgentDriverOptions = {
    profile: agent === "pi" ? PI_DRIVER_PROFILE : agent === "gemini" ? GEMINI_ACP_DRIVER_PROFILE : COPILOT_DRIVER_PROFILE,
    resumeSessionId: null, mintedSessionId: ID, autonomy: "high", cwd: process.cwd(),
    hermetic: false, sandboxed: false, sandboxTrust: "standard", sandboxNoNet: false,
    sandboxScrubEnv: false, passEnv: [], authorPrefix: false, sessionTimeoutMs: null,
    registryPath: null, harnessHome: process.cwd(), providerBaseUrl: null, privateHome: null, final: false,
    spawnTurn: async (build) => {
      build({});
      const child = fakeTurnProcess();
      child.endInput = () => {
        if (driver instanceof CopilotRpcSessionDriver) driver.handleHarnessEnd();
        child.exit(0);
      };
      child.requestStop = () => child.exit(0);
      children.push(child);
      return child;
    },
    sink: (line) => { events.push(JSON.parse(line)); },
  };
  driver = agent === "pi" ? new PiRpcSessionDriver(options)
    : agent === "gemini" ? new GeminiAcpSessionDriver(options)
    : new CopilotRpcSessionDriver({ ...options, adapter: new CopilotAdapter({}),
      request: { agent: "copilot", prompt: "", cwd: process.cwd(), hermetic: false },
      context: () => undefined, rpcTimeoutMs: 1000 });
  const code = driver.run();
  const line = (event: unknown) => driver.handleHarnessLine(JSON.stringify(event));
  const user = async () => {
    driver.handleCallerLine(JSON.stringify({ type: "user", text: "question" }));
    await tick();
  };
  const end = async () => { driver.handleCallerEnd(); expect(await code).toBe(0); };
  return { driver, events, children, line, user, end };
}

test("pi RPC empty successful responses fail", async () => {
  for (const text of ["", " \n\t", "answer"]) {
    const h = rpcFixture("pi");
    try {
      await h.user();
      h.line({ id: "state", type: "response", command: "get_state", success: true, data: { sessionId: ID } });
      h.line({ id: "prompt", type: "response", command: "prompt", success: true });
      h.line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }],
        stopReason: "stop", usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10 } } });
      h.line({ type: "agent_end" });
      h.line({ type: "agent_settled" });
      await tick();
      const completed = h.events.find((event) => event.type === "turn_completed")!;
      expect(completed.finish).toBe(text === "answer" ? "end" : "failed");
      if (text !== "answer") expect(completed.reason).toBe("empty answer");
      await h.end();
    } finally { h.driver.dispose(); }
  }
});

test("gemini ACP counts only nonempty assistant chunks as an answer", async () => {
  for (const text of [undefined, " \n\t", "answer"]) {
    const h = rpcFixture("gemini");
    try {
      await h.user();
      const reply = async (result: unknown) => {
        const request = JSON.parse(h.children[0]!.wrote.at(-1)!);
        h.line({ jsonrpc: "2.0", id: request.id, result });
        await tick();
      };
      await reply({ protocolVersion: 1 });
      await reply({ sessionId: ID });
      if (text !== undefined) h.line({ jsonrpc: "2.0", method: "session/update", params: { sessionId: ID,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      await reply({ stopReason: "end_turn" });
      const completed = h.events.find((event) => event.type === "turn_completed")!;
      expect(completed.finish).toBe(text === "answer" ? "end" : "failed");
      if (text !== "answer") expect(completed.reason).toBe("empty answer");
      await h.end();
    } finally { h.driver.dispose(); }
  }
});

test("copilot RPC idle after empty assistant content reports an empty answer", async () => {
  for (const text of ["", " \n\t", "answer"]) {
    const h = rpcFixture("copilot");
    const driver = h.driver as CopilotRpcSessionDriver;
    const answered = new Set<string>();
    const respond = async () => {
      for (let pass = 0; pass < 12; pass++) {
        await tick();
        for (const text of h.children[0]!.wrote) {
          const packet = new CopilotRpcFramer().push(Buffer.from(text))[0] as Event;
          if (answered.has(String(packet.id))) continue;
          answered.add(String(packet.id));
          const result = packet.method === "session.create" ? { sessionId: ID }
            : packet.method === "session.usage.getMetrics" ? { modelMetrics: { served: { usage: {
              inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0,
            } } } }
            : packet.method === "session.mode.set" ? { status: "success", modeApplied: true }
            : { success: true, messageId: "message" };
          driver.handleHarnessBytes(encodeCopilotRpc({ jsonrpc: "2.0", id: packet.id, result }));
        }
      }
    };
    const native = (event: unknown) => driver.handleHarnessBytes(encodeCopilotRpc({
      jsonrpc: "2.0", method: "session.event", params: { sessionId: ID, event },
    }));
    try {
      await h.user();
      await respond();
      native({ type: "assistant.message", data: { content: text, model: "served" } });
      native({ type: "session.idle" });
      await respond();
      const completed = h.events.find((event) => event.type === "turn_completed")!;
      expect(completed.finish).toBe(text === "answer" ? "end" : "failed");
      if (text !== "answer") expect(completed.reason).toBe("empty answer");
      await h.end();
    } finally { driver.dispose(); }
  }
});
