/**
 * The TUI command build hands back its own trust check of the Playwright
 * MCP binary (review round 111). The binary's path sits inside the
 * --mcp-config JSON argument, so the launch needs a check for its
 * pre-spawn re-stat. The launch used to resolve the binary a second time
 * to get one, and a second resolution trusts whatever replaced the binary
 * after the command was built. The check now comes from the resolution
 * that produced the command.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import { assertExecutablesUnchanged, type ExecutableCheck } from "../src/executable-security.js";
import { buildPlaywrightSandboxMcp } from "../src/mcp.js";

const BUILDERS = [
  ["claude", () => new ClaudeAdapter({})],
  ["zai", () => new ZaiAdapter({ ZAI_API_KEY: "test-key-123" })],
] as const;

function withPlaywrightOnPath(run: (binaryPath: string, write: () => void) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "codemux-tui-mcp-check-"));
  const binaryPath = join(dir, "playwright-mcp");
  const write = (): void => {
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binaryPath, 0o755);
  };
  write();
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath ?? ""}`;
  try {
    run(binaryPath, write);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("buildTuiCommand's nested executable checks", () => {
  test.each(BUILDERS)("%s: the check names the binary the command embeds and refuses a later swap", (_name, make) => {
    withPlaywrightOnPath((binaryPath, write) => {
      const checks: ExecutableCheck[] = [];
      const command = make().buildTuiCommand(undefined, "read-only", undefined, true, true, process.cwd(), checks);
      const config = command[command.indexOf("--mcp-config") + 1] ?? "";
      const embedded = JSON.parse(config).mcpServers.playwright.command;
      expect(embedded).toBe(realpathSync(binaryPath));
      expect(checks).toHaveLength(1);
      expect(checks[0]!.path).toBe(embedded);
      // Unchanged since the build: the re-stat passes.
      expect(() => assertExecutablesUnchanged([], "tui command", undefined, checks)).not.toThrow();
      // Replaced after the build: the build's own check refuses it.
      rmSync(binaryPath);
      write();
      expect(() => assertExecutablesUnchanged([], "tui command", undefined, checks)).toThrow(
        "tui command executable changed after its trust check"
      );
      // A second resolution made now would accept the replacement, which
      // is why the launch must not make one.
      const second = buildPlaywrightSandboxMcp(true, { enabled: true, forbiddenRoot: process.cwd() });
      expect(() => assertExecutablesUnchanged([], "tui command", undefined, [second.check!])).not.toThrow();
    });
  });

  test.each(BUILDERS)("%s: a command with no Playwright argument reports no check", (_name, make) => {
    const checks: ExecutableCheck[] = [];
    const command = make().buildTuiCommand(undefined, "read-only", undefined, true, false, process.cwd(), checks);
    expect(command).not.toContain("--mcp-config");
    expect(checks).toEqual([]);
    // Unsandboxed launches never carry the server, whatever the flag says.
    make().buildTuiCommand(undefined, "read-only", undefined, false, true, process.cwd(), checks);
    expect(checks).toEqual([]);
  });
});
