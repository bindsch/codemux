import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdapter } from "../src/adapters/index.js";
import { claudeAutonomyFlags } from "../src/claude-autonomy.js";
import { PLAYWRIGHT_MCP_CODE_TOOLS, PLAYWRIGHT_MCP_GRANT } from "../src/mcp.js";

// 2026-11-17: a headless zai run with --enable-playwright-mcp listed the
// browser tools and had every call refused ("doesn't grant the permission to
// use mcp__playwright__browser_navigate") at every autonomy level, because
// the forced default permission mode denies an ungranted MCP tool.
const LEVELS = ["read-only", "low", "medium", "high"] as const;

function allowed(cmd: readonly string[]): string[] {
  const start = cmd.indexOf("--allowedTools");
  if (start < 0) return [];
  const rest = cmd.slice(start + 1);
  const end = rest.findIndex((argument) => argument.startsWith("--"));
  return end < 0 ? rest : rest.slice(0, end);
}

function denied(cmd: readonly string[]): string[] {
  const start = cmd.indexOf("--disallowedTools");
  if (start < 0) return [];
  const rest = cmd.slice(start + 1);
  const end = rest.findIndex((argument) => argument.startsWith("--"));
  return end < 0 ? rest : rest.slice(0, end);
}

function fixture(): { binDir: string; home: string; cwd: string; cleanup: () => void } {
  const binDir = mkdtempSync(join(tmpdir(), "codemux-pw-bin-"));
  const home = mkdtempSync(join(tmpdir(), "codemux-pw-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "codemux-pw-cwd-"));
  const binary = join(binDir, "playwright-mcp");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n");
  chmodSync(binary, 0o755);
  return { binDir, home, cwd, cleanup: () => { for (const dir of [binDir, home, cwd]) rmSync(dir, { recursive: true, force: true }); } };
}

for (const agent of ["claude", "zai"] as const) {
  for (const autonomy of LEVELS) {
    test(`${agent} at ${autonomy}: the attached browser server's tools are allowed headless`, () => {
      const f = fixture();
      try {
        const adapter = getAdapter(agent, { PATH: f.binDir, HOME: f.home, ZAI_API_KEY: "synthetic" });
        const base = { agent, prompt: "p", cwd: f.cwd, sandboxed: true, autonomy } as const;
        const withBrowser = adapter.buildRunCommand({ ...base, enablePlaywrightMcp: true });
        expect(withBrowser).toContain("--mcp-config");
        expect(allowed(withBrowser)).toContain(PLAYWRIGHT_MCP_GRANT);
        // The server's code-execution tools are a shell: denied exactly
        // where the level grants no Bash (review of 2.0.5, security 1).
        const shell = autonomy === "medium" || autonomy === "high";
        expect(allowed(withBrowser).includes("Bash")).toBe(shell);
        expect(denied(withBrowser)).toEqual(shell ? [] : [...PLAYWRIGHT_MCP_CODE_TOOLS]);
        // Without the option nothing of the server is granted.
        expect(adapter.buildRunCommand(base).join(" ")).not.toContain(PLAYWRIGHT_MCP_GRANT);
        // --no-web denies the web tools, and the browser with them: the CLI
        // refuses the pair, and a programmatic request gets no grant.
        const noWeb = adapter.buildRunCommand({ ...base, enablePlaywrightMcp: true, web: false });
        expect(allowed(noWeb)).not.toContain(PLAYWRIGHT_MCP_GRANT);
        // The shared validator refuses the pair for a programmatic request too.
        expect(() => adapter.validateRunRequest({ ...base, enablePlaywrightMcp: true, web: false }))
          .toThrow("--no-web cannot be combined with --enable-playwright-mcp");
        // A request without a level still gets the browser it asked for.
        const { autonomy: _level, ...unleveled } = base;
        const bare = adapter.buildRunCommand({ ...unleveled, enablePlaywrightMcp: true });
        expect(allowed(bare)).toContain(PLAYWRIGHT_MCP_GRANT);
        expect(denied(bare)).toEqual([...PLAYWRIGHT_MCP_CODE_TOOLS]);
        expect(allowed(noWeb)).not.toContain("WebFetch");
      } finally { f.cleanup(); }
    });
  }
}

test("the grant is the whole-server rule and rides beside the level's own grants", () => {
  expect(PLAYWRIGHT_MCP_GRANT).toBe("mcp__playwright");
  expect(claudeAutonomyFlags("read-only", "/work", { web: "deny", extraGrants: [PLAYWRIGHT_MCP_GRANT] }))
    .toEqual(expect.arrayContaining(["--allowedTools", "mcp__playwright", "--disallowedTools", "WebSearch", "WebFetch"]));
  expect(claudeAutonomyFlags("read-only", "/work", { web: "deny" })).not.toContain("--allowedTools");
  expect(claudeAutonomyFlags("high", "/work", { extraGrants: [PLAYWRIGHT_MCP_GRANT] })).toContain("mcp__playwright");
  // Shell-only denies join the web denies in one list, and only below medium.
  expect(PLAYWRIGHT_MCP_CODE_TOOLS).toEqual(["mcp__playwright__browser_run_code_unsafe", "mcp__playwright__browser_run_code"]);
  expect(denied(claudeAutonomyFlags("low", "/work", { web: "deny", shellOnlyDenies: PLAYWRIGHT_MCP_CODE_TOOLS })))
    .toEqual(["WebSearch", "WebFetch", ...PLAYWRIGHT_MCP_CODE_TOOLS]);
  expect(denied(claudeAutonomyFlags("medium", "/work", { shellOnlyDenies: PLAYWRIGHT_MCP_CODE_TOOLS }))).toEqual([]);
});

// Review of 2.0.5, edges: the shared validator refused the pair for every
// agent, although only the Claude family grants the browser's tools headless.
test.each(["kimi", "codex", "gemini", "opencode", "qwen"] as const)("%s still accepts --no-web beside the browser", (agent) => {
  const f = fixture();
  try {
    const adapter = getAdapter(agent, { PATH: f.binDir, HOME: f.home });
    let message = "";
    try { adapter.validateRunRequest({ agent, prompt: "p", cwd: f.cwd, sandboxed: true, autonomy: "low", enablePlaywrightMcp: true, web: false }); }
    catch (error) { message = (error as Error).message; }
    expect(message).not.toContain("--no-web cannot be combined");
  } finally { f.cleanup(); }
});

