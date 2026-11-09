import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { CopilotAdapter } from "../src/adapters/copilot.js";
import { COPILOT_DRIVER_PROFILE } from "../src/session/copilot-driver.js";
import { CopilotRpcSessionDriver } from "../src/session/copilot-rpc-driver.js";
import { CopilotRpcFramer, encodeCopilotRpc } from "../src/session/copilot-rpc-framing.js";
import { buildCopilotRpcLaunch } from "../src/session/copilot-rpc-config.js";
import type { SessionPrivateHome } from "../src/session/private-home-types.js";
import type { RunRequest } from "../src/types.js";
import { fakeTurnProcess, type FakeTurnProcess } from "./helpers/session-turn-engine.js";

const copilotRpcDriverId = "11111111-1111-4111-8111-111111111111";
const copilotRpcMetrics = (tokens: number) => ({ modelMetrics: { served: { usage: {
  inputTokens: tokens, outputTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0,
} } } });

function copilotDriverFixture(options: { deny?: boolean; resume?: boolean; timeout?: number;
  failWrites?: boolean; home?: SessionPrivateHome; autonomy?: "read-only" | "low" | "medium" | "high" } = {}) {
  const events: Record<string, unknown>[] = [];
  const commands: string[][] = [];
  const children: FakeTurnProcess[] = [];
  const requests: Record<string, unknown>[] = [];
  const answered = new Set<string>();
  let tokens = 3;
  const adapter = new CopilotAdapter({});
  const driver = new CopilotRpcSessionDriver({
    profile: COPILOT_DRIVER_PROFILE, resumeSessionId: options.resume ? copilotRpcDriverId : null,
    mintedSessionId: copilotRpcDriverId, autonomy: options.autonomy ?? "high", model: "requested",
    cwd: tmpdir(), hermetic: options.home !== undefined, sandboxed: false, sandboxTrust: "standard",
    sandboxNoNet: false, sandboxScrubEnv: false, passEnv: [], authorPrefix: false,
    sessionTimeoutMs: null, registryPath: null, harnessHome: "/synthetic/copilot",
    turnTimeoutMs: options.timeout, rpcTimeoutMs: 1000, permissionPolicy: options.deny ? "deny" : "default",
    providerBaseUrl: null, privateHome: options.home ?? null, final: options.home !== undefined,
    adapter, request: { agent: "copilot", prompt: "", cwd: tmpdir(), hermetic: options.home !== undefined }, context: () => undefined,
    spawnTurn: async (build) => {
      commands.push(build({}));
      const child = fakeTurnProcess();
      child.failWrites = options.failWrites ?? false;
      child.endInput = () => { driver.handleHarnessEnd(); child.exit(0); };
      child.requestStop = () => child.exit(0);
      children.push(child);
      return child;
    },
    sink: (line) => { events.push(JSON.parse(line)); },
  });
  const code = driver.run();
  const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
  const native = (event: unknown, sessionId = copilotRpcDriverId) => driver.handleHarnessBytes(encodeCopilotRpc({
    jsonrpc: "2.0", method: "session.event", params: { sessionId, event },
  }));
  const respond = async () => {
    for (let pass = 0; pass < 12; pass++) {
      await tick();
      const child = children.at(-1);
      if (child === undefined) continue;
      for (const text of child.wrote) {
        const packet = new CopilotRpcFramer().push(Buffer.from(text))[0] as Record<string, unknown>;
        const key = `${children.length}:${String(packet.id)}`;
        if (answered.has(key)) continue;
        answered.add(key);
        requests.push(packet);
        const result = packet.method === "session.create" || packet.method === "session.resume"
          ? { sessionId: copilotRpcDriverId }
          : packet.method === "session.usage.getMetrics" ? copilotRpcMetrics(tokens)
          : packet.method === "session.mode.set" ? { status: "success", modeApplied: true }
          : { success: true, messageId: "message" };
        driver.handleHarnessBytes(encodeCopilotRpc({ jsonrpc: "2.0", id: packet.id, result }));
      }
    }
  };
  const send = (event: unknown) => driver.handleCallerLine(JSON.stringify(event));
  return { driver, events, commands, children, requests, native, respond, tick, send, code,
    user: () => send({ type: "user", text: "secret\nturn" }),
    complete: async (nextTokens = 5) => {
      tokens = nextTokens;
      native({ type: "assistant.message", data: { content: "answer", model: "served" } });
      native({ type: "session.idle" });
      await respond();
    },
    end: async () => { driver.handleCallerEnd(); await tick(); const result = await code; driver.dispose(); return result; },
  };
}

