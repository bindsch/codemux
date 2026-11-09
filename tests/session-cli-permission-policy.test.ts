import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { getDefaultConfig } from "../src/config.js";
import { SESSION_AGENTS } from "../src/session/cli-agents.js";
import { resolveSessionRequest } from "../src/session/cli-request.js";
import { KIMI_SESSION_DENY_RULE } from "../src/kimi-hermetic.js";
import { hermeticFixture, refusingCall } from "./helpers/session-cli-hermetic.js";
import { outcomeEvents, runSessionCommand, waitForEvent } from "./helpers/session-command.js";

function records<T>(state: string, file: string): T[] {
  return readFileSync(join(state, file), "utf8").trim().split("\n").map((line) => JSON.parse(line) as T);
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

describe("session permission policy validation", () => {
  test("a synthetic session failure does not change the test process exit code", async () => {
    const original = process.exitCode ?? 0;
    const outcome = await runSessionCommand(["-a", "claude", "--no-sandbox", "--auto", "high"], {
      claude: 'if [ "$1" = "--version" ]; then printf "2.1.280\\n"; exit 0; fi\nexit 7',
    });
    expect(outcome.exitCode).toBe(1);
    expect(process.exitCode).toBe(original);
  });

  test.each(["kimi", "opencode", "agy"])(
    "%s refuses deny without a supported private rule carrier", async (agent) => {
      const outcome = refusingCall(() => resolveSessionRequest({
        agent, permissionPolicy: "deny", sandbox: true,
      }, getDefaultConfig()));
      expect(outcome.code).toBe(64);
      expect(outcome.message).toContain(SESSION_AGENTS[agent]!.approvalsNote!);
      expect(outcome.message).toContain("requires --hermetic");
      const cli = await runSessionCommand(["-a", agent, "--permission-policy", "deny"]);
      expect(cli.exitCode).toBe(64);
      expect(cli.stderr).toContain(SESSION_AGENTS[agent]!.approvalsNote!);
      expect(cli.stdout).toBe("");
    }
  );

  test("OpenCode refuses project permissions that can override its deny rules", () => {
    const outcome = refusingCall(() => resolveSessionRequest({
      agent: "opencode", permissionPolicy: "deny", hermetic: true,
      experimentProjectSettings: true, sandbox: true,
    }, getDefaultConfig()));
    expect(outcome.code).toBe(64);
    expect(outcome.message).toContain("project agent permissions can override the global deny");
    expect(outcome.message).toContain(SESSION_AGENTS.opencode!.approvalsNote!);
  });

  test.each(["claude", "zai"])(
    "%s accepts deny with the required carrier before the absent binary check", async (agent) => {
      const argv = ["-a", agent, "--permission-policy", "deny", "--auto", "high"];
      const outcome = await runSessionCommand(argv);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.stderr).toContain("is not installed");
      expect(outcome.stderr).not.toContain("--permission-policy");
    }
  );
});

