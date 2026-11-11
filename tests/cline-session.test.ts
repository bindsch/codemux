import { describe, expect, test } from "bun:test";
import { buildClineSessionCommand, CLINE_ACP_DRIVER_PROFILE, CLINE_SESSION_ID_PATTERN, clineSessionCapabilities } from "../src/session/cline-session.js";
import { ClineSessionDriver, type ClineDriverOptions } from "../src/session/cline-driver.js";
import { clineTurnUsage, freshClineUsage, parseClineHistoryUsage } from "../src/session/cline-usage.js";
import { emptyUsage } from "../src/result-envelope.js";
import { assertSessionConformance } from "./helpers/session-conformance.js";
import { fakeTurnProcess, type FakeTurnProcess } from "./helpers/session-turn-engine.js";

const id = "1794230000000_Ab-12_cli";
const usage = { input_tokens: 5, output_tokens: 3, cached_input_tokens: 3, total_tokens: 11, cost_usd: 0.25 };
function rig(options: Partial<ClineDriverOptions> & { delayed?: boolean; failWrites?: boolean } = {}) {
  const events: Record<string, any>[] = [], commands: string[][] = [], children: FakeTurnProcess[] = [];
  const landing = Promise.withResolvers<void>();
  let driver: ClineSessionDriver;
  driver = new ClineSessionDriver({
    profile: CLINE_ACP_DRIVER_PROFILE, resumeSessionId: null, autonomy: "low", model: "custom/not-in-catalog",
    cwd: process.cwd(), hermetic: false, sandboxed: false, sandboxTrust: "standard", sandboxNoNet: false,
    sandboxScrubEnv: false, passEnv: [], authorPrefix: false, sessionTimeoutMs: null, registryPath: null,
    harnessHome: "/synthetic/cline", providerBaseUrl: null, privateHome: null, final: false,
    readUsage: async () => usage, ...options,
    spawnTurn: async (build) => {
      commands.push(build({})); if (options.delayed) await landing.promise;
      const child = fakeTurnProcess(); child.failWrites = options.failWrites ?? false;
      child.endInput = () => child.exit(0); child.requestStop = () => child.exit(0);
      child.awaitEndAnswer = () => child.exited.then(() => {});
      children.push(child); return child;
    }, sink: (line) => { events.push(JSON.parse(line)); },
  });
  const code = driver.run();
  const tick = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
  const line = (value: unknown) => driver.handleHarnessLine(JSON.stringify(value));
  const last = () => JSON.parse(children.at(-1)!.wrote.at(-1)!);
  const reply = async (result: unknown) => { line({ jsonrpc: "2.0", id: last().id, result }); await tick(); };
  const update = (value: unknown) => line({ jsonrpc: "2.0", method: "session/update", params: { sessionId: id, update: value } });
  const ready = async (resumed = false) => {
    expect(last().method).toBe("initialize"); await reply({ protocolVersion: 1 });
    expect(last().method).toBe(resumed ? "session/load" : "session/new");
    if (resumed) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old replay" } });
    await reply(resumed ? {} : { sessionId: id });
    if (options.model !== undefined || !("model" in options)) {
      expect(last()).toMatchObject({ method: "session/set_config_option", params: { configId: "model", value: options.model ?? "custom/not-in-catalog" } });
      await reply({ configOptions: [] });
    }
    expect(last()).toMatchObject({ method: "session/set_mode", params: { modeId: options.autonomy === "read-only" ? "plan" : "act" } });
    await reply({}); expect(last().method).toBe("session/prompt");
  };
  const complete = async (reason = "end_turn", text: string | null = "answer") => {
    if (text !== null) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    const prompt = children.at(-1)!.wrote.map((wire) => JSON.parse(wire)).find((frame) => frame.method === "session/prompt");
    line({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: reason } }); await tick();
  };
  const send = (event: unknown) => driver.handleCallerLine(JSON.stringify(event));
  return { driver, events, commands, children, landing, code, tick, line, last, reply, update, ready, complete, send,
    user: () => send({ type: "user", text: "exact\ntext" }),
    end: async () => { driver.handleCallerEnd(); await tick(); const result = await code; driver.dispose(); return result; },
  };
}

