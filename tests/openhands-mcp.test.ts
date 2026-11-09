import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { OpenHandsAdapter } from "../src/adapters/openhands.js";
import { PLAYWRIGHT_MCP_AGENT_LIST } from "../src/mcp.js";
import {
  openhandsMcpConfigPath,
  plantOpenhandsPlaywrightMcp,
} from "../src/openhands-mcp.js";

// run.playwright-mcp for openhands: no argv flag exists at 1.16.0, so
// the carrier is the persistence dir's mcp.json (locations.py
// MCP_CONFIG_FILE under the env-relocatable persistence dir, read
// 2026-11-09), planted into the private home a hermetic run owns.
describe("openhands playwright MCP carrier", () => {
  const overrideEnv = {
    CODEMUX_OPENHANDS_PROVIDER_BASE_URL: "https://api.example/v1",
    CODEMUX_OPENHANDS_PROVIDER_API_KEY: "key-1",
    CODEMUX_OPENHANDS_PROVIDER_MODEL: "provider-model",
  };

  function fakePlaywrightRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "codemux-openhands-mcp-"));
    const binary = join(root, "playwright-mcp");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    return root;
  }

  test("plants the trust-checked server at the mcp.json path", () => {
    const root = fakePlaywrightRoot();
    const dir = mkdtempSync(join(tmpdir(), "codemux-openhands-persist-"));
    try {
      const planted = plantOpenhandsPlaywrightMcp(dir, {
        pathEnv: `${root}:${process.env.PATH ?? ""}`,
        forbiddenRoot: dir,
      });
      expect(planted.path).toBe(join(dir, "mcp.json"));
      expect(openhandsMcpConfigPath(dir)).toBe(planted.path);
      const config = JSON.parse(readFileSync(planted.path, "utf8")) as {
        mcpServers: { playwright: { command: string } };
      };
      expect(config.mcpServers.playwright.command)
        .toBe(realpathSync(join(root, "playwright-mcp")));
      expect(planted.check).not.toBeNull();
      // A reused dir with an existing mcp.json fails loudly, never merges.
      expect(() => plantOpenhandsPlaywrightMcp(dir, {
        pathEnv: `${root}:${process.env.PATH ?? ""}`, forbiddenRoot: dir,
      })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the adapter refuses the flag without --hermetic", () => {
    const adapter = new OpenHandsAdapter({ HOME: "/h" });
    // Today the shared agent gate refuses openhands outright (the
    // activation patch extends PLAYWRIGHT_MCP_AGENTS); the adapter's own
    // hermetic rule — the persistence dir a plant needs is private only
    // under --hermetic — is the backstop that gate change exposes, so
    // both refusals are pinned by shape.
    expect(() => adapter.validateRunRequest({
      agent: "openhands", prompt: "p", sandboxed: true, enablePlaywrightMcp: true,
    })).toThrow(`--enable-playwright-mcp is supported only by ${PLAYWRIGHT_MCP_AGENT_LIST}`);
    expect(() => adapter.validateRunRequest({
      agent: "openhands", prompt: "p", sandboxed: true, enablePlaywrightMcp: true,
    })).toThrow(/claude, zai, opencode/);
  });

  test("a hermetic prepareRun plants mcp.json in the private persistence dir", () => {
    const root = fakePlaywrightRoot();
    const home = mkdtempSync(join(tmpdir(), "codemux-openhands-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "codemux-openhands-cwd-"));
    const adapter = new OpenHandsAdapter({
      HOME: home, PATH: `${root}:${process.env.PATH ?? ""}`, ...overrideEnv,
    });
    try {
      const context = adapter.prepareRun({
        agent: "openhands", prompt: "p", hermetic: true, sandboxed: true,
        enablePlaywrightMcp: true, cwd,
      });
      const persistence = join(context.openhandsHermeticHome!.home, ".openhands");
      const config = JSON.parse(
        readFileSync(openhandsMcpConfigPath(persistence), "utf8")
      ) as { mcpServers: { playwright: { command: string } } };
      expect(config.mcpServers.playwright.command)
        .toBe(realpathSync(join(root, "playwright-mcp")));
      expect(context.playwrightMcpCheck).not.toBeNull();
      // The env prefix pins the persistence dir at the same path, so the
      // run resolves the planted file and nothing else.
      const cmd = adapter.buildRunCommand(
        { agent: "openhands", prompt: "p", hermetic: true, model: "m", enablePlaywrightMcp: true },
        context
      );
      expect(cmd).toContain(`OPENHANDS_PERSISTENCE_DIR=${persistence}`);
      adapter.cleanupRunSync(context);
      expect(existsSync(persistence)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
