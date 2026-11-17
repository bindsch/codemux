import { expect, test } from "bun:test";
import { claudeErrorText, claudeLoginAdvice } from "../src/claude-login-advice.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";

test.each(["Not logged in · Please run /login", "Authentication required", "OAuth token has expired", "refresh token is revoked",
  "Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` to sign in again."])(
  "native error gives one exact login command: %s", (text) => {
    expect(claudeLoginAdvice(true, text)).toBe("claude: the harness reported a missing or invalid login; run `claude auth login`.");
    expect(claudeLoginAdvice(false, text)).toBeNull();
  });

test.each(["HTTP 401", "credentials file absent", "expiresAt is in the past", "provider unavailable"])(
  "unconfirmed local or provider evidence gives no login advice: %s", (text) => {
    expect(claudeLoginAdvice(true, text)).toBeNull();
  });

test("native result errors supply advice without treating tool/model text as auth evidence", () => {
  expect(claudeErrorText({ result: "one", errors: ["two", {}, 3] })).toBe("one\ntwo");
  expect(claudeErrorText({ errors: {} })).toBe("");
  const adapter = new ClaudeAdapter({});
  const request = { agent: "claude" as const, prompt: "test" };
  const raw = { stdout: JSON.stringify({ type: "result", is_error: true, errors: ["Not logged in"] }),
    stderr: "", exitCode: 1, durationMs: 1, success: false };
  expect(adapter.processRunResult(raw, request).stderr.match(/claude auth login/g)).toHaveLength(1);
  expect(adapter.processRunResult({ ...raw, stdout: '{"type":"result","result":"Not logged in"}', exitCode: 0 }, request).stderr).not.toContain("auth login");
});
