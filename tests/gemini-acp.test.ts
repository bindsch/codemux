import { describe, expect, test } from "bun:test";
import { buildGeminiAcpCommand, GeminiAcpTransport, MAX_GEMINI_ACP_LINE_BYTES, type GeminiAcpHost } from "../src/session/gemini-acp.js";

type Frame = Record<string, any>;
const geminiSessionId = "aba628da-08e0-49ac-ab38-59deaf6fed52";
const geminiOptions = [
  { optionId: "remember", kind: "allow_always" },
  { optionId: "once", kind: "allow_once" },
  { optionId: "no", kind: "reject_once" },
];

function geminiFixture(options: Partial<GeminiAcpHost> = {}) {
  const sent: Frame[] = [];
  const updates: Frame[] = [];
  const errors: Error[] = [];
  const transport = new GeminiAcpTransport({
    ...options,
    write(line) { sent.push(JSON.parse(line)); return options.write?.(line) ?? true; },
    onUpdate(update) { updates.push(update); },
    onFailure(error) { errors.push(error); },
  });
  const receive = (frame: Frame) => transport.handleLine(JSON.stringify({ jsonrpc: "2.0", ...frame }));
  const reply = (result: unknown) => receive({ id: sent.at(-1)!.id, result });
  const permission = (id: number, overrides: Frame = {}) => receive({
    id, method: "session/request_permission",
    params: { sessionId: geminiSessionId, toolCall: { toolCallId: "tool-1", kind: "execute" }, options: geminiOptions, ...overrides },
  });
  return { sent, updates, errors, transport, receive, reply, permission };
}

async function geminiReady(options: Partial<GeminiAcpHost> = {}, resume = false) {
  const fixture = geminiFixture(options);
  const initialized = fixture.transport.initialize();
  fixture.reply({ protocolVersion: 1 });
  await initialized;
  const opened = fixture.transport.open({ cwd: "/project", ...(resume ? { resumeId: geminiSessionId } : {}) });
  fixture.reply(resume ? {} : { sessionId: geminiSessionId });
  await opened;
  return fixture;
}