describe("session deny policy through the CLI", () => {
  test.each(["low", "medium"])("codex %s denies immediately without pending requests", async (autonomy) => {
    const s = hermeticFixture("codex");
    const stdin = new PassThrough();
    let driveError: unknown;
    try {
      const outcome = await runSessionCommand(s.args([
        "--hermetic", "--auto", autonomy, "--permission-policy", "deny", "--permission-timeout", "1",
      ]), s.binaries, {
        registryFile: s.registryFile, env: s.env, setup: s.setup, stdin,
        drive: async ({ chunks }) => {
          try {
            stdin.write(`${JSON.stringify({ type: "user", text: "scenario:ask write" })}\n`);
            const request = await waitForEvent(chunks, "permission request", (event) => event.type === "permission_request", 3_000);
            await waitForEvent(chunks, "immediate denial", (event) => event.type === "permission_denied", 3_000);
            stdin.write(`${JSON.stringify({ type: "permission_response", request_id: request.request_id, decision: "allow" })}\n`);
            await waitForEvent(chunks, "late answer rejection", (event) => event.type === "input_rejected", 3_000);
            await waitForEvent(chunks, "turn completion", (event) => event.type === "turn_completed", 3_000);
          } catch (error) { driveError = error; }
          finally { stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`); }
        },
      });
      expect(driveError).toBeUndefined();
      expect(outcome.exitCode, outcome.stderr).toBe(0);
      const events = outcomeEvents([outcome.stdout]);
      const request = events.find((event) => event.type === "permission_request")!;
      const denied = events.find((event) => event.type === "permission_denied")!;
      expect(denied.request_id).toBe(request.request_id);
      expect(denied.tool).toBe(request.tool);
      expect(denied.seq).toBe(Number(request.seq) + 1);
      expect("message" in denied).toBe(false);
      expect(events.find((event) => event.type === "input_rejected")?.reason).toBe("unknown_request");
      expect(events.some((event) => event.type === "permission_resolved")).toBe(false);
      expect(records<{ result: unknown }>(s.state, "decisions.jsonl").map((entry) => entry.result))
        .toEqual([{ decision: "decline" }]);
    } finally { s.cleanup(); }
  });

  test("kimi's spawned turn receives the private config with the native deny", async () => {
    const s = hermeticFixture("kimi");
    const stdin = new PassThrough();
    let driveError: unknown;
    try {
      const outcome = await runSessionCommand(s.args(["--hermetic", "--permission-policy", "deny"]), s.binaries, {
        registryFile: s.registryFile, env: s.env, setup: s.setup, stdin,
        drive: async ({ chunks }) => {
          try {
            stdin.write(`${JSON.stringify({ type: "user", text: "scenario:permission-tools denied" })}\n`);
            await waitForEvent(chunks, "denied tools", (event) => event.type === "turn_completed", 3_000);
          } catch (error) { driveError = error; }
          finally { stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`); }
        },
      });
      expect(outcome.exitCode, outcome.stderr).toBe(0);
      expect(driveError).toBeUndefined();
      const events = outcomeEvents([outcome.stdout]);
      const home = events.find((event) => event.type === "session_started")!.private_home as string;
      const config = Bun.TOML.parse(readFileSync(join(home, ".kimi-code", "config.toml"), "utf8")) as Record<string, unknown>;
      expect((config.permission as { rules: unknown[] }).rules).toContainEqual(KIMI_SESSION_DENY_RULE);
      const env = records<{ kimiCodeHome: string }>(s.state, "env.jsonl")[0]!;
      expect(env.kimiCodeHome).toBe(join(s.observations()[0]!.home, ".kimi-code"));
      const results = events.filter((event) => event.type === "tool_result");
      expect(results).toHaveLength(5);
      expect(results.every((event) => String(event.output).includes("denied by permission rule"))).toBe(true);
      expect(events.some((event) => String(event.type).startsWith("permission_"))).toBe(false);
    } finally { s.cleanup(); }
  });

  test("agy's spawned command carries the native deny settings overlay", async () => {
    const s = hermeticFixture("agy");
    try {
      const outcome = await s.run(["--hermetic", "--permission-policy", "deny"]);
      expect(outcome.exitCode, outcome.stderr).toBe(0);
      expect(outcome.driveError).toBeUndefined();
      const args = records<{ args: string[] }>(s.state, "argv.jsonl")[0]!.args;
      const settings = args.find((arg) => arg.startsWith("--settings="))!;
      expect(JSON.parse(settings.slice("--settings=".length))).toEqual({ permissions: { deny: [
        "read_file(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "command(*)", "unsandboxed(*)", "mcp(*)",
      ] } });
      expect(args).not.toContain("--dangerously-skip-permissions");
      expect(outcome.events.some((event) => String(event.type).startsWith("permission_"))).toBe(false);
    } finally { s.cleanup(); }
  });

  test("opencode's spawned turns carry both native deny environment values", async () => {
    // Reuse the isolated home and fake scode; replace the agent with OpenCode.
    const s = hermeticFixture("kimi");
    const stdin = new PassThrough();
    const fake = join(import.meta.dir, "fixtures", "live", "fake-opencode-run.ts");
    const binaries = { scode: s.binaries.scode, opencode:
      'if [ "$1" = "--version" ]; then printf "1.19.5\\n"; exit 0; fi\n' +
      'printf \'%s\\n\' "$OPENCODE_CONFIG_CONTENT" "$OPENCODE_PERMISSION" >> "$FAKE_STATE_DIR/deny-env.jsonl"\n' +
      `exec bun ${quote(fake)} "$@"`,
    };
    let driveError: unknown;
    try {
      const outcome = await runSessionCommand(s.args([
        "--agent", "opencode", "--auto", "high", "--hermetic", "--permission-policy", "deny",
      ]), binaries, {
        registryFile: s.registryFile, env: s.env, setup: s.setup, stdin,
        drive: async ({ chunks }) => {
          try {
            for (const turn of [1, 2]) {
              stdin.write(`${JSON.stringify({ type: "user", text: `scenario:basic turn ${turn}` })}\n`);
              await waitForEvent(chunks, `turn ${turn}`, (event) => event.type === "turn_completed" &&
                outcomeEvents(chunks).filter((entry) => entry.type === "turn_completed").length === turn, 3_000);
            }
          } catch (error) { driveError = error; }
          finally { stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`); }
        },
      });
      expect(driveError).toBeUndefined();
      expect(outcome.exitCode, outcome.stderr).toBe(0);
      expect(records(s.state, "deny-env.jsonl")).toEqual([
        { permission: "deny" }, { "*": "deny" }, { permission: "deny" }, { "*": "deny" },
      ]);
      const turns = records<{ args: string[] }>(s.state, "argv.jsonl");
      expect(turns).toHaveLength(2);
      expect(turns.every((turn) => !turn.args.includes("--auto"))).toBe(true);
      expect(turns[1]!.args).toContain("--session");
      expect(outcomeEvents([outcome.stdout]).some((event) => String(event.type).startsWith("permission_"))).toBe(false);
    } finally { s.cleanup(); }
  });
});
