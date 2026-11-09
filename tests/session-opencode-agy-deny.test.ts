import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agySessionDenySettings } from "../src/session/agy-permission-policy.js";
import { agySessionCapabilities, buildAgySessionCommand } from "../src/session/agy-session.js";
import {
  buildOpenCodeSessionCommand,
  openCodeHermeticTurnPrefix,
  opencodeSessionCapabilities,
} from "../src/session/opencode-session.js";
import { cleanups, fakeRecord, of, send, startSession, waitFor } from "./helpers/session-opencode-e2e.js";

const homes: string[] = [];
function home(settings?: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(import.meta.dir, "../scratch/fix/agy-deny-test-"));
  homes.push(dir);
  const state = join(dir, ".gemini", "antigravity-cli");
  mkdirSync(state, { recursive: true });
  const path = join(state, "settings.json");
  if (settings !== undefined) writeFileSync(path, settings, { mode: 0o600 });
  return { dir, path };
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

describe("agy native session deny", () => {
  test("appends every native action deny and preserves the consumer's settings bytes", () => {
    const text = JSON.stringify({
      modelProvider: { apiKey: "synthetic-do-not-copy-to-argv" },
      permissions: {
        allow: ["command(make test)"], ask: ["mcp(server/tool)"],
        deny: ["command(ops/publish)", "read_file(*)"],
      },
    }, null, 2);
    const fixture = home(text);
    const json = agySessionDenySettings(fixture.dir);
    expect(JSON.parse(json)).toEqual({ permissions: {
      allow: ["command(make test)"], ask: ["mcp(server/tool)"],
      deny: ["command(ops/publish)", "read_file(*)", "write_file(*)", "read_url(*)",
        "execute_url(*)", "command(*)", "unsandboxed(*)", "mcp(*)"],
    } });
    expect(json).not.toContain("synthetic-do-not-copy-to-argv");
    expect(readFileSync(fixture.path, "utf8")).toBe(text);
    expect(agySessionDenySettings(fixture.dir)).toBe(json);
  });

  test("creates an in-memory policy for absent settings and absent permission rules", () => {
    const missing = JSON.parse(agySessionDenySettings(home().dir));
    const empty = JSON.parse(agySessionDenySettings(home('{"model":"consumer-model"}').dir));
    expect(missing).toEqual(empty);
    expect(empty.permissions.deny).toHaveLength(7);
  });

  test.each(["null", "[]", "false", '{"permissions":null}', '{"permissions":[]}',
    '{"permissions":{"allow":"command(*)"}}', '{"permissions":{"ask":[1]}}',
    '{"permissions":{"deny":false}}'])("refuses invalid settings: %s", (value) => {
    expect(() => agySessionDenySettings(home(value).dir)).toThrow("invalid private agy");
  });

  test("refuses missing private home, bad JSON, symlinks, and excessive arguments", () => {
    expect(() => agySessionDenySettings(undefined)).toThrow("requires --hermetic");
    expect(() => agySessionDenySettings(home("{").dir)).toThrow("cannot read");
    const target = home("{}");
    const linked = home();
    symlinkSync(target.path, linked.path);
    expect(() => agySessionDenySettings(linked.dir)).toThrow("cannot read");
    const large = home(JSON.stringify({ permissions: { deny: ["x".repeat(32768)] } }));
    expect(() => agySessionDenySettings(large.dir)).toThrow("32 KiB");
  });

  test.each(["read-only", "low", "medium", "high"] as const)("%s carries the deny without a bypass", (autonomy) => {
    const fixture = home('{"permissions":{"deny":["command(consumer)"]}}');
    const command = buildAgySessionCommand({ autonomy, privateHomeDir: fixture.dir,
      permissionPolicy: "deny", resumeConversationId: "conv-1" });
    const settings = command.find((arg) => arg.startsWith("--settings="));
    expect(JSON.parse(settings!.slice("--settings=".length)).permissions.deny).toContain("command(*)");
    expect(command).not.toContain("--dangerously-skip-permissions");
    expect(command).toContain(`HOME=${fixture.dir}`);
    expect(command.at(-1)).toBe("--conversation=conv-1");
  });

  test("default on resume adds no stale denial and both native capabilities stay false", () => {
    const fixture = home();
    buildAgySessionCommand({ autonomy: "high", privateHomeDir: fixture.dir, permissionPolicy: "deny" });
    const command = buildAgySessionCommand({ autonomy: "high", privateHomeDir: fixture.dir, permissionPolicy: "default" });
    expect(command).toContain("--dangerously-skip-permissions");
    expect(command.some((arg) => arg.startsWith("--settings="))).toBe(false);
    expect(agySessionCapabilities().permissions).toBe(false);
    expect(opencodeSessionCapabilities().permissions).toBe(false);
  });
});