test("Copilot RPC driver retains the S1 turn lifecycle and subtracts resumed counters", async () => {
  const h = copilotDriverFixture();
  h.user(); await h.respond();
  expect(h.commands[0]).toEqual(["copilot", "--headless", "--stdio", "--no-auto-update",
    "--no-bash-env", "--no-remote", "--no-remote-export", "--no-custom-instructions", "--no-experimental"]);
  expect(h.commands[0]!.join(" ")).not.toContain("secret");
  expect(h.requests[0]).toMatchObject({ method: "session.create", params: { sessionId: copilotRpcDriverId } });
  expect(h.requests.find((request) => request.method === "session.send"))
    .toMatchObject({ params: { prompt: "secret\nturn" } });
  await h.complete(5);
  expect(h.events.find((event) => event.type === "turn_completed"))
    .toMatchObject({ finish: "end", usage: { total_tokens: 10 } });
  h.user(); await h.respond(); await h.complete(8);
  expect(h.requests.some((request) => request.method === "session.resume")).toBe(true);
  expect(h.events.filter((event) => event.type === "turn_completed")[1])
    .toMatchObject({ finish: "end", usage: { total_tokens: 6 } });
  expect(await h.end()).toBe(0);
  h.driver.handleHarnessBytes(encodeCopilotRpc({ invalid: true }));
});

test("Copilot RPC interruption queues before prompt ack and preserves the next turn", async () => {
  const h = copilotDriverFixture();
  h.user(); h.send({ type: "interrupt" }); h.send({ type: "interrupt" });
  await h.respond();
  expect(h.requests.filter((request) => request.method === "session.abort")).toHaveLength(1);
  h.native({ type: "abort", data: { reason: "user_initiated" } });
  await h.complete();
  expect(h.events.find((event) => event.type === "turn_completed")?.finish).toBe("interrupted");
  h.user(); await h.respond(); await h.complete(7);
  expect(h.events.filter((event) => event.type === "turn_completed").map((event) => event.finish))
    .toEqual(["interrupted", "end"]);
  expect(await h.end()).toBe(0);
});

test("Copilot RPC does not label a raced completion or foreign abort as caller interruption", async () => {
  for (const reason of [undefined, "remote_command"] as const) {
    const h = copilotDriverFixture();
    h.user(); await h.respond(); h.send({ type: "interrupt" }); await h.respond();
    if (reason !== undefined) h.native({ type: "abort", data: { reason } });
    await h.complete();
    expect(h.events.find((event) => event.type === "turn_completed")?.finish).toBe(reason === undefined ? "end" : "failed");
    expect(await h.end()).toBe(0);
  }
});

test("Copilot RPC deny rejects requests without removing tools or clearing remembered rules", async () => {
  const h = copilotDriverFixture({ deny: true, resume: true });
  h.user(); await h.respond();
  const resumed = h.requests.find((request) => request.method === "session.resume")!;
  expect(resumed).toMatchObject({ params: { availableTools: ["builtin:*", "mcp:*", "custom:*"], requestPermission: true } });
  // Deny applies when the native runtime asks. It does not erase native
  // remembered rules or remove already-allowed tools from discovery.
  expect(h.requests.some((request) => request.method === "session.permissions.resetSessionApprovals")).toBe(false);
  expect(h.requests.filter((request) => request.method === "session.permissions.configure").at(-1))
    .toMatchObject({ params: { approveAllToolPermissionRequests: false, approveAllReadPermissionRequests: false,
      paths: { unrestricted: false, additionalDirectories: [], includeTempDirectory: false },
      urls: { unrestricted: false, initialAllowed: [] } } });
  h.native({ type: "permission.requested", data: { requestId: "pending" } });
  await h.respond();
  expect(h.requests.find((request) => request.method === "session.permissions.handlePendingPermissionRequest"))
    .toMatchObject({ params: { result: { kind: "reject" } } });
  await h.complete();
  expect(await h.end()).toBe(0);
});