describe("Gemini native ACP transport", () => {
  test("builds private native command with model, policy, and autonomy", () => {
    expect(buildGeminiAcpCommand({ autonomy: "low" })).toEqual(["gemini", "--sandbox=false", "--acp", "--approval-mode", "default"]);
    expect(buildGeminiAcpCommand({ autonomy: "high", home: "/private", model: "m", policyPath: "/policy" }))
      .toEqual(["env", "GEMINI_CLI_HOME=/private", "gemini", "--sandbox=false", "--acp", "--approval-mode", "yolo", "-m", "m", "--policy", "/policy"]);
  });

  test("initializes, authenticates, buffers new-session updates, and sends exact text", async () => {
    const f = geminiFixture();
    await expect(f.transport.prompt("early")).rejects.toThrow("not initialized");
    const init = f.transport.initialize();
    expect(f.sent[0]).toMatchObject({ method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await expect(f.transport.initialize()).rejects.toThrow("already initialized");
    f.reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    await init;
    await expect(f.transport.prompt("early")).rejects.toThrow("not ready");
    const auth = f.transport.authenticate("gemini-api-key", { "api-key": "synthetic" });
    expect(f.sent.at(-1)).toMatchObject({ method: "authenticate", params: { methodId: "gemini-api-key", _meta: { "api-key": "synthetic" } } });
    f.reply({}); await auth;
    const opened = f.transport.open({ cwd: "/project", mcpServers: [{ name: "fixture", command: "/fixture", args: [], env: [] }] });
    f.receive({ method: "session/update", params: { sessionId: geminiSessionId, update: { sessionUpdate: "current_mode_update", currentModeId: "default" } } });
    expect(f.updates).toHaveLength(0);
    f.reply({ sessionId: geminiSessionId });
    expect(await opened).toBe(geminiSessionId);
    expect(f.transport.sessionId).toBe(geminiSessionId);
    expect(f.updates).toHaveLength(1);
    await expect(f.transport.open({ cwd: "/other" })).rejects.toThrow("already owns");
    const prompt = f.transport.prompt("exact\nUnicode λ");
    expect(f.sent.at(-1)).toMatchObject({ method: "session/prompt", params: { sessionId: geminiSessionId, prompt: [{ type: "text", text: "exact\nUnicode λ" }] } });
    await expect(f.transport.prompt("overlap")).rejects.toThrow("active prompt");
    f.receive({ method: "session/update", params: { sessionId: geminiSessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } } });
    f.reply({ stopReason: "end_turn" });
    expect(await prompt).toEqual({ stopReason: "end_turn" });
    expect(f.updates.at(-1)?.content.text).toBe("answer");
    expect(f.transport.cancel()).toBe(false);
  });

  test("resumes the requested native identity and streams replay before the load response", async () => {
    const f = geminiFixture();
    const init = f.transport.initialize(); f.reply({ protocolVersion: 1 }); await init;
    await expect(f.transport.open({ cwd: "/project", resumeId: "../invalid" })).rejects.toThrow("invalid session");
    const loaded = f.transport.open({ cwd: "/project", resumeId: geminiSessionId });
    expect(f.sent.at(-1)).toMatchObject({ method: "session/load", params: { sessionId: geminiSessionId, cwd: "/project", mcpServers: [] } });
    f.receive({ method: "session/update", params: { sessionId: geminiSessionId, update: { sessionUpdate: "user_message_chunk" } } });
    expect(f.updates).toHaveLength(1);
    f.reply({ modes: {} });
    expect(await loaded).toBe(geminiSessionId);
  });

  test("cancel is one notification and denies a pending permission even if its callback allows", async () => {
    let decide!: (choice: "allow" | "deny") => void;
    const f = await geminiReady({ onPermission: () => new Promise((resolve) => { decide = resolve; }) });
    const prompt = f.transport.prompt("work");
    const promptId = f.sent.at(-1)!.id;
    f.permission(90);
    expect(f.transport.cancel()).toBe(true);
    expect(f.transport.cancel()).toBe(false);
    expect(f.sent.at(-1)).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: geminiSessionId } });
    decide("allow"); await Promise.resolve();
    expect(f.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 90, result: { outcome: { outcome: "selected", optionId: "no" } } });
    f.receive({ id: promptId, result: { stopReason: "cancelled" } }); // allow-british: native ACP enum
    expect(await prompt).toEqual({ stopReason: "cancelled" }); // allow-british: native ACP enum
  });

  test("denies by policy or callback failure and selects only a single-use grant", async () => {
    for (const mode of ["deny", "allow", "throw", "default"] as const) {
      let callbacks = 0;
      const f = await geminiReady({ permissionPolicy: mode === "deny" ? "deny" : "default", ...(mode === "default" ? {} : {
        onPermission: () => { callbacks++; if (mode === "throw") throw new Error("no decision"); return "allow" as const; },
      }) });
      const prompt = f.transport.prompt("work"); const promptId = f.sent.at(-1)!.id;
      f.permission(91); await Promise.resolve();
      expect(f.sent.at(-1)?.result.outcome).toEqual({ outcome: "selected", optionId: mode === "allow" ? "once" : "no" });
      expect(callbacks).toBe(mode === "deny" || mode === "default" ? 0 : 1);
      f.receive({ id: promptId, result: { stopReason: "end_turn" } }); await prompt;
    }
  });

  test("late approval cannot cross the turn boundary", async () => {
    let decide!: (choice: "allow" | "deny") => void;
    const f = await geminiReady({ onPermission: () => new Promise((resolve) => { decide = resolve; }) });
    const first = f.transport.prompt("first"); const firstId = f.sent.at(-1)!.id;
    f.permission(92);
    f.receive({ id: firstId, result: { stopReason: "end_turn" } }); await first;
    const next = f.transport.prompt("next"); const nextId = f.sent.at(-1)!.id;
    decide("allow"); await Promise.resolve();
    expect(f.sent.at(-1)?.result.outcome.optionId).toBe("no");
    f.receive({ id: nextId, result: { stopReason: "end_turn" } }); await next;
  });

  test("malformed, foreign, inactive, and unsupported permission choices never grant", async () => {
    const f = await geminiReady({ onPermission: () => "allow" });
    f.permission(93); await Promise.resolve();
    expect(f.sent.at(-1)?.result.outcome).toEqual({ outcome: "cancelled" }); // allow-british: native ACP enum
    const prompt = f.transport.prompt("work"); const promptId = f.sent.at(-1)!.id;
    for (const overrides of [{ sessionId: "foreign" }, { options: [null] }, { options: [{ kind: "allow_always", optionId: "forever" }] }]) {
      f.permission(94, overrides); await Promise.resolve();
      expect(f.sent.at(-1)?.result.outcome).toEqual({ outcome: "cancelled" }); // allow-british: native ACP enum
    }
    f.receive({ id: "fs-1", method: "fs/read_text_file", params: {} });
    expect(f.sent.at(-1)?.error.code).toBe(-32601);
    f.receive({ method: "future/notification", params: {} });
    f.receive({ id: promptId, result: { stopReason: "end_turn" } }); await prompt;
  });

  test("rejects malformed or oversized incoming frames and settles all pending requests", async () => {
    for (const wire of ["broken", "[]", '{"jsonrpc":"1.0"}', '{"jsonrpc":"2.0","id":999,"result":{}}', " ".repeat(MAX_GEMINI_ACP_LINE_BYTES) + "x"]) {
      const f = geminiFixture(); const init = f.transport.initialize();
      f.transport.handleLine(wire); await expect(init).rejects.toThrow();
      expect(f.errors).toHaveLength(1);
      f.transport.close(); f.transport.handleLine("broken");
      expect(f.errors).toHaveLength(1);
      await expect(f.transport.authenticate("key")).rejects.toThrow();
    }
  });

  test("checks protocol version, session identities, result objects, and prompt completion", async () => {
    const version = geminiFixture(); const init = version.transport.initialize(); version.reply({ protocolVersion: 2 });
    await expect(init).rejects.toThrow("protocol version");
    const missing = geminiFixture(); const missingInit = missing.transport.initialize(); missing.reply(null);
    await expect(missingInit).rejects.toThrow("result object");
    const f = await geminiReady(); const prompt = f.transport.prompt("work"); f.reply({});
    await expect(prompt).rejects.toThrow("stopReason");
    const wrong = geminiFixture(); const ready = wrong.transport.initialize(); wrong.reply({ protocolVersion: 1 }); await ready;
    const open = wrong.transport.open({ cwd: "/project" }); wrong.reply({ sessionId: "../foreign" });
    await expect(open).rejects.toThrow("valid session identity");
    const error = geminiFixture(); const failed = error.transport.initialize();
    error.receive({ id: error.sent.at(-1)!.id, error: { message: "native error" } });
    await expect(failed).rejects.toThrow("native error");
  });

  test("foreign updates and excessive pre-session updates fail closed", async () => {
    for (const params of [{ sessionId: "foreign", update: {} }, { sessionId: geminiSessionId }]) {
      const f = await geminiReady(); const prompt = f.transport.prompt("work");
      f.receive({ method: "session/update", params });
      await expect(prompt).rejects.toThrow(/foreign session|update object/);
    }
    const f = geminiFixture(); const init = f.transport.initialize(); f.reply({ protocolVersion: 1 }); await init;
    const open = f.transport.open({ cwd: "/project" });
    for (let i = 0; i < 65; i++) f.receive({ method: "session/update", params: { sessionId: geminiSessionId, update: {} } });
    await expect(open).rejects.toThrow("too many updates");
  });

  test("writer closure, cancel failure, and excessive prompt bytes reject pending work", async () => {
    const f = geminiFixture({ write: () => false });
    await expect(f.transport.initialize()).rejects.toThrow("input closed");
    let writable = true;
    const cancel = await geminiReady({ write: () => writable });
    const prompt = cancel.transport.prompt("work");
    writable = false;
    expect(() => cancel.transport.cancel()).toThrow("input closed"); await expect(prompt).rejects.toThrow("input closed");
    const large = await geminiReady();
    await expect(large.transport.prompt("x".repeat(MAX_GEMINI_ACP_LINE_BYTES))).rejects.toThrow("input frame exceeds");
  });

  test("duplicate permission identities close the transport without granting a late callback", async () => {
    let decide!: (choice: "allow" | "deny") => void;
    const f = await geminiReady({ onPermission: () => new Promise((resolve) => { decide = resolve; }) });
    const prompt = f.transport.prompt("work");
    f.permission(95); f.permission(95); await expect(prompt).rejects.toThrow("repeated a permission");
    const writes = f.sent.length;
    decide("allow"); await Promise.resolve();
    expect(f.sent).toHaveLength(writes);
  });

  test("bounds pending requests and permissions", async () => {
    const f = await geminiReady();
    const pending = Array.from({ length: 32 }, () => f.transport.authenticate("synthetic").catch((error: Error) => error.message));
    await expect(f.transport.authenticate("overflow")).rejects.toThrow("too many pending requests");
    f.transport.close();
    expect(await Promise.all(pending)).toHaveLength(32);
    const permissions = await geminiReady({ onPermission: () => new Promise(() => {}) });
    const prompt = permissions.transport.prompt("work");
    for (let i = 0; i < 33; i++) permissions.permission(100 + i);
    await expect(prompt).rejects.toThrow("too many pending permissions");
  });
});
