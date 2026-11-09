import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { AgyAdapter } from "../src/adapters/agy.js";
import {
  agyMcpConfigPath,
  plantAgyPlaywrightMcpConfig,
} from "../src/agy-playwright-mcp.js";

// run.playwright-mcp for agy: no argv flag exists at 1.5.3, so the
// carrier is the probe home's global MCP config
// (~/.gemini/config/mcp_config.json, binary strings read 2026-11-09),
// planted with the trust-checked Playwright stdio server every sandboxed
// run's private home can carry.
describe("agy playwright MCP carrier", () => {
  function fakePlaywrightRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "codemux-agy-mcp-"));
    const binary = join(root, "playwright-mcp");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    return root;
  }

  test("plants the trust-checked server at the global config path", () => {
    const root = fakePlaywrightRoot();
    const home = mkdtempSync(join(tmpdir(), "codemux-agy-home-"));
    const realPath = process.env.PATH;
    process.env.PATH = `${root}:${realPath ?? ""}`;
    try {
      const planted = plantAgyPlaywrightMcpConfig(home, {
        pathEnv: process.env.PATH ?? "",
        forbiddenRoot: home,
      });
      expect(planted.path).toBe(join(home, ".gemini", "config", "mcp_config.json"));
      expect(agyMcpConfigPath(home)).toBe(planted.path);
      const config = JSON.parse(readFileSync(planted.path, "utf8")) as {
        mcpServers: { playwright: { command: string } };
      };
      expect(config.mcpServers.playwright.command).toBe(realpathSync(join(root, "playwright-mcp")));
      expect(planted.check).not.toBeNull();
      // A reused home with an existing config fails loudly, never merges.
      expect(() => plantAgyPlaywrightMcpConfig(home, {
        pathEnv: process.env.PATH ?? "", forbiddenRoot: home,
      })).toThrow();
    } finally {
      if (realPath === undefined) delete process.env.PATH;
      else process.env.PATH = realPath;
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("no binary on PATH is the shared refusal, never a silent skip", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-agy-home-"));
    const empty = mkdtempSync(join(tmpdir(), "codemux-agy-empty-"));
    const realPath = process.env.PATH;
    process.env.PATH = empty;
    try {
      expect(() => plantAgyPlaywrightMcpConfig(home, {
        pathEnv: empty, forbiddenRoot: home,
      })).toThrow("--enable-playwright-mcp requires a locally installed playwright-mcp binary");
      expect(existsSync(agyMcpConfigPath(home))).toBe(false);
    } finally {
      if (realPath === undefined) delete process.env.PATH;
      else process.env.PATH = realPath;
      rmSync(empty, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the adapter refuses the flag without scode and never attaches argv", () => {
    const adapter = new AgyAdapter({ HOME: "/h" });
    expect(() => adapter.validateRunRequest({
      agent: "agy", prompt: "p", enablePlaywrightMcp: true,
    })).toThrow("--enable-playwright-mcp requires --sandbox");
    // The carrier is the planted file, never an argv flag: the command
    // shape is unchanged by the option.
    const withFlag = adapter.buildRunCommand({ agent: "agy", prompt: "p", sandboxed: true, enablePlaywrightMcp: true });
    const without = adapter.buildRunCommand({ agent: "agy", prompt: "p", sandboxed: true });
    expect(withFlag).toEqual(without);
    expect(withFlag.some((arg) => arg.includes("mcp"))).toBe(false);
  });
});
