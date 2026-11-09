// Review m3 (scratch/fix/review-owner-integration.md): a refusal that
// names the supporting agents names every agent the table holds, so an
// operator refused for a tenth agent is not told only three can.
import { expect, test } from "bun:test";
import { AGENT_IDS, getAdapter } from "../src/adapters/index.js";
import { assertProjectSettingsAgent, PROJECT_SETTINGS_AGENTS } from "../src/claude-project-settings.js";
import { PLAYWRIGHT_MCP_AGENTS, supportsPlaywrightMcpAgent } from "../src/mcp.js";

const refusal = (run: () => void): string => {
  try { run(); } catch (error) { return error instanceof Error ? error.message : String(error); }
  return "";
};

test("the Playwright refusal names every agent in PLAYWRIGHT_MCP_AGENTS", () => {
  const outside = AGENT_IDS.filter((agent) => !supportsPlaywrightMcpAgent(agent));
  expect(outside.length).toBeGreaterThan(0);
  for (const agent of outside) {
    const message = refusal(() => getAdapter(agent, {}).validateRunRequest({
      agent, prompt: "p", sandboxed: true, enablePlaywrightMcp: true,
    }));
    expect(message, agent).toStartWith("--enable-playwright-mcp is supported only by ");
    for (const member of PLAYWRIGHT_MCP_AGENTS) expect(message, `${agent} names ${member}`).toContain(member);
  }
});

test("the project-settings refusal names every agent in PROJECT_SETTINGS_AGENTS", () => {
  const message = refusal(() => assertProjectSettingsAgent("aider"));
  expect(message).toStartWith("--experiment-project-settings applies to the ");
  for (const member of PROJECT_SETTINGS_AGENTS) expect(message, member).toContain(member);
});
