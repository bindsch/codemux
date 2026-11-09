import { describe, expect, test } from "bun:test";
import { PiRpcSessionDriver } from "../src/session/pi-rpc-driver.js";
import { PI_DRIVER_PROFILE } from "../src/session/pi-driver.js";
import type { TurnAgentDriverOptions, TurnAgentProfile } from "../src/session/turn-driver-types.js";
import { fakeTurnProcess, type FakeTurnProcess } from "./helpers/session-turn-engine.js";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

function harness(options: { delayed?: boolean; profile?: TurnAgentProfile; failPrompt?: boolean; turnTimeoutMs?: number } = {}) {
  const events: Record<string, unknown>[] = [];
  const commands: string[][] = [];
  const children: FakeTurnProcess[] = [];
  const landing = Promise.withResolvers<void>();
  const spawnTurn: TurnAgentDriverOptions["spawnTurn"] = async (build) => {
    commands.push(build({}));
    if (options.delayed) await landing.promise;
    const child = fakeTurnProcess();
    child.failWrites = options.failPrompt ?? false;
    child.endInput = () => child.exit(0);
    child.requestStop = () => child.exit(0);
    children.push(child);
    return child;
  };
  const driver = new PiRpcSessionDriver({
    profile: options.profile ?? PI_DRIVER_PROFILE,
    resumeSessionId: null, mintedSessionId: ID, autonomy: "read-only", model: "pi-test",
    cwd: process.cwd(), hermetic: false, sandboxed: false, sandboxTrust: "standard",
    sandboxNoNet: false, sandboxScrubEnv: false, passEnv: [], authorPrefix: false,
    sessionTimeoutMs: null, registryPath: null, harnessHome: "/synthetic/pi",
    turnTimeoutMs: options.turnTimeoutMs,
    providerBaseUrl: null, spawnTurn, privateHome: null, final: false,
    sink: (line) => { events.push(JSON.parse(line)); },
  });
  const code = driver.run();
  const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const line = (event: unknown) => driver.handleHarnessLine(JSON.stringify(event));
  const ready = (id = ID) => {
    line({ id: "state", type: "response", command: "get_state", success: true, data: { sessionId: id } });
    line({ id: "prompt", type: "response", command: "prompt", success: true });
  };
  const complete = async (stopReason = "stop", id = ID) => {
    ready(id);
    line({ type: "message_end", message: {
      role: "assistant", content: [{ type: "text", text: "synthetic answer" }],
      stopReason, model: "pi-served",
      usage: { input: 12, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 17, cost: { total: 0.02 } },
    } });
    line({ type: "agent_end" });
    line({ type: "agent_settled" });
    await tick();
  };
  const send = (event: unknown) => driver.handleCallerLine(JSON.stringify(event));
  return { driver, events, commands, children, landing, line, ready, complete, tick, send, code,
    user: () => send({ type: "user", text: "prompt with\na newline" }),
    end: async () => { driver.handleCallerEnd(); await tick(); const value = await code; driver.dispose(); return value; },
  };
}

