import { expect, test } from "bun:test";
import { getDefaultConfig } from "../src/config.js";
import { PLAYWRIGHT_MCP_AGENT_LIST } from "../src/mcp.js";
import { resolveSessionRequest } from "../src/session/cli-request.js";
import { refusingCall } from "./helpers/session-cli-hermetic.js";

test("aider sessions refuse native project permission rules and MCP before launch", () => {
  for (const [options, message] of [
    [{ experimentProjectSettings: true, hermetic: true }, "--experiment-project-settings applies"],
    [{ enablePlaywrightMcp: true }, `--enable-playwright-mcp is supported only by ${PLAYWRIGHT_MCP_AGENT_LIST}`],
  ] as const) {
    const result = refusingCall(() => resolveSessionRequest(
      { agent: "aider", sandbox: true, auto: "low", ...options }, getDefaultConfig()
    ));
    expect(result.code, result.message).toBe(64);
    expect(result.message).toContain(message);
  }
});

test("aider session option values retain usage validation", () => {
  for (const [options, message] of [
    [{ permissionPolicy: "allow" }, "--permission-policy accepts 'default' or 'deny'"],
    [{ turnTimeout: "0" }, "--turn-timeout"],
    [{ printSandbox: true, sandbox: false }, "--print-sandbox requires --sandbox"],
  ] as const) {
    const result = refusingCall(() => resolveSessionRequest(
      { agent: "aider", sandbox: true, auto: "low", ...options }, getDefaultConfig()
    ));
    expect(result.code, result.message).toBe(64);
    expect(result.message).toContain(message);
  }
});
