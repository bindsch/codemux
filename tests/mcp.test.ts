import { describe, test, expect } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getPlaywrightSandboxMcpArgs,
} from "../src/mcp.js";
import { getAdapter } from "../src/adapters/index.js";

describe("MCP config helpers", () => {
  test("returns no args when not sandboxed", () => {
    expect(getPlaywrightSandboxMcpArgs(false)).toEqual([]);
    expect(getPlaywrightSandboxMcpArgs(undefined)).toEqual([]);
  });

  test("is disabled by default when sandboxed", () => {
    const original = process.env.CODEMUX_ENABLE_PLAYWRIGHT_MCP;
    process.env.CODEMUX_ENABLE_PLAYWRIGHT_MCP = "1";
    try {
      expect(getPlaywrightSandboxMcpArgs(true)).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.CODEMUX_ENABLE_PLAYWRIGHT_MCP;
      else process.env.CODEMUX_ENABLE_PLAYWRIGHT_MCP = original;
    }
  });

  test("returns valid opt-in config for a local binary", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-mcp-"));
    const binaryPath = join(dir, "playwright-mcp");
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binaryPath, 0o755);
    try {
      const args = getPlaywrightSandboxMcpArgs(true, {
        enabled: true,
        binaryPath,
      });
      expect(args[0]).toBe("--mcp-config");
      expect(JSON.parse(args[1] ?? "")).toEqual({
        mcpServers: {
          playwright: {
            command: realpathSync(binaryPath),
            args: [],
          },
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails closed when opt-in binary is unavailable", () => {
    expect(() => getPlaywrightSandboxMcpArgs(true, {
      enabled: true,
      binaryPath: null,
    })).toThrow("requires a locally installed playwright-mcp binary");
  });

  test("rejects a configured non-executable binary", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-mcp-"));
    const binaryPath = join(dir, "playwright-mcp");
    writeFileSync(binaryPath, "not executable", { mode: 0o600 });
    try {
      expect(() => getPlaywrightSandboxMcpArgs(true, {
        enabled: true,
        binaryPath,
      })).toThrow("binary is not a trusted executable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects repository-controlled and writable executables", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "codemux-mcp-"));
    const binaryPath = join(dir, "playwright-mcp");
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binaryPath, 0o755);
    try {
      expect(() => getPlaywrightSandboxMcpArgs(true, {
        enabled: true,
        binaryPath,
        forbiddenRoot: dir,
      })).toThrow("inside the execution working directory");

      chmodSync(binaryPath, 0o777);
      expect(() => getPlaywrightSandboxMcpArgs(true, {
        enabled: true,
        binaryPath,
      })).toThrow("group- or world-writable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the adapter resolves playwright-mcp through its child PATH, never the ambient one (review round 391, item 13)", () => {
    // Every other launch binary resolves through the adapter-built child
    // environment; the Playwright build resolved through the ambient
    // process PATH, so a custom-environment launch was refused for
    // lacking a binary its own environment held (or embedded one the
    // child could not run). The build now reads the adapter's PATH view.
    const binDir = mkdtempSync(join(tmpdir(), "codemux-mcp-path-"));
    const home = mkdtempSync(join(tmpdir(), "codemux-mcp-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "codemux-mcp-cwd-"));
    try {
      const binaryPath = join(binDir, "playwright-mcp");
      writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
      chmodSync(binaryPath, 0o755);
      const adapter = getAdapter("claude", { PATH: binDir, HOME: home });
      const cmd = adapter.buildRunCommand({
        agent: "claude",
        prompt: "p",
        cwd,
        sandboxed: true,
        enablePlaywrightMcp: true,
      });
      const config = cmd[cmd.indexOf("--mcp-config") + 1] ?? "";
      expect(JSON.parse(config).mcpServers.playwright.command).toBe(realpathSync(binaryPath));
    } finally {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
