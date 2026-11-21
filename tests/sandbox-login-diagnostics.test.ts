import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

const root = mkdtempSync(join(import.meta.dir, "../scratch/login-diagnostics-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const scode = 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"';
const denied = "the sandbox was not granted the login store";

test.each(["claude", "agy"] as const)("%s run reports the unavailable grant before and after native auth failure", async (agent) => {
  const home = join(root, `${agent}-run`), cwd = join(home, "work");
  mkdirSync(cwd, { recursive: true });
  const frame = agent === "claude" ? { type: "result", is_error: true, result: "Not logged in" }
    : { event: "result", result: { status: "ERROR", error: "authentication failed or timed out", response: "" } };
  const fake = createFakeBinaryEnv({ scode, [agent]: `cat >/dev/null\nprintf '%s\\n' '${JSON.stringify(frame)}'\nexit 1` }, "0.6.8");
  try {
    for (const flags of [[], ["--sandbox-no-login-store"], ["--sandbox-login-store"]]) {
      const result = await runCli(["run", "-a", agent, "--sandbox", "--cwd", cwd, "--no-quota-gate", "-p", "synthetic", ...flags],
        { ...fake.env, HOME: home, GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" });
      expect(result.exitCode, result.stderr).toBe(1);
      const unavailable = process.platform === "darwin" && !flags.includes("--sandbox-login-store");
      expect(result.stderr.split(denied).length - 1).toBe(unavailable ? 2 : 0);
      if (unavailable) expect(result.stderr).not.toContain("claude auth login");
    }
  } finally { fake.cleanup(); }
});

test.each(["claude", "agy"] as const)("%s session emits one initial notice and one denied-grant authentication diagnostic", async (agent) => {
  const home = join(root, `${agent}-session`), cwd = join(home, "work");
  mkdirSync(cwd, { recursive: true });
  const fixture = join(import.meta.dir, "fixtures/live", `fake-${agent}-session.ts`);
  const fake = createFakeBinaryEnv({ scode, [agent]: `exec bun '${fixture}' "$@"` }, "0.6.8");
  try {
    const result = await runCli(["session", "-a", agent, "--sandbox", "--cwd", cwd, "--no-quota-gate", "--shutdown-grace", "1",
      "--pass-env", "FAKE_STATE_DIR,FAKE_DIAGNOSTIC_TEXT,FAKE_DIAGNOSTIC_FAILED"], {
      ...fake.env, HOME: home, GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "",
      FAKE_STATE_DIR: join(home, "fake"), FAKE_DIAGNOSTIC_TEXT: "Not logged in", FAKE_DIAGNOSTIC_FAILED: "1",
    }, { stdin: `${JSON.stringify({ type: "user", text: agent === "claude" ? "scenario:diagnostic" : "scenario:authfail" })}\n` });
    expect(result.stdout, result.stderr).toContain('"type":"session_ended"');
    expect(result.stderr.split(denied).length - 1).toBe(process.platform === "darwin" ? 2 : 0);
    if (process.platform === "darwin") expect(result.stderr).not.toContain("claude auth login");
  } finally { fake.cleanup(); }
});
