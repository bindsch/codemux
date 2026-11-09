/**
 * Cline caller-owned session homes (--harness-home) against the synthetic
 * ACP binary on a fake PATH: the provider-override requirement, the native
 * roots inside the caller directory across start, resume and --final, the
 * overlay files for requested options, and a preview that writes nothing.
 * No harness or provider runs.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { driveSession } from "./helpers/session-cli.js";

const FAKE = fileURLToPath(new URL("./fixtures/live/fake-cline-acp.ts", import.meta.url));
const CALLER_SETTINGS = '{"caller_setting":"retained"}';

function rig(override = true) {
  const fake = createFakeBinaryEnv({
    cline: `if [ "$1" = "--version" ]; then printf '3.0.74\\n'; exit 0; fi\nexec bun '${FAKE}' "$@"`,
    scode: `while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"`,
  });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "session-cli-cline-home-")));
  const caller = join(root, "caller");
  const settings = join(caller, ".cline", "data", "settings", "global-settings.json");
  mkdirSync(join(settings, ".."), { recursive: true });
  writeFileSync(settings, CALLER_SETTINGS);
  const env: Record<string, string> = { ...fake.env, FAKE_STATE_DIR: root, HOME: join(root, "home"), XDG_STATE_HOME: join(root, "xdg"),
    ...(override ? { CODEMUX_CLINE_PROVIDER_BASE_URL: "https://gateway.example/v1",
      CODEMUX_CLINE_PROVIDER_API_KEY: "fixture-key", CODEMUX_CLINE_PROVIDER_MODEL: "fixture-model" } : {}) };
  const calls = () => existsSync(join(root, "calls.jsonl")) ? readFileSync(join(root, "calls.jsonl"), "utf8").split("\n")
    .filter(Boolean).map((line) => JSON.parse(line) as { argv: string[]; env: Record<string, string> })
    .filter((call) => call.argv.includes("--acp")) : [];
  return { env, root, caller, settings, calls, cleanup: () => { fake.cleanup(); rmSync(root, { recursive: true, force: true }); } };
}

async function oneTurn(args: string[], env: Record<string, string>) {
  const session = await driveSession(["session", "-a", "cline", "--no-sandbox", "--auto", "high",
    "--pass-env", "FAKE_STATE_DIR", "--shutdown-grace", "2", ...args], env);
  try {
    session.send({ type: "user", text: "hello" });
    const completed = await session.waitFor("turn_completed", (event) => event.type === "turn_completed")
      .catch(async (error) => { session.proc.kill(); throw new Error(`${error}\n${await new Response(session.proc.stderr as ReadableStream).text()}`); });
    const started = await session.waitFor("session_started", (event) => event.type === "session_started");
    session.send({ type: "shutdown" });
    const [exitCode] = await session.exit;
    return { started, completed, exitCode, events: session.events };
  } finally { session.proc.kill(); }
}

describe("CLI - cline caller-owned session homes", () => {
  test("a caller home without a provider override is refused with 64 and stays untouched", async () => {
    const r = rig(false);
    try {
      const out = await runCli(["session", "-a", "cline", "--no-sandbox", "--auto", "high", "--harness-home", r.caller], r.env);
      expect(out.exitCode).toBe(64);
      expect(out.stderr).toContain("for 'cline' requires a provider override; its provider settings file stores API keys beside settings");
      expect(r.calls()).toHaveLength(0);
      expect(readFileSync(r.settings, "utf8")).toBe(CALLER_SETTINGS);
    } finally { r.cleanup(); }
  });

  test("start, resume and --final keep every native root in the caller home and its settings intact", async () => {
    const r = rig();
    try {
      const first = await oneTurn(["--harness-home", r.caller], r.env);
      expect(first.exitCode).toBe(0);
      expect(first.started.private_home).toBe(r.caller);
      const id = String(first.completed.session_id);
      const second = await oneTurn(["--harness-home", r.caller, "--resume", id, "--final"], r.env);
      expect(second.exitCode).toBe(0);
      expect(second.completed.session_id).toBe(id);
      expect(second.events.at(-1)).toMatchObject({ type: "session_ended", resumable: true });
      const calls = r.calls();
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.argv[call.argv.indexOf("--config") + 1]).toBe(join(r.caller, ".cline"));
        expect(call.env).toMatchObject({ HOME: r.caller, CLINE_DIR: join(r.caller, ".cline"),
          CLINE_PROVIDER_SETTINGS_PATH: join(r.caller, ".cline", "providers.json"), CLINE_SESSION_BACKEND_MODE: "local" });
        // No option asked for an overlay, so the caller's own settings stay the native ones.
        expect(call.env.CLINE_GLOBAL_SETTINGS_PATH).toBeUndefined();
      }
      // --final never removes a caller-owned home.
      expect(readFileSync(r.settings, "utf8")).toBe(CALLER_SETTINGS);
      expect(existsSync(r.caller)).toBe(true);
    } finally { r.cleanup(); }
  }, 45_000);

  test("--tools none rides an overlay that merges the caller's settings without rewriting them", async () => {
    const r = rig();
    try {
      const turn = await oneTurn(["--harness-home", r.caller, "--tools", "none"], r.env);
      expect(turn.exitCode).toBe(0);
      const overlay = join(r.caller, ".cline", "global-settings.json");
      for (const call of r.calls()) expect(call.env.CLINE_GLOBAL_SETTINGS_PATH).toBe(overlay);
      expect(JSON.parse(readFileSync(overlay, "utf8"))).toMatchObject({ caller_setting: "retained" });
      expect(readFileSync(r.settings, "utf8")).toBe(CALLER_SETTINGS);
    } finally { r.cleanup(); }
  }, 45_000);

  test("--print-sandbox names the caller config and starts nothing", async () => {
    const r = rig();
    try {
      const out = await runCli(["session", "-a", "cline", "--sandbox", "--print-sandbox", "--auto", "high",
        "--harness-home", r.caller], r.env);
      expect(out.exitCode, out.stderr).toBe(0);
      const argv = out.stdout.trim().split("\n");
      expect(argv[argv.indexOf("--config") + 1]).toBe(join(r.caller, ".cline"));
      expect(argv).toContain(`CLINE_DIR=${join(r.caller, ".cline")}`);
      expect(r.calls()).toHaveLength(0);
      expect(existsSync(join(r.caller, ".cline", "providers.json"))).toBe(false);
    } finally { r.cleanup(); }
  }, 45_000);
});