test("Copilot RPC read-only sets native plan mode; medium does not grant all read paths", async () => {
  for (const autonomy of ["read-only", "medium"] as const) {
    const h = copilotDriverFixture({ autonomy });
    h.user(); await h.respond();
    const policy = h.requests.find((request) => request.method === "session.permissions.configure")!;
    expect(policy).toMatchObject({ params: { approveAllToolPermissionRequests: autonomy === "medium",
      approveAllReadPermissionRequests: false, paths: { unrestricted: false } } });
    expect(h.requests.some((request) => request.method === "session.mode.set")).toBe(autonomy === "read-only");
    await h.complete(); expect(await h.end()).toBe(0);
  }
});

test("Copilot RPC keeps private-home finalization and rejects idle or malformed interrupts", async () => {
  let removed = false;
  const home = { dir: "/synthetic/private", settled: true, resumed: false,
    settle() {}, remove() { removed = true; return true; } } as unknown as SessionPrivateHome;
  const h = copilotDriverFixture({ home });
  h.send({ type: "interrupt" }); h.send({ type: "interrupt", extra: true });
  h.driver.handleCallerLine("not-json"); h.send(null);
  h.user(); await h.respond(); await h.complete();
  expect(h.requests[0]).toMatchObject({ params: { configDir: home.dir, enableConfigDiscovery: false } });
  expect(h.commands[0]).toContain(`COPILOT_HOME=${home.dir}`);
  expect(await h.end()).toBe(0);
  expect(removed).toBe(true);
  // Non-JSON input produces an error event; the three parsed invalid
  // inputs get rejection acknowledgments under the shared protocol.
  expect(h.events.filter((event) => event.type === "input_rejected")).toHaveLength(3);
  h.send({ type: "interrupt" });
});

test("Copilot RPC rejects wrong framing, failed writes, native errors and foreign sessions", async () => {
  for (const failure of ["framing", "write", "native", "foreign"] as const) {
    const h = copilotDriverFixture({ failWrites: failure === "write" });
    h.user(); await h.respond();
    if (failure === "framing") h.driver.handleHarnessLine("line-mode data");
    if (failure === "foreign") h.native({ type: "assistant.message" }, "foreign");
    if (failure === "native") { h.native({ type: "session.error", data: { message: "native failure" } }); await h.complete(); }
    expect(await h.end()).toBe(failure === "native" ? 0 : 1);
    if (failure === "native") expect(h.events.find((event) => event.type === "turn_completed")?.finish).toBe("failed");
  }
});

test("Copilot RPC turn timeout aborts, then ends an unresponsive child", async () => {
  const h = copilotDriverFixture({ timeout: 5 });
  h.user(); await h.respond();
  await Bun.sleep(7); await h.respond();
  expect(h.requests.some((request) => request.method === "session.abort")).toBe(true);
  expect(await h.code).toBe(1);
  h.driver.dispose();
});

test("Copilot RPC launch carries provider caps and restores source-qualified tools", () => {
  const adapter = new CopilotAdapter({ CODEMUX_COPILOT_PROVIDER_BASE_URL: "https://example.test/v1",
    CODEMUX_COPILOT_PROVIDER_MODEL: "native", CODEMUX_COPILOT_PROVIDER_API_KEY: "secret",
    CODEMUX_COPILOT_PROVIDER_MAX_CONTEXT_TOKENS: "2048", CODEMUX_COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: "1024" });
  const request: RunRequest = { agent: "copilot", prompt: "p", tools: "default", web: false };
  const turn = { text: "p", sessionId: copilotRpcDriverId, firstTurn: false, hermeticHome: null, autonomy: "high" as const };
  const built = buildCopilotRpcLaunch({ adapter, request, turn, context: {}, harnessHome: "/synthetic/copilot" });
  expect(built.argv.join(" ")).not.toContain("secret");
  expect(built.config).toMatchObject({ model: "codemux/model", availableTools: ["builtin:*", "mcp:*", "custom:*"],
    models: [{ maxContextWindowTokens: 2048, maxOutputTokens: 1024 }],
    enableConfigDiscovery: true, enableFileHooks: true, enableSkills: true });
  expect(built.config).not.toHaveProperty("pluginDirectories");
  expect(buildCopilotRpcLaunch({ adapter, request: { ...request, experimentProjectSettings: true, tools: "none" }, turn,
    harnessHome: "/synthetic/copilot" }).config).toMatchObject({ enableConfigDiscovery: true, availableTools: ["codemux-no-tools"] });
});