describe("Pi RPC turns reuse the S1 session lifecycle", () => {
  test("RPC receives framed prompt/state commands and ends on agent_settled", async () => {
    const h = harness();
    h.user();
    await h.tick();
    const argv = h.commands[0]!;
    expect(argv).toContain("rpc");
    expect(argv).not.toContain("--print");
    expect(argv).toContain(ID);
    expect(h.children[0]!.wrote[0]!.trim().split("\n").map((line) => JSON.parse(line)))
      .toEqual([{ id: "state", type: "get_state" }, { id: "prompt", type: "prompt", message: "prompt with\na newline" }]);
    await h.complete();
    expect(h.events.find((event) => event.type === "turn_completed"))
      .toMatchObject({ finish: "end", usage: { input_tokens: 12, output_tokens: 3 } });
    expect(await h.end()).toBe(0);
  });

  test("agent_end leaves RPC open for a retry until agent_settled", async () => {
    const h = harness();
    h.user(); await h.tick(); h.ready();
    h.line({ type: "agent_end", willRetry: true });
    await h.tick();
    expect(h.events.some((event) => event.type === "turn_completed")).toBe(false);
    expect(h.events.some((event) => event.type === "session_ended")).toBe(false);
    await h.complete();
    expect(h.events.find((event) => event.type === "turn_completed")?.finish).toBe("end");
    expect(await h.end()).toBe(0);
  });

  test("abort waits for prompt preflight, is sent once, and preserves the next turn", async () => {
    const h = harness({ delayed: true });
    h.user();
    h.send({ type: "interrupt" });
    h.send({ type: "interrupt" });
    expect(h.children).toHaveLength(0);
    h.landing.resolve();
    await h.tick();
    expect(h.children[0]!.wrote).toHaveLength(1);
    h.ready();
    expect(h.children[0]!.wrote).toHaveLength(2);
    expect(JSON.parse(h.children[0]!.wrote[1]!)).toEqual({ id: "abort", type: "abort" });
    await h.complete("aborted");
    expect(h.events.find((event) => event.type === "turn_completed"))
      .toMatchObject({ finish: "interrupted", usage: { total_tokens: 17 } });
    h.user();
    await h.tick();
    await h.complete();
    expect(h.events.filter((event) => event.type === "turn_completed").map((event) => event.finish))
      .toEqual(["interrupted", "end"]);
    expect(h.commands[1]).toEqual(h.commands[0]);
    expect(await h.end()).toBe(0);
    h.driver.handleHarnessLine("ignored after settlement");
  });

  test("idle and malformed interrupts get refusal acknowledgments", async () => {
    const h = harness();
    h.send({ type: "interrupt" });
    h.send({ type: "interrupt", extra: 1 });
    h.driver.handleCallerLine("not json");
    h.send(null);
    await h.tick();
    expect(h.events.filter((event) => event.type === "input_ack").every((event) => event.accepted === false)).toBe(true);
    expect(await h.end()).toBe(0);
    h.send({ type: "interrupt" });
  });

  test("an abort that races a normal completion does not invent interruption", async () => {
    const h = harness();
    h.user(); await h.tick(); h.ready(); h.send({ type: "interrupt" });
    await h.complete();
    expect(h.events.find((event) => event.type === "turn_completed")?.finish).toBe("end");
    expect(await h.end()).toBe(0);
  });

  test("an unrequested aborted message remains a harness failure", async () => {
    const h = harness();
    h.user(); await h.tick(); await h.complete("aborted");
    expect(h.events.find((event) => event.type === "turn_completed")?.finish).toBe("failed");
    expect(await h.end()).toBe(0);
  });

  test("failed abort writes fail the session without waiting for a reply", async () => {
    const h = harness();
    h.user(); await h.tick(); h.ready();
    h.children[0]!.failWrites = true;
    h.send({ type: "interrupt" });
    expect(await h.code).toBe(1);
    expect(h.events.some((event) => event.type === "error" && event.message === "could not deliver the pi abort command")).toBe(true);
    h.driver.dispose();
  });

  test("native failed responses and missing identity fail closed", async () => {
    for (const kind of ["response", "missing", "wrong"] as const) {
      const h = harness();
      h.user(); await h.tick();
      if (kind === "response") {
        h.line({ type: "response", command: "prompt", success: false, error: "rejected" });
      } else {
        h.ready(kind === "wrong" ? OTHER_ID : ID);
        if (kind === "missing") {
          // A response with the wrong correlation id cannot establish identity.
          const noHeader = harness();
          noHeader.user(); await noHeader.tick();
          noHeader.line({ type: "response", command: "get_state", id: "foreign", success: true, data: { sessionId: ID } });
          noHeader.line({ type: "agent_settled" });
          expect(await noHeader.code).toBe(1);
          noHeader.driver.dispose();
        }
        await h.complete("stop", kind === "wrong" ? OTHER_ID : ID);
      }
      expect(await h.end()).toBe(kind === "missing" ? 0 : 1);
    }
  });

  test("non-JSON and scalar output reach the existing no-wire checks", async () => {
    const h = harness();
    h.user(); await h.tick();
    h.driver.handleHarnessLine("not json");
    h.line(42);
    h.line({ type: "agent_settled" });
    expect(await h.code).toBe(1);
    h.driver.dispose();
  });

  test("prompt write failure and a wrong profile fail the spawn path", async () => {
    const fail = harness({ failPrompt: true });
    fail.user(); await fail.tick(); expect(await fail.code).toBe(1); fail.driver.dispose();
    const malformed = harness({ profile: { ...PI_DRIVER_PROFILE, buildTurnCommand: () => ["pi"] } });
    malformed.user(); await malformed.tick(); expect(await malformed.code).toBe(1); malformed.driver.dispose();
  });

  test("turn timeout first aborts and the next expiry ends an unresponsive turn", async () => {
    const h = harness({ turnTimeoutMs: 5 });
    h.user(); await h.tick(); h.ready();
    await Bun.sleep(7);
    expect(h.children[0]!.wrote.some((wire) => wire.includes('"type":"abort"'))).toBe(true);
    await Bun.sleep(7);
    expect(await h.code).toBe(1);
    expect(h.events.at(-1)).toMatchObject({ type: "session_ended", reason: "timeout" });
    h.driver.dispose();
  });

  test("timely abort completion clears escalation and leaves the session usable", async () => {
    const h = harness({ turnTimeoutMs: 20 });
    h.user(); await h.tick(); h.ready();
    await Bun.sleep(23);
    await h.complete("aborted");
    await Bun.sleep(23);
    expect(h.events.some((event) => event.type === "session_ended")).toBe(false);
    expect(await h.end()).toBe(0);
  });
});
