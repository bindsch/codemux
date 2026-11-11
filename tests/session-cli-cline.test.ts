/**
 * CLI-level Cline sessions against a synthetic ACP binary on a fake PATH:
 * fresh start, a turn with native usage from `cline history`, shutdown, and
 * a resume that reloads the same native session. No harness or provider runs.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { driveSession } from "./helpers/session-cli.js";
import { nativeSessionId } from "../src/session/scoped-id.js";

const FAKE = fileURLToPath(new URL("./fixtures/live/fake-cline-acp.ts", import.meta.url));

function rig() {
  const fake = createFakeBinaryEnv({
    cline: `if [ "$1" = "--version" ]; then printf '3.0.74\\n'; exit 0; fi\nexec bun '${FAKE}' "$@"`,
    scode: `while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"`,
  });
  const root = mkdtempSync(join(tmpdir(), "session-cli-cline-"));
  const env = { ...fake.env, FAKE_STATE_DIR: root, HOME: join(root, "home"), XDG_STATE_HOME: join(root, "xdg") };
  const override = { CODEMUX_CLINE_PROVIDER_BASE_URL: "https://gateway.example/v1",
    CODEMUX_CLINE_PROVIDER_API_KEY: "fixture-key", CODEMUX_CLINE_PROVIDER_MODEL: "fixture-model" };
  const read = (name: string) => readFileSync(join(root, name), "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
  return { env, override, root, read, cleanup: () => { fake.cleanup(); rmSync(root, { recursive: true, force: true }); } };
}

async function oneTurn(args: string[], env: Record<string, string>, text: string) {
  const session = await driveSession(["session", "-a", "cline", ...(args.includes("--sandbox") ? [] : ["--no-sandbox"]), "--auto", "high",
    "--pass-env", "FAKE_STATE_DIR", "--shutdown-grace", "2", ...args], env);
  try {
    // Cline's identity is deferred: session_started follows the native id.
    session.send({ type: "user", text });
    const completed = await session.waitFor("turn_completed", (event) => event.type === "turn_completed")
      .catch(async (error) => { session.proc.kill(); throw new Error(`${error}\n${await new Response(session.proc.stderr as ReadableStream).text()}`); });
    const started = await session.waitFor("session_started", (event) => event.type === "session_started");
    session.send({ type: "shutdown" });
    const [exitCode] = await session.exit;
    return { started, completed, exitCode, events: session.events };
  } finally { session.proc.kill(); }
}

describe("CLI - cline sessions over synthetic ACP", () => {
  test("a fresh session runs a turn, reports native history usage, and a resume reloads it", async () => {
    const r = rig();
    try {
      const first = await oneTurn([], r.env, "hello");
      expect(first.exitCode).toBe(0);
      expect(first.started.capabilities).toMatchObject({ interrupt: true, resume: true });
      const answer = first.events.find((event) => event.type === "assistant_message");
      expect(answer?.text).toBe("echo: hello");
      expect(first.completed.usage).toMatchObject({ input_tokens: 10, output_tokens: 2, cached_input_tokens: 3 });
      const id = String(first.completed.session_id);
      expect(id).toStartWith("cline-");
      expect(nativeSessionId("cline", id)).toMatch(/^\d{13,}_[A-Za-z0-9_-]{5}_cli$/);

      const second = await oneTurn(["--resume", id], r.env, "again");
      expect(second.exitCode).toBe(0);
      expect(second.completed.session_id).toBe(id);
      expect(second.completed.usage).toMatchObject({ input_tokens: 10, output_tokens: 2 });
      const methods = r.read("frames.jsonl").map((frame) => frame.method);
      expect(methods.filter((method) => method === "session/new")).toHaveLength(1);
      expect(methods.filter((method) => method === "session/load")).toHaveLength(1);
      const acp = r.read("calls.jsonl").filter((call) => call.argv.includes("--acp"));
      expect(acp).toHaveLength(2);
      for (const call of acp) expect(call.argv).toEqual(expect.arrayContaining(["--acp", "--auto-approve", "true"]));
    } finally { r.cleanup(); }
  }, 45_000);

  test("a hermetic session keeps one private config across resume and --final removes it", async () => {
    const r = rig();
    try {
      const env = { ...r.env, ...r.override };
      const first = await oneTurn(["--hermetic"], env, "one");
      expect(first.exitCode).toBe(0);
      const id = String(first.completed.session_id);
      const configs = () => r.read("calls.jsonl").filter((call) => call.argv.includes("--acp"))
        .map((call) => call.argv[call.argv.indexOf("--config") + 1] as string);
      // The first turn runs before the native id exists, in a run-scoped
      // private home; settlement renames it to the session's own name.
      const [first0] = configs();
      expect(first0).toMatch(/[/]\.codemux-hermetic[/]run-[^/]+[/]\.cline$/);
      const settled = join(first0!, "..", "..", `session-${id}`);
      expect(existsSync(settled)).toBe(true);
      const second = await oneTurn(["--hermetic", "--resume", id, "--final"], env, "two");
      expect(second.exitCode).toBe(0);
      expect(second.completed.session_id).toBe(id);
      expect(configs()[1]).toBe(join(settled, ".cline"));
      expect(existsSync(settled)).toBe(false);
    } finally { r.cleanup(); }
  }, 45_000);

  test("--print-sandbox shows the per-turn ACP argv for deny, tools none and project settings", async () => {
    const r = rig();
    try {
      const env = { ...r.env, ...r.override };
      const print = async (args: string[]) => {
        const out = await runCli(["session", "-a", "cline", "--sandbox", "--print-sandbox", ...args], env);
        expect(out.exitCode, out.stderr).toBe(0);
        return out.stdout.trim().split("\n");
      };
      const deny = await print(["--auto", "high", "--permission-policy", "deny"]);
      expect(deny.slice(deny.indexOf("--acp"))).toEqual(["--acp", "--auto-approve", "false"]);
      const open = await print(["--auto", "high"]);
      expect(open.slice(open.indexOf("--acp"))).toEqual(["--acp", "--auto-approve", "true"]);
      const none = await print(["--auto", "high", "--tools", "none"]);
      expect(none).toContain("--acp");
      const fixture = join(r.root, "repo");
      mkdirSync(join(fixture, ".git"), { recursive: true });
      const project = await print(["--auto", "low", "--hermetic", "--experiment-project-settings", "--cwd", fixture]);
      expect(project[project.indexOf("--config") + 1]).toContain(".codemux-hermetic");
      // Printing opens no session state: nothing ran.
      expect(existsSync(join(r.root, "calls.jsonl"))).toBe(false);
    } finally { r.cleanup(); }
  }, 45_000);
});
