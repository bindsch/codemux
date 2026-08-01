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
});