describe("Cline session carriers", () => {
  test.each(["end_turn", "cancelled"])("a clean exit during history preserves native %s", async (reason) => { // allow-british: native ACP enum
    const delayed = Promise.withResolvers<typeof usage>();
    const h = rig({ readUsage: () => delayed.promise });
    try {
      h.user(); await h.tick(); await h.ready(); await h.complete(reason);
      h.children[0]!.exit(0); await h.tick();
      expect(h.events.find((event) => event.type === "turn_completed")?.finish).toBe(reason === "end_turn" ? "end" : "failed");
      const count = h.events.length;
      delayed.resolve(usage); await h.tick();
      expect(h.events).toHaveLength(count);
      expect(await h.end()).toBe(0);
    } finally { delayed.resolve(usage); h.children.forEach((child) => child.exit(0)); h.driver.handleCallerEnd(); await h.code; h.driver.dispose(); }
  });
  test.each(["before", "after"])("a delayed %s history read cannot mutate the next turn", async (phase) => {
    const delayed = Promise.withResolvers<typeof usage>();
    let reads = 0;
    const h = rig({ resumeSessionId: phase === "before" ? id : null,
      readUsage: () => ++reads === 1 ? delayed.promise : Promise.resolve(usage) });
    try {
      h.user(); await h.tick();
      if (phase === "before") {
        await h.reply({ protocolVersion: 1 }); await h.reply({}); await h.reply({}); await h.reply({});
      } else { await h.ready(); await h.complete(); }
      const oldWrites = h.children[0]!.wrote.length;
      h.children[0]!.exit(1); await h.tick();
      h.user(); await h.tick(); await h.ready(true);
      delayed.resolve({ ...usage, total_tokens: 999 }); await h.tick();
      expect(h.children[0]!.wrote).toHaveLength(oldWrites);
      await h.complete();
      const turns = h.events.filter((e) => e.type === "turn_completed");
      expect(turns).toHaveLength(2);
      expect(turns[1]).toMatchObject({ finish: "end", usage: { total_tokens: 0 } });
      expect(h.events.filter((e) => e.type === "assistant_message").map((e) => e.text)).toEqual(["answer"]);
      expect(await h.end()).toBe(1);
    } finally { delayed.resolve(usage); h.children.forEach((child) => child.exit(0)); h.driver.handleCallerEnd(); await h.code; h.driver.dispose(); }
  });
  test("protocol preserves original ACP frames and object-valued tool inputs", async () => {
    const h = rig(); h.user(); await h.tick(); await h.ready();
    try {
      for (const input of [undefined, null, [], "bad", { path: "a" }]) {
        const update = { sessionUpdate: "tool_call", toolCallId: "tool", title: "read", rawInput: input };
        const raw = ` { "jsonrpc":"2.0", "method":"ignored", "method":"session/update", "params": { "sessionId":"${id}", "update":${JSON.stringify(update)} } } `;
        h.driver.handleHarnessLine(raw); await h.tick();
        const event = h.events.filter((e) => e.type === "tool_call").at(-1)!;
        expect(event).toBeDefined(); expect(event.raw).toBe(raw);
        expect(event.input).toEqual(input && !Array.isArray(input) && typeof input === "object" ? input : {});
      }
      await h.complete(); expect(await h.end()).toBe(0);
      assertSessionConformance(h.events);
    } finally { h.children[0]!.exit(0); h.driver.handleCallerEnd(); await h.code; h.driver.dispose(); }
  });
  test("command uses ACP/local backend and no headless id or private prompt", () => {
    expect(buildClineSessionCommand({ home: "/private" })).toEqual(["env", "CLINE_SESSION_BACKEND_MODE=local", "cline", "--acp", "--auto-approve", "false", "--config", "/private/.cline"]);
    expect(buildClineSessionCommand({ effort: "high" }).slice(-2)).toEqual(["--thinking", "high"]);
    expect(clineSessionCapabilities()).toMatchObject({ interrupt: true, resume: true, permissions: false, usage_stream: false });
    expect(CLINE_SESSION_ID_PATTERN.test(id)).toBe(true); expect(CLINE_SESSION_ID_PATTERN.test("../oops")).toBe(false);
    expect(CLINE_ACP_DRIVER_PROFILE.buildTurnCommand({ hermeticHome: null } as any)).toContain("--acp");
    expect(CLINE_ACP_DRIVER_PROFILE.parseStreamLine!("", "")).toEqual({ kind: "unknown" });
  });

  test("native new/load, exact model, chunks, tools, history deltas and configured-only model", async () => {
    let reads = 0;
    const h = rig({ readUsage: async () => ({ ...usage, total_tokens: ++reads === 3 ? 22 : 11 }) });
    h.user(); await h.tick(); await h.ready(); expect(h.last().params.prompt).toEqual([{ type: "text", text: "exact\ntext" }]);
    h.update({ sessionUpdate: "tool_call", toolCallId: "tool", title: "read_files", rawInput: { file: "a" } });
    h.update({ sessionUpdate: "tool_call_update", toolCallId: "tool", status: "failed", content: ["denied"] });
    h.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private reasoning" } });
    await h.complete(); h.user(); await h.tick(); await h.ready(true); await h.complete();
    expect(h.events.filter((e) => e.type === "assistant_message").map((e) => e.text)).toEqual(["answer", "answer"]);
    expect(h.events.find((e) => e.type === "tool_call")?.name).toBe("read_files");
    expect(h.events.find((e) => e.type === "tool_result")?.is_error).toBe(true);
    expect(h.events.filter((e) => e.type === "turn_completed").map((e) => e.usage.total_tokens)).toEqual([11, 11]);
    expect(h.events.find((e) => e.type === "session_started")?.model_served).toBeNull();
    expect(h.commands.flat()).not.toContain("--id"); expect(await h.end()).toBe(0);
  });

  test("queued interrupt sends one native cancel and next turn remains usable", async () => {
    const h = rig({ delayed: true }); h.user(); h.send({ type: "interrupt" }); h.landing.resolve();
    await h.tick();
    // ready() sees the cancel notification last; finish the handshake explicitly.
    await h.reply({ protocolVersion: 1 }); await h.reply({ sessionId: id }); await h.reply({}); await h.reply({});
    h.send({ type: "interrupt" });
    expect(h.children[0]!.wrote.filter((wire) => wire.includes('"method":"session/cancel"'))).toHaveLength(1);
    await h.complete("cancelled", null); // allow-british: native ACP enum
    expect(h.events.find((e) => e.type === "turn_completed")?.finish).toBe("interrupted");
    h.user(); await h.tick(); await h.ready(true); await h.complete(); expect(await h.end()).toBe(0);
  });

  test("tools-none remains active on fresh and resumed turns and refuses unexpected calls", async () => {
    const h = rig({ tools: "none" });
    h.user(); await h.tick(); await h.ready(); await h.complete();
    h.user(); await h.tick(); await h.ready(true);
    h.update({ sessionUpdate: "tool_call", toolCallId: "unexpected", title: "run_commands" });
    await h.tick();
    expect(h.events.some((event) => event.type === "error" && String(event.message).includes("despite --tools none"))).toBe(true);
    expect(await h.end()).toBe(1);
  });

  test("all permissions are rejected while native automatic approval is false", async () => {
    const h = rig(); h.user(); await h.tick(); await h.ready();
    h.line({ jsonrpc: "2.0", id: 80, method: "session/request_permission", params: {
      sessionId: id, toolCall: { toolCallId: "t" }, options: [
        { optionId: "always", kind: "allow_always" }, { optionId: "reject", kind: "reject_once" }],
    } }); await h.tick();
    expect(h.last()).toEqual({ jsonrpc: "2.0", id: 80, result: { outcome: { outcome: "selected", optionId: "reject" } } });
    await h.complete(); expect(await h.end()).toBe(0);
  });

  test("medium and high autonomy honor explicit permission denial on fresh and resumed turns", async () => {
    for (const autonomy of ["read-only", "low", "medium", "high"] as const) {
      for (const permissionPolicy of ["default", "deny"] as const) {
        const h = rig({ autonomy, permissionPolicy });
        for (const resumed of [false, true]) {
          h.user(); await h.tick(); await h.ready(resumed); await h.complete();
          const command = h.commands.at(-1)!;
          expect(command[command.indexOf("--auto-approve") + 1]).toBe(String(
            permissionPolicy === "default" && (autonomy === "medium" || autonomy === "high")));
        }
        expect(await h.end()).toBe(0);
      }
    }
  });

  test("native ACP rawOutput preserves successful and failed tool results", async () => {
    const h = rig(); h.user(); await h.tick(); await h.ready();
    h.update({ sessionUpdate: "tool_call_update", toolCallId: "read", status: "completed", rawOutput: { content: "file bytes" } });
    h.update({ sessionUpdate: "tool_call_update", toolCallId: "write", status: "failed", rawOutput: "native denial" });
    await h.tick();
    expect(h.events.filter((event) => event.type === "tool_result").map((event) => [event.output, event.is_error]))
      .toEqual([[{ content: "file bytes" }, false], ["native denial", true]]);
    await h.complete(); expect(await h.end()).toBe(0);
  });

  test("resume retains state, plan mode and final removes the same private home", async () => {
    let removed = 0;
    const home = { dir: "/private/session-home", resumed: true, settled: true, blockedPaths: [], settle() {}, remove() { removed++; return true; } };
    const h = rig({ resumeSessionId: id, hermetic: true, privateHome: home, final: true, autonomy: "read-only", model: undefined });
    h.user(); await h.tick(); await h.ready(true); await h.complete(); expect(await h.end()).toBe(0);
    expect(removed).toBe(1); expect(h.commands[0]).toContain("/private/session-home/.cline");
    expect(h.events.at(-1)?.resumable).toBe(false);
  });

  test("malformed inputs are refused, idle interrupt is a no-op, and missing usage stays unknown", async () => {
    const h = rig({ readUsage: async () => { throw new Error("history missing"); } });
    h.send({ type: "interrupt" }); await h.tick();
    h.send({ type: "interrupt", extra: true }); await h.tick();
    h.send(null); await h.tick(); h.driver.handleCallerLine("bad json"); await h.tick();
    expect(h.events.filter((e) => e.type === "input_rejected")).toHaveLength(3);
    expect(h.events.filter((e) => e.type === "input_accepted")).toHaveLength(1);
    h.user(); await h.tick(); await h.ready(); await h.complete();
    expect(h.events.find((e) => e.type === "turn_completed")?.usage).toEqual(emptyUsage());
    expect(h.events.some((e) => e.type === "error" && e.message.includes("usage"))).toBe(true);
    expect(await h.end()).toBe(0); h.send({ type: "interrupt" }); h.driver.handleHarnessLine("ignored");
  });

  test("JSON-expanded prompts are refused before acknowledgment or child launch", async () => {
    const h = rig({ authorPrefix: true });
    h.send({ type: "user", text: '"'.repeat(600_000), author: "author" });
    await h.tick();
    expect(h.events.find((e) => e.type === "input_rejected")).toMatchObject({ reason: "text_too_long" });
    expect(h.children).toHaveLength(0); expect(await h.end()).toBe(0);
  });

  test("unexpected cancellation and early native exit fail their turn", async () => {
    const h = rig(); h.user(); await h.tick(); await h.ready(); await h.complete("cancelled", null); // allow-british: native ACP enum
    expect(h.events.find((e) => e.type === "turn_completed")?.finish).toBe("failed"); expect(await h.end()).toBe(0);
    const early = rig(); early.user(); await early.tick(); await early.ready(); early.children[0]!.exit(0); await early.tick();
    expect(early.events.find((e) => e.type === "turn_completed")?.reason).toBe("Cline ACP exited without a prompt response");
    expect(await early.end()).toBe(0);
  });

  test("protocol and write failures end the shared process lifecycle", async () => {
    for (const failWrites of [true, false]) {
      const h = rig({ failWrites }); h.user(); await h.tick();
      if (!failWrites) { h.children[0]!.awaitEndAnswer = async () => {}; h.driver.handleHarnessLine("bad json"); }
      else h.children[0]!.awaitEndAnswer = async () => {};
      h.children[0]!.exit(1); expect(await h.code).toBe(1); h.driver.dispose();
    }
    const h = rig(); h.user(); await h.tick(); await h.reply({ protocolVersion: 1 }); await h.reply({ sessionId: "wrong" });
    h.children[0]!.exit(1); expect(await h.code).toBe(1); h.driver.dispose();
  });

  test("turn timeout cancels then ends an unresponsive child", async () => {
    const h = rig({ turnTimeoutMs: 5 }); h.user(); await h.tick(); await h.ready();
    h.children[0]!.awaitEndAnswer = async () => {};
    await Bun.sleep(7); expect(h.last().method).toBe("session/cancel"); await Bun.sleep(7);
    expect(await h.code).toBe(1); h.driver.dispose();
  });

  test("EOF during prompt drains the native answer before ending", async () => {
    const h = rig(); h.user(); await h.tick(); await h.ready(); h.driver.handleCallerEnd();
    await h.complete(); expect(await h.code).toBe(0); h.driver.dispose();
    expect(h.events.find((e) => e.type === "turn_completed")?.finish).toBe("end");
  });
});

