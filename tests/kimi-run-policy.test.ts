import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { createKimiPolicyHome, disableKimiWebTools, KIMI_WEB_TOOLS, prepareKimiPlaywright } from "../src/kimi-run-policy.js";
import type { RunContext } from "../src/adapters/base.js";
import type { RunRequest } from "../src/types.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "kimi-run-policy-"));
  cleanups.push(() => rmSync(home, { force: true, recursive: true }));
  const brand = join(home, ".kimi-code");
  const cwd = join(home, "work");
  const bin = join(home, "bin");
  for (const dir of [brand, cwd, bin]) mkdirSync(dir);
  mkdirSync(join(cwd, ".git"));
  const binary = join(bin, "playwright-mcp");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(binary, 0o700);
  const adapter = new KimiAdapter({ HOME: home, PATH: bin }, home);
  const request: RunRequest = { agent: "kimi", prompt: "hello", autonomy: "high", cwd };
  return { home, brand, cwd, bin, binary, adapter, request };
}

function own(context: RunContext, adapter: KimiAdapter): RunContext {
  cleanups.push(() => adapter.cleanupRunSync(context));
  return context;
}

describe("Kimi run-scoped native policy", () => {
  test("no-web preserves customization and existing restrictions without touching source files", () => {
    const f = fixture();
    const source = 'default_model = "chosen"\nextra_skill_dirs = ["/custom/skills"]\n' +
      'when = 2026-11-09T10:11:12.123456+01:00\n[tools]\nenabled = ["Read", "WebSearch"]\ndisabled = ["Bash"]\n' +
      '[permission]\nrules = [{ decision = "deny", pattern = "Write" }]\n';
    writeFileSync(join(f.brand, "config.toml"), source);
    writeFileSync(join(f.brand, "SYSTEM.md"), "custom instructions");
    mkdirSync(join(f.brand, "skills"));
    const mcp = '{"mcpServers":{"existing":{"command":"old"}},"metadata":"keep"}';
    writeFileSync(join(f.brand, "mcp.json"), mcp);
    const request = { ...f.request, web: false };
    f.adapter.validateRunRequest(request);
    const context = own(f.adapter.prepareRun(request), f.adapter);
    const privateBrand = context.kimiHermeticHome!.kimiHome;
    const configText = readFileSync(join(privateBrand, "config.toml"), "utf8");
    const config = Bun.TOML.parse(configText) as any;
    expect(config.tools).toEqual({ enabled: ["Read", "WebSearch"], disabled: ["Bash", ...KIMI_WEB_TOOLS] });
    expect(config.permission.rules[0].pattern).toBe("Write");
    expect(config.extra_skill_dirs).toEqual(["/custom/skills"]);
    expect(configText).toContain("2026-11-09T10:11:12.123456+01:00");
    expect(readFileSync(join(privateBrand, "SYSTEM.md"), "utf8")).toBe("custom instructions");
    expect(lstatSync(join(privateBrand, "skills")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(privateBrand, "mcp.json"), "utf8")).toBe(mcp);
    expect(readFileSync(join(f.brand, "config.toml"), "utf8")).toBe(source);
    const argv = f.adapter.buildRunCommand(request, context);
    expect(argv.slice(0, 3)).toEqual(["env", `KIMI_CODE_HOME=${privateBrand}`, "kimi"]);
    expect(argv.some((arg) => arg.startsWith("HOME="))).toBe(false);
    expect(argv).not.toContain("--skills-dir");
    expect(argv).not.toContain("--agent-file");
    expect(f.adapter.getRunEnv(request, context)).toEqual({});
    disableKimiWebTools(privateBrand);
    expect(readFileSync(join(privateBrand, "config.toml"), "utf8")).toBe(configText);
    f.adapter.cleanupRunSync(context);
    expect(existsSync(privateBrand)).toBe(false);
    expect(readFileSync(join(f.brand, "SYSTEM.md"), "utf8")).toBe("custom instructions");
  });

  test("no-web and tools none use the private empty-tool profile together", () => {
    const f = fixture();
    const request: RunRequest = { ...f.request, web: false, tools: "none" };
    const context = own(f.adapter.prepareRun(request), f.adapter);
    const argv = f.adapter.buildRunCommand(request, context);
    expect(argv[argv.indexOf("--agent-file") + 1]).toBe(context.kimiHermeticHome!.agentFile);
    expect(readFileSync(context.kimiHermeticHome!.agentFile, "utf8")).toContain("tools: []");
  });

  test("hermetic no-web keeps customization filtered and HOME redirected", () => {
    const f = fixture();
    writeFileSync(join(f.brand, "config.toml"), 'default_model = "keep"\nextra_skill_dirs = ["/drop"]\n');
    const request = { ...f.request, web: false, hermetic: true };
    const context = own(f.adapter.prepareRun(request), f.adapter);
    const config = Bun.TOML.parse(readFileSync(join(context.kimiHermeticHome!.kimiHome, "config.toml"), "utf8")) as any;
    expect(config.default_model).toBe("keep");
    expect(config.extra_skill_dirs).toBeUndefined();
    expect(config.tools.disabled).toEqual(KIMI_WEB_TOOLS);
    expect(f.adapter.buildRunCommand(request, context)).toContain(`HOME=${context.kimiHermeticHome!.home}`);
  });

  test("Playwright preserves other servers and stores its executable identity", () => {
    const f = fixture();
    const source = '{"mcpServers":{"existing":{"command":"old"}},"metadata":"keep"}';
    writeFileSync(join(f.brand, "mcp.json"), source);
    const request = { ...f.request, sandboxed: true, enablePlaywrightMcp: true };
    const context = own(f.adapter.prepareRun(request), f.adapter);
    const argv = f.adapter.buildRunCommand(request, context);
    const config = JSON.parse(readFileSync(join(context.kimiHermeticHome!.kimiHome, "mcp.json"), "utf8"));
    expect(config).toEqual({ metadata: "keep", mcpServers: {
      existing: { command: "old" }, playwright: { command: f.binary, args: [] },
    } });
    expect(context.playwrightMcpCheck).not.toBeNull();
    expect(argv).toContain(`KIMI_CODE_HOME=${context.kimiHermeticHome!.kimiHome}`);
    expect(readFileSync(join(f.brand, "mcp.json"), "utf8")).toBe(source);
    expect(() => prepareKimiPlaywright(request, {}, { pathEnv: f.bin })).toThrow("private policy home");
    expect(() => prepareKimiPlaywright(request, undefined, { pathEnv: f.bin })).not.toThrow();
    expect(() => prepareKimiPlaywright({ ...request, sandboxed: false }, context, { pathEnv: f.bin })).toThrow("requires --sandbox");
  });

  test("Playwright starts with an empty private server table when the operator has none", () => {
    const f = fixture();
    const request = { ...f.request, sandboxed: true, enablePlaywrightMcp: true, web: false };
    const context = own(f.adapter.prepareRun(request), f.adapter);
    f.adapter.buildRunCommand(request, context);
    expect(Object.keys(JSON.parse(readFileSync(join(context.kimiHermeticHome!.kimiHome, "mcp.json"), "utf8")).mcpServers)).toEqual(["playwright"]);
  });

  test.each(['[]', '{"mcpServers":[]}'])('malformed MCP configuration refuses: %s', (source) => {
    const f = fixture();
    writeFileSync(join(f.brand, "mcp.json"), source);
    const request = { ...f.request, sandboxed: true, enablePlaywrightMcp: true };
    const context = own(f.adapter.prepareRun(request), f.adapter);
    expect(() => f.adapter.buildRunCommand(request, context)).toThrow("must be a table");
  });

  test.each(['tools = []', '[tools]\ndisabled = "Bash"'])('malformed tool configuration cleans the private home: %s', (source) => {
    const f = fixture();
    writeFileSync(join(f.brand, "config.toml"), source);
    expect(() => f.adapter.prepareRun({ ...f.request, web: false })).toThrow("private Kimi tools");
    expect(readdirSync(join(f.brand, ".codemux-hermetic"))).toEqual([]);
  });

  test("MCP symlinks refuse without reading their targets; print-only reads no operator state", () => {
    const f = fixture();
    symlinkSync(join(f.home, "not-present"), join(f.brand, "mcp.json"));
    expect(() => createKimiPolicyHome(f.brand, { ...f.request, web: false })).toThrow();
    expect(readdirSync(join(f.brand, ".codemux-hermetic"))).toEqual([]);
    const home = createKimiPolicyHome(f.brand, { ...f.request, web: false }, true);
    cleanups.push(home.finalize);
    expect(Bun.TOML.parse(readFileSync(join(home.kimiHome, "config.toml"), "utf8"))).toEqual({ tools: { disabled: KIMI_WEB_TOOLS } });
    expect(() => f.adapter.getRunEnv({ ...f.request, web: false })).toThrow("private policy home");
  });
});
