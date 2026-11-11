import { describe, expect, spyOn, test } from "bun:test";
import { GeminiAcpTransport } from "../src/session/gemini-acp.js";
import { GEMINI_ACP_DRIVER_PROFILE, GeminiAcpSessionDriver, geminiAcpUsage } from "../src/session/gemini-acp-driver.js";
import type { TurnAgentDriverOptions } from "../src/session/turn-driver-types.js";
import { fakeTurnProcess, type FakeTurnProcess } from "./helpers/session-turn-engine.js";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertSessionConformance } from "./helpers/session-conformance.js";

const geminiAcpId = "11111111-1111-4111-8111-111111111111";
function geminiAcpHarness(options: Partial<TurnAgentDriverOptions> & { turnTimeoutMs?: number; delayed?: boolean; failWrites?: boolean } = {}) {
  const events: Record<string, any>[] = [];
  const commands: string[][] = [];
  const children: FakeTurnProcess[] = [];
  const landing = Promise.withResolvers<void>();
  const driver = new GeminiAcpSessionDriver({
    profile: GEMINI_ACP_DRIVER_PROFILE, resumeSessionId: null, autonomy: "low", model: "synthetic",
    cwd: process.cwd(), hermetic: false, sandboxed: false, sandboxTrust: "standard",
    sandboxNoNet: false, sandboxScrubEnv: false, passEnv: [], authorPrefix: false,
    sessionTimeoutMs: null, registryPath: null, harnessHome: "/synthetic/gemini", providerBaseUrl: null,
    privateHome: null, final: false, permissionPolicy: "deny", ...options,
    spawnTurn: async (build) => {
      commands.push(build({}));
      if (options.delayed) await landing.promise;
      const child = fakeTurnProcess(); child.failWrites = options.failWrites ?? false;
      child.endInput = () => child.exit(0); child.requestStop = () => child.exit(0);
      children.push(child); return child;
    },
    sink: (line) => { events.push(JSON.parse(line)); },
  });
  const code = driver.run();
  const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
  const line = (event: unknown) => driver.handleHarnessLine(JSON.stringify(event));
  const last = () => JSON.parse(children.at(-1)!.wrote.at(-1)!);
  const reply = (result: unknown) => line({ jsonrpc: "2.0", id: last().id, result });
  const ready = async (resumed = false) => {
    expect(last().method).toBe("initialize"); reply({ protocolVersion: 1 }); await tick();
    expect(last().method).toBe(resumed ? "session/load" : "session/new");
    if (resumed) line({ jsonrpc: "2.0", method: "session/update", params: { sessionId: geminiAcpId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old replay" } } } });
    reply(resumed ? {} : { sessionId: geminiAcpId }); await tick();
  };
  const complete = async (reason = "end_turn") => {
    const prompt = children.at(-1)!.wrote.map((wire) => JSON.parse(wire)).find((frame) => frame.method === "session/prompt");
    line({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: reason, _meta: { quota: { token_count: { input_tokens: 8, output_tokens: 3 } } } } });
    await tick();
  };
  const send = (event: unknown) => driver.handleCallerLine(JSON.stringify(event));
  const update = (value: unknown) => line({ jsonrpc: "2.0", method: "session/update", params: { sessionId: geminiAcpId, update: value } });
  return { driver, events, commands, children, landing, code, tick, line, last, reply, ready, complete, send, update,
    user: () => send({ type: "user", text: "exact\ntext" }),
    end: async () => { driver.handleCallerEnd(); await tick(); const exit = await code; driver.dispose(); return exit; },
  };
}

describe("Gemini ACP uses the shared session lifecycle", () => {
  test.each(["initialize", "open", "prompt"] as const)("stale %s continuation cannot act on a later turn", async (method) => {
    const delayed = Promise.withResolvers<any>();
    const original = GeminiAcpTransport.prototype[method];
    let calls = 0;
    const spy = spyOn(GeminiAcpTransport.prototype, method).mockImplementation(function (this: GeminiAcpTransport, ...args: any[]) {
      return ++calls === 1 ? delayed.promise : (original as any).apply(this, args);
    });
    const h = geminiAcpHarness({ resumeSessionId: geminiAcpId });
    try {
      h.user(); await h.tick();
      if (method === "open") { h.reply({ protocolVersion: 1 }); await h.tick(); }
      if (method === "prompt") await h.ready(true);
      const old = h.children[0]!, writes = old.wrote.length;
      old.exit(0); await h.tick();
      h.user(); await h.tick(); await h.ready(true);
      h.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "next answer" } });
      delayed.resolve(method === "open" ? "22222222-2222-4222-8222-222222222222" : method === "prompt" ? { stopReason: "max_tokens" } : undefined);
      await h.tick();
      expect(old.wrote).toHaveLength(writes);
      expect(h.events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
      expect(h.events.filter((event) => event.type === "assistant_message")).toHaveLength(0);
      await h.complete();
      expect(h.events.filter((event) => event.type === "turn_completed").at(-1)?.finish).toBe("end");
      expect(h.events.filter((event) => event.type === "turn_completed").at(-1)?.session_id).toBe(geminiAcpId);
      await h.end();
    } finally { spy.mockRestore(); delayed.resolve(undefined); h.children.forEach((child) => child.exit(0)); h.driver.handleCallerEnd(); await h.code; h.driver.dispose(); }
  });
  test("protocol preserves original ACP frames and object-valued tool inputs", async () => {
    const h = geminiAcpHarness(); h.user(); await h.tick(); await h.ready();
    try {
      for (const input of [undefined, null, [], "bad", { path: "a" }]) {
        const update = { sessionUpdate: "tool_call", toolCallId: "tool", title: "read", rawInput: input };
        const raw = ` { "jsonrpc":"2.0", "method":"ignored", "method":"session/update", "params": { "sessionId":"${geminiAcpId}", "update":${JSON.stringify(update)} } } `;
        h.driver.handleHarnessLine(raw); await h.tick();
        const event = h.events.filter((e) => e.type === "tool_call").at(-1)!;
        expect(event).toBeDefined(); expect(event.raw).toBe(raw);
        expect(event.input).toEqual(input && !Array.isArray(input) && typeof input === "object" ? input : {});
      }
      await h.complete(); expect(await h.end()).toBe(0);
      assertSessionConformance(h.events);
    } finally { h.children[0]!.exit(0); h.driver.handleCallerEnd(); await h.code; h.driver.dispose(); }
  });
  for (const ending of ["eof", "shutdown"] as const) {
    for (const phase of ["initialize", "prompt"] as const) {
      test(`drains a successful answer after ${ending} during ${phase}`, async () => {
        const h = geminiAcpHarness(); h.user(); await h.tick();
        const child = h.children[0]!;
        child.awaitEndAnswer = async () => { await child.exited; };
        if (phase === "prompt") await h.ready();
        if (ending === "eof") h.driver.handleCallerEnd(); else h.send({ type: "shutdown" });
        try {
          if (phase === "initialize") await h.ready();
          h.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "drained answer" } });
          await h.complete();
          expect(h.events.find((e) => e.type === "assistant_message")?.text).toBe("drained answer");
          expect(h.events.find((e) => e.type === "turn_completed")?.finish).toBe("end");
          expect(await h.code).toBe(0);
        } finally { child.exit(0); await h.code; h.driver.dispose(); }
      });
    }
  }

  test.each(["x", "\u0001", "é"])("rejects an oversized serialized ACP prompt and accepts the next message: %j", async (character) => {
    const h = geminiAcpHarness({ authorPrefix: true });
    try {
      h.send({ type: "user", text: character.repeat(1024 * 1024), author: "writer" }); await h.tick();
      expect(h.events.find((e) => e.type === "input_rejected")).toMatchObject({ reason: "text_too_long" });
      expect(h.children).toHaveLength(0);
      h.user(); await h.tick(); await h.ready(); await h.complete();
      expect(await h.end()).toBe(0);
    } finally { for (const child of h.children) child.exit(0); h.driver.handleCallerEnd(); await h.code; h.driver.dispose(); }
  });

  test("native new/load identities, deltas, tools, and truthful usage survive two turns", async () => {
    const h = geminiAcpHarness(); h.user(); await h.tick(); await h.ready();
    expect(h.commands[0]).toContain("--acp");
    expect(h.commands[0]).not.toContain("-p");
    expect(h.last().params.prompt).toEqual([{ type: "text", text: "exact\ntext" }]);
    h.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } });
    h.update({ sessionUpdate: "tool_call", toolCallId: "tool", title: "read_file", rawInput: { path: "a" } });
    h.update({ sessionUpdate: "tool_call_update", toolCallId: "tool", status: "completed", content: ["output"] });
    h.update({ sessionUpdate: "available_commands_update" });
    await h.complete();
    expect(h.events.find((e) => e.type === "session_started")?.session_id).toBe(geminiAcpId);
    expect(h.events.find((e) => e.type === "assistant_delta")?.delta).toBe("answer");
    expect(h.events.find((e) => e.type === "tool_call")?.name).toBe("read_file");
    expect(h.events.find((e) => e.type === "tool_result")?.is_error).toBe(false);
    expect(h.events.find((e) => e.type === "turn_completed")).toMatchObject({ finish: "end", usage: { total_tokens: 11, output_tokens: 3, input_tokens: null, cached_input_tokens: null } });
    h.user(); await h.tick(); await h.ready(true); await h.complete();
    expect(h.events.filter((e) => e.type === "assistant_delta")).toHaveLength(1);
    expect(h.events.filter((e) => e.type === "turn_completed")).toHaveLength(2);
    expect(await h.end()).toBe(0);
    h.driver.handleHarnessLine("ignored after settlement");
  });

  test("interrupt queued before spawn reaches one native cancel and leaves the session reusable", async () => {
    const h = geminiAcpHarness({ delayed: true }); h.user(); h.send({ type: "interrupt" });
    h.landing.resolve(); await h.tick(); await h.ready();
    h.send({ type: "interrupt" });
    expect(h.children[0]!.wrote.filter((wire) => wire.includes('"method":"session/cancel"'))).toHaveLength(1);
    await h.complete("cancelled"); // allow-british: native ACP enum
    expect(h.events.find((e) => e.type === "turn_completed")).toMatchObject({ finish: "interrupted",
      model_served: null, model_served_source: null, model_alias: null });
    h.user(); await h.tick(); await h.ready(true);
    h.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "next answer" } });
    await h.complete();
    expect(h.events.filter((e) => e.type === "turn_completed").map((e) => e.finish)).toEqual(["interrupted", "end"]);
    expect(await h.end()).toBe(0);
  });

  test("native permission is refused even before cancellation and permanent approval is never selected", async () => {
    const h = geminiAcpHarness(); h.user(); await h.tick(); await h.ready();
    h.line({ jsonrpc: "2.0", id: 80, method: "session/request_permission", params: {
      sessionId: geminiAcpId, toolCall: { toolCallId: "t" }, options: [
        { optionId: "yes", kind: "allow_always" }, { optionId: "no", kind: "reject_once" },
      ],
    } }); await h.tick();
    expect(h.last()).toEqual({ jsonrpc: "2.0", id: 80, result: { outcome: { outcome: "selected", optionId: "no" } } });
    await h.complete(); expect(await h.end()).toBe(0);
  });

  test("resume restores native state and final removes the settled private home", async () => {
    let removed = 0; let settled = 0;
    const home = { dir: "/synthetic/gemini/session-home", resumed: true, settled: true, blockedPaths: [],
      settle: () => { settled++; }, remove: () => { removed++; return true; } };
    const h = geminiAcpHarness({ resumeSessionId: geminiAcpId, hermetic: true, final: true, privateHome: home });
    h.user(); await h.tick(); await h.ready(true); await h.complete();
    expect(h.commands[0]).toContain(`GEMINI_CLI_HOME=${home.dir}`);
    expect(await h.end()).toBe(0); expect(removed).toBe(1); expect(settled).toBe(0);
  });

  test("idle interrupts are no-ops, malformed inputs are rejected, and settled input emits nothing", async () => {
    const h = geminiAcpHarness(); h.send({ type: "interrupt" }); h.send({ type: "interrupt", extra: true });
    h.driver.handleCallerLine("not json"); h.send(null); await h.tick();
    expect(h.events.filter((e) => e.type === "input_accepted" || e.type === "input_rejected").map((e) => e.type))
      .toEqual(["input_accepted", "input_rejected", "input_rejected", "input_rejected"]);
    expect(h.children).toHaveLength(0);
    expect(await h.end()).toBe(0);
    const count = h.events.length; h.send({ type: "interrupt" });
    await h.tick(); expect(h.events).toHaveLength(count);
  });

  test("cancellation racing an ordinary answer does not invent interrupted completion", async () => {
    const h = geminiAcpHarness(); h.user(); await h.tick(); await h.ready(); h.send({ type: "interrupt" });
    h.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ordinary answer" } });
    await h.complete(); expect(h.events.find((e) => e.type === "turn_completed")?.finish).toBe("end");
    expect(await h.end()).toBe(0);
    const failed = geminiAcpHarness(); failed.user(); await failed.tick(); await failed.ready(); await failed.complete("cancelled"); // allow-british: native ACP enum
    expect(failed.events.find((e) => e.type === "turn_completed")?.finish).toBe("failed"); expect(await failed.end()).toBe(0);
  });

  test("protocol, initial write, and cancel write failures end the process lifecycle", async () => {
    const malformed = geminiAcpHarness(); malformed.user(); await malformed.tick(); malformed.driver.handleHarnessLine("bad json");
    expect(await malformed.code).toBe(1); malformed.driver.dispose();
    const write = geminiAcpHarness({ failWrites: true }); write.user(); await write.tick();
    expect(await write.code).toBe(1); write.driver.dispose();
    const cancel = geminiAcpHarness(); cancel.user(); await cancel.tick(); await cancel.ready();
    cancel.children[0]!.failWrites = true; cancel.send({ type: "interrupt" });
    expect(await cancel.code).toBe(1); cancel.driver.dispose();
  });

  test("EOF without a prompt response fails the turn", async () => {
    const h = geminiAcpHarness(); h.user(); await h.tick(); await h.ready(); h.children[0]!.exit(0); await h.tick();
    expect(h.events.find((e) => e.type === "turn_completed")).toMatchObject({ finish: "failed", reason: "Gemini ACP exited without a prompt response" });
    expect(await h.end()).toBe(0);
  });

  test("turn timeout sends cancel and escalates if the native response never arrives", async () => {
    const h = geminiAcpHarness({ turnTimeoutMs: 5 }); h.user(); await h.tick(); await h.ready();
    await Bun.sleep(7); expect(h.last().method).toBe("session/cancel");
    await Bun.sleep(7); expect(await h.code).toBe(1); h.driver.dispose();
  });

  test("usage rejects absent, negative, fractional, and overflowing native counts", () => {
    expect(geminiAcpUsage({}).total_tokens).toBeNull();
    for (const input of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
      const usage = geminiAcpUsage({ _meta: { quota: { token_count: { input_tokens: input, output_tokens: 3 } } } });
      expect(usage.total_tokens).toBeNull(); expect(usage.input_tokens).toBeNull();
    }
  });

  test("ACP restores the S1 input/cache split from the native identity-checked transcript", async () => {
    const root = mkdtempSync(join(tmpdir(), "gemini-acp-driver-"));
    const cwd = join(root, "work"); const home = join(root, ".gemini");
    const chats = join(home, "tmp", "work", "chats"); mkdirSync(chats, { recursive: true });
    writeFileSync(join(home, "projects.json"), JSON.stringify({ projects: { [cwd]: "work" } }));
    const transcript = join(chats, `session-today-${geminiAcpId.slice(0, 8)}.jsonl`);
    writeFileSync(transcript, JSON.stringify({ sessionId: geminiAcpId, projectHash: createHash("sha256").update(cwd).digest("hex") }) + "\n");
    try {
      const h = geminiAcpHarness({ cwd, harnessHome: home }); h.user(); await h.tick(); await h.ready();
      appendFileSync(transcript, JSON.stringify({ id: "assistant", type: "gemini", tokens: { input: 8, output: 3, cached: 2 } }) + "\n");
      await h.complete();
      expect(h.events.find((e) => e.type === "turn_completed")?.usage).toEqual({ input_tokens: 6, output_tokens: 3, cached_input_tokens: 2, total_tokens: 11, cost_usd: null });
      expect(h.events.some((e) => e.type === "error")).toBe(false); expect(await h.end()).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