describe("Cline cumulative history usage", () => {
  const row = { sessionId: id, cwd: "/work", metadata: { aggregateUsage: { inputTokens: 8, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1, totalCost: 0.25 } } };
  test("inclusive input is split once and aggregate cost is preserved", () => {
    expect(parseClineHistoryUsage(JSON.stringify([row]), id, "/work")).toEqual(usage);
    expect(clineTurnUsage(freshClineUsage(), usage)).toEqual(usage);
    expect(clineTurnUsage(usage, usage)).toEqual(freshClineUsage());
    expect(clineTurnUsage(null, usage)).toEqual(emptyUsage());
    expect(clineTurnUsage(usage, null)).toEqual(emptyUsage());
    expect(clineTurnUsage(usage, { ...usage, total_tokens: 1 }).total_tokens).toBeNull();
  });
  test("malformed, duplicate, foreign and incomplete evidence stays unknown", () => {
    for (const data of ["bad", "{}", "[]", JSON.stringify([row, row]), JSON.stringify([{ ...row, cwd: "/foreign" }]),
      JSON.stringify([{ ...row, isSubagent: true }]), JSON.stringify([{ ...row, metadata: [] }]),
      JSON.stringify([{ ...row, metadata: {} }]), " ".repeat(16 * 1024 * 1024 + 1), JSON.stringify(Array(2001).fill(row))]) {
      expect(parseClineHistoryUsage(data, id, "/work")).toBeNull();
    }
    expect(parseClineHistoryUsage(JSON.stringify([{ ...row, metadata: { usage: { inputTokens: 8, outputTokens: 3 } } }]), id, "/work"))
      .toMatchObject({ total_tokens: 11, input_tokens: null, cached_input_tokens: null, cost_usd: null });
  });
});
