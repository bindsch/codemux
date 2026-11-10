// The Claude adapter's child environment against a parent harness's own
// control variables (split from adapters-claude.test.ts for the size limit).
import { expect, test } from "bun:test";
import { ClaudeAdapter } from "../src/adapters/claude.js";

test("a parent Claude Code's control variables never decide the child's", () => {
  // 2026-11-10 live gate, run from inside a Claude Code session: the
  // parent exports CLAUDE_CODE_ENTRYPOINT, the messaging socket and token,
  // its session id, and may export CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0.
  // codemux's own scrub value wins and the rest are not allowlisted
  // (src/environment.ts), so the child's permission mapping and credential
  // scrub are codemux's, whatever harness launched codemux.
  const parent = new ClaudeAdapter({
    PATH: "/usr/bin",
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "0",
    CLAUDE_CODE_ENTRYPOINT: "local-agent",
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/parent.sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "parent-token",
    CLAUDE_CODE_SESSION_ID: "parent-session",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_SESSION_ATTENDED: "1",
    CLAUDE_CODE_EXECPATH: "/parent/claude",
  });
  const env = parent.buildExecutionEnv();
  expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
  expect(Object.keys(env).filter((name) => name.startsWith("CLAUDE_CODE_"))).toEqual(["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"]);
});