const prefixInput = {
  hermetic: true, projectSettings: false, home: "/private/turn-1",
  providerConfigPath: "/private/provider.json", realDataParent: "/private/data",
};
describe("opencode native session deny", () => {
  test("each turn sets native deny config after hermetic environment removal", () => {
    for (const turn of ["one", "two"]) {
      const prefix = openCodeHermeticTurnPrefix({ ...prefixInput, home: `/private/${turn}`, permissionPolicy: "deny" })!;
      expect(prefix).toContain(`HOME=/private/${turn}`);
      expect(prefix).toContain("OPENCODE_CONFIG=/private/provider.json");
      expect(prefix.slice(-2)).toEqual([
        'OPENCODE_CONFIG_CONTENT={"permission":"deny"}', 'OPENCODE_PERMISSION={"*":"deny"}',
      ]);
      expect(prefix.indexOf("OPENCODE_CONFIG_CONTENT")).toBeLessThan(prefix.length - 2);
    }
  });

  test("plain and project-settings sessions refuse the overridable deny", () => {
    expect(() => openCodeHermeticTurnPrefix({ ...prefixInput, hermetic: false, permissionPolicy: "deny" })).toThrow("requires --hermetic");
    expect(() => openCodeHermeticTurnPrefix({ ...prefixInput, projectSettings: true, permissionPolicy: "deny" })).toThrow("agent and mode");
    expect(() => openCodeHermeticTurnPrefix({ ...prefixInput, home: undefined, permissionPolicy: "deny" })).toThrow("not prepared");
  });

  test("default behavior and high autonomy stay unchanged without deny", () => {
    expect(openCodeHermeticTurnPrefix({ ...prefixInput, hermetic: false })).toBeNull();
    expect(openCodeHermeticTurnPrefix(prefixInput)).not.toContain('OPENCODE_PERMISSION={"*":"deny"}');
    expect(buildOpenCodeSessionCommand({ autonomy: "high", permissionPolicy: "default" })).toContain("--auto");
  });

  test.each(["read-only", "low", "medium", "high"] as const)("%s omits auto approval under deny", (autonomy) => {
    expect(buildOpenCodeSessionCommand({ autonomy, permissionPolicy: "deny", resumeSessionId: "ses_test1234" })).not.toContain("--auto");
  });

  test("the fake driver receives the deny option without emitting approval events", async () => {
    const session = await startSession({ permissionPolicy: "deny", hermetic: true,
      privateHome: { dir: "/fixture/session-home", settled: true, resumed: true,
        blockedPaths: [], settle() {}, remove: () => true },
    });
    send(session.driver, { type: "user", text: "scenario:basic denied" });
    await waitFor(session.events, of("turn_completed"), "turn completion");
    send(session.driver, { type: "user", text: "scenario:basic next denied" });
    await waitFor(session.events, (events) => events.filter((event) => event.type === "turn_completed").length === 2 || undefined, "second turn");
    const turns = fakeRecord(session, "argv.jsonl");
    expect(turns).toHaveLength(2);
    expect(turns.every((turn) => !turn.args.includes("--auto"))).toBe(true);
    expect(turns[1]!.args).toContain("--session");
    send(session.driver, { type: "permission_decision", request_id: "native-deny", decision: "allow" });
    const rejection = await waitFor(session.events, of("input_rejected"), "unsupported decision");
    expect(rejection.reason).toBe("unsupported");
    expect(session.events.some((event) => event.type.startsWith("permission_"))).toBe(false);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });
});
