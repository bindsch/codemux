import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import { codexPlaywrightMcpOverrides } from "../src/codex-playwright-mcp.js";
import { buildCodexSessionCommand } from "../src/session/codex-session.js";
import type { ExecutableCheck } from "../src/executable-security.js";
import type { RunContext } from "../src/adapters/base.js";
import type { RunRequest } from "../src/types.js";

// The codex Playwright MCP carrier: the trust-checked stdio server as a
// `-c mcp_servers.playwright.command=...` config override, the one MCP
// channel codex has (codex-playwright-mcp.ts) — on run, TUI, and session
// spawns alike.
describe("codex Playwright MCP carrier", () => {
  let binDir = "";
  let home = "";
  let cwd = "";
  const scratch: string[] = [];

  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), "codemux-codex-pw-bin-"));
    home = mkdtempSync(join(tmpdir(), "codemux-codex-pw-home-"));
    cwd = mkdtempSync(join(tmpdir(), "codemux-codex-pw-cwd-"));
    scratch.push(binDir, home, cwd);
    const binaryPath = join(binDir, "playwright-mcp");
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binaryPath, 0o755);
    mkdirSync(join(home, ".codex"), { recursive: true });
  });
  afterAll(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const adapter = () => new CodexAdapter({ PATH: binDir, HOME: home }, home);
  const request = (extra: Partial<RunRequest> = {}): RunRequest => ({
    agent: "codex",
    prompt: "p",
    cwd,
    sandboxed: true,
    enablePlaywrightMcp: true,
    ...extra,
  });
  // The carrier resolves the binary to its canonical path, so the test's
  // expectation must too; computed lazily because beforeAll creates the
  // binary after this body runs.
  const expectedOverride = (): string =>
    `mcp_servers.playwright.command=${JSON.stringify(realpathSync(join(binDir, "playwright-mcp")))}`;
  const hasOverride = (cmd: readonly string[]): boolean =>
    cmd.some((token) => token.startsWith("mcp_servers.playwright.command="));

  test("a run embeds the trust-checked server as a -c config override", () => {
    const context: RunContext = {};
    const cmd = adapter().buildRunCommand(request(), context);
    const at = cmd.indexOf(expectedOverride());
    expect(at).toBeGreaterThan(0);
    // The override is a KEY=VALUE token its -c introduces, and it rides
    // the global option position the hermetic flags already use, before
    // the exec subcommand.
    expect(cmd[at - 1]).toBe("-c");
    expect(cmd.indexOf("exec")).toBeGreaterThan(at);
    // The trust check rides the context for the spawn's re-stat: the
    // binary path sits inside a config value the argv re-check never
    // scans (review round 110).
    expect(context.playwrightMcpCheck).not.toBeNull();
  });

  test("a run without the flag, or without the sandbox, attaches nothing", () => {
    const context: RunContext = {};
    expect(hasOverride(adapter().buildRunCommand(request({ enablePlaywrightMcp: false }), context))).toBe(false);
    expect(hasOverride(adapter().buildRunCommand(request({ sandboxed: undefined }), context))).toBe(false);
    expect(context.playwrightMcpCheck).toBeNull();
  });

  test("the shared gates accept a sandboxed run and refuse the rest", () => {
    expect(() => adapter().validateRunRequest(request())).not.toThrow();
    expect(() => adapter().validateRunRequest(request({ sandboxed: undefined })))
      .toThrow("--enable-playwright-mcp requires --sandbox");
    expect(() => adapter().validateRunRequest(request({ hermetic: true })))
      .toThrow("cannot be combined with --enable-playwright-mcp");
    expect(() => adapter().validateRunRequest(request({ tools: "none" })))
      .toThrow("cannot be combined with --enable-playwright-mcp");
  });

  test("the TUI carries the same override and hands the check to the spawn", () => {
    const checks: ExecutableCheck[] = [];
    const cmd = adapter().buildTuiCommand("gpt-5.3-codex", "low", "medium", true, true, cwd, checks);
    const at = cmd.indexOf(expectedOverride());
    expect(at).toBeGreaterThan(0);
    expect(cmd[at - 1]).toBe("-c");
    expect(checks).toHaveLength(1);
  });

  test("the TUI without the flag attaches nothing and pushes no check", () => {
    const checks: ExecutableCheck[] = [];
    const cmd = adapter().buildTuiCommand(undefined, undefined, undefined, true, false, cwd, checks);
    expect(hasOverride(cmd)).toBe(false);
    expect(checks).toHaveLength(0);
  });

  test("fails closed when the binary is missing from the launch PATH", () => {
    expect(() =>
      codexPlaywrightMcpOverrides(true, { enabled: true, pathEnv: "/nonexistent", forbiddenRoot: cwd })
    ).toThrow("requires a locally installed playwright-mcp binary");
  });

  test("the session argv carries the overrides after app-server", () => {
    const overrides = ["-c", 'mcp_servers.playwright.command="/x"'];
    expect(buildCodexSessionCommand()).toEqual(["codex", "app-server"]);
    expect(buildCodexSessionCommand(["CODEX_HOME=/h"])).toEqual(["env", "CODEX_HOME=/h", "codex", "app-server"]);
    expect(buildCodexSessionCommand(undefined, overrides)).toEqual(["codex", "app-server", ...overrides]);
    expect(buildCodexSessionCommand(["CODEX_HOME=/h"], overrides)).toEqual([
      "env", "CODEX_HOME=/h", "codex", "app-server", ...overrides,
    ]);
  });
});
