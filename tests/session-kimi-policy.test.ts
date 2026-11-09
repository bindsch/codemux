import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { populateKimiPolicySessionHome } from "../src/kimi-run-policy.js";
import { prepareKimiTuiLaunch } from "../src/kimi-tui-launch.js";
import { buildKimiSessionPreview } from "../src/session/kimi-preview.js";
import { kimiPrivateBrandHome } from "../src/kimi-hermetic.js";
import { writeKimiNoToolsFile } from "../src/kimi-no-tools.js";
import { readRegistry } from "../src/session/registry.js";
import { fakePrivateHome, fakeResumedPrivateHome } from "./helpers/fake-private-home.js";
import { cleanups, ID, of, send, startSession, waitFor } from "./helpers/session-kimi-e2e.js";

afterAll(async () => { for (const cleanup of cleanups) await cleanup(); });

function fixture() {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "kimi-session-policy-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, ".kimi-code");
  const bin = join(root, "bin");
  const cwd = join(root, "work");
  for (const path of [source, bin, cwd]) mkdirSync(path);
  mkdirSync(join(cwd, ".git"));
  writeFileSync(join(bin, "playwright-mcp"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(join(source, "config.toml"), 'extra_skill_dirs = ["/custom/skills"]\n[permission]\nrules = []\n');
  writeFileSync(join(source, "mcp.json"), '{"mcpServers":{"existing":{"command":"operator"}}}');
  writeFileSync(join(source, "SYSTEM.md"), "operator instructions");
  mkdirSync(join(source, ".codemux"));
  mkdirSync(join(source, "sessions"));
  writeFileSync(join(source, "session_index.jsonl"), "operator state");
  return { root, source, bin, cwd, adapter: new KimiAdapter({ HOME: root, PATH: bin }, root) };
}

describe("Kimi private session and interactive MCP", () => {
  test.each([false, true])("session customization and Playwright survive turns and native resume: %s", async (resumed) => {
    const f = fixture();
    const home = resumed ? fakeResumedPrivateHome(ID) : fakePrivateHome();
    populateKimiPolicySessionHome(home.dir, f.source);
    cleanups.push(() => { home.remove(); });
    const brand = kimiPrivateBrandHome(home.dir);
    expect(readFileSync(join(brand, "SYSTEM.md"), "utf8")).toBe("operator instructions");
    expect(existsSync(join(brand, "sessions"))).toBe(false);
    expect(existsSync(join(brand, "session_index.jsonl"))).toBe(false);
    const noTools = writeKimiNoToolsFile(brand);
    noTools.finalize();
    const session = await startSession({ privateHome: home, preserveCustomization: true,
      playwrightMcp: true, playwrightPathEnv: f.bin, resumeSessionId: resumed ? ID : null });
    const spawn = session.options.spawnTurn;
    let checks = 0;
    session.options.spawnTurn = async (argv, abandoned, identities) => {
      expect(identities).toHaveLength(1);
      checks++;
      const current = kimiPrivateBrandHome(home.dir);
      const config = JSON.parse(readFileSync(join(current, "mcp.json"), "utf8"));
      expect(config.mcpServers.playwright).toEqual({ command: join(f.bin, "playwright-mcp"), args: [] });
      expect(config.mcpServers.existing.command).toBe("operator");
      expect(argv).toContain(`KIMI_CODE_HOME=${current}`);
      expect(argv.some((arg) => arg.startsWith("HOME="))).toBe(false);
      return spawn(argv, abandoned, identities);
    };
    send(session.driver, { type: "user", text: "scenario:basic first" });
    await waitFor(session.events, of("turn_completed"), "first turn");
    send(session.driver, { type: "user", text: "scenario:basic second" });
    await waitFor(session.events, (events) => events.filter((event) => event.type === "turn_completed")[1], "second turn");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    expect(checks).toBe(2);
    const record = readRegistry(session.options.registryPath!);
    expect(record.outcome).toBe("ok");
    if (record.outcome === "ok") {
      expect(record.file.sessions[0]!.hermetic).toBe(false);
      expect(record.file.sessions[0]!.playwright_mcp).toBe(true);
    }
    expect(readFileSync(join(kimiPrivateBrandHome(home.dir), "config.toml"), "utf8")).toContain("extra_skill_dirs");
    expect(readFileSync(join(f.source, "mcp.json"), "utf8")).not.toContain("playwright");
  });

  test("a provider-only session needs no operator home", () => {
    const home = fakePrivateHome();
    try {
      populateKimiPolicySessionHome(home.dir, null);
      expect(existsSync(kimiPrivateBrandHome(home.dir))).toBe(true);
    } finally { home.remove(); }
  });

  test("interactive launch owns the private file, provider effort, executable check, and cleanup", () => {
    const f = fixture();
    const launch = prepareKimiTuiLaunch(f.adapter, { cwd: f.cwd, autonomy: "low", effort: "high", sandboxed: true, enablePlaywrightMcp: true });
    const brand = launch.command.find((arg) => arg.startsWith("KIMI_CODE_HOME="))!.split("=").slice(1).join("=");
    expect(launch.command).not.toContain("--prompt");
    expect(launch.env.KIMI_MODEL_THINKING_EFFORT).toBe("high");
    expect(launch.playwrightCheck).not.toBeNull();
    expect(existsSync(join(brand, "mcp.json"))).toBe(true);
    launch.cleanup();
    expect(existsSync(brand)).toBe(false);
    const plain = prepareKimiTuiLaunch(f.adapter, { cwd: f.cwd, sandboxed: false, enablePlaywrightMcp: false });
    expect(plain.command).toEqual(["kimi"]);
    plain.cleanup();
    expect(() => prepareKimiTuiLaunch(new KimiAdapter({ HOME: f.root, PATH: "" }, f.root),
      { cwd: f.cwd, sandboxed: true, enablePlaywrightMcp: true })).toThrow("locally installed playwright-mcp");
  });

  test("sandbox previews represent fresh, resumed, plain and hermetic turns without writing files", () => {
    const f = fixture();
    const homeDir = join(f.root, "not-created");
    const plain = buildKimiSessionPreview({ harnessHome: f.source, hermetic: false });
    expect(plain).toEqual(["kimi", "--output-format", "stream-json", "--prompt", "<session prompt>"]);
    const fresh = buildKimiSessionPreview({ harnessHome: f.source, homeDir, hermetic: true, tools: "none", model: "model" });
    expect(fresh).toContain(`HOME=${homeDir}`);
    expect(fresh).toContain("--agent-file");
    expect(fresh).toContain("--skills-dir");
    const resumed = buildKimiSessionPreview({ harnessHome: f.source, homeDir, hermetic: false, tools: "none", resumeSessionId: ID });
    expect(resumed).toContain(`KIMI_CODE_HOME=${kimiPrivateBrandHome(homeDir)}`);
    expect(resumed).toContain(ID);
    expect(resumed).not.toContain("--agent-file");
    expect(existsSync(homeDir)).toBe(false);
  });
});
