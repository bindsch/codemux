import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { createKimiHermeticHome, KIMI_CONFIG_ALLOWLIST, KIMI_HERMETIC_ENV_OMISSIONS } from "../src/kimi-hermetic.js";
import { UsageRefusalError } from "../src/validation.js";
import { plantKimiCanary } from "../src/kimi-isolation-probe.js";
import type { RunRequest } from "../src/types.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

function fixture(environment: NodeJS.ProcessEnv = {}) {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "kimi-hermetic-"));
  const brand = join(home, ".kimi-code");
  const cwd = join(home, "work");
  mkdirSync(join(brand, "credentials"), { recursive: true });
  mkdirSync(join(cwd, ".git"), { recursive: true });
  writeFileSync(join(brand, "credentials", "kimi.json"), "original");
  const adapter = new KimiAdapter({ HOME: home, KIMI_CODE_TRUST_WORKSPACE: "true", ...environment }, home);
  const request: RunRequest = { agent: "kimi", prompt: "hello", cwd, hermetic: true, autonomy: "high" };
  return { home, brand, cwd, adapter, request, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe("Kimi private home", () => {
  test("filters config, retains catalog/login settings, and leaves discovery absent", () => {
    const f = fixture();
    writeFileSync(join(f.brand, "config.toml"), `
default_provider = "example"
default_model = "example/model.v1"
telemetry = false
disable_feedback_survey = true
auto_session_title = true
extra_skill_dirs = ["/operator/skills"]
extra_agent_dirs = ["/operator/agents"]
merge_all_available_skills = true
builtin_product_skills = false
default_permission_mode = "auto"
default_plan_mode = true
unknown_future_key = "operator"
[providers.example]
type = "openai"
api_key = "synthetic"
oauth = { storage = "file", key = "kimi" }
[models."example/model.v1"]
provider = "example"
model = "test"
max_context_size = 100
capabilities = ["thinking", "tool_use"]
[models."example/model.v1".overrides]
display_name = "Test model"
[model_overrides.example]
max_context_size = 50
[thinking]
effort = "high"
[loop_control]
max_steps_per_turn = 3
[context_token_counting]
strategy = "measured"
[token_counting]
strategy = "measured+estimated"
[background]
max_running_tasks = 2
[services.moonshot_search]
base_url = "https://example.invalid/search"
[mcp]
startup_timeout_ms = 123
tool_timeout_ms = 456
default_deferred = false
servers = { operator = { command = "operator-code" } }
[[hooks]]
event = "PreToolUse"
command = "operator-code"
[permission]
rules = []
[plugins]
enabled = ["operator"]
[subagent]
prompt = "operator"
[secondary_model]
default_model = "other"
[identity]
name = "operator"
`);
    for (const name of ["agents", "skills", "plugins", "hooks"]) mkdirSync(join(f.brand, name));
    for (const name of ["AGENTS.md", "SYSTEM.md", "mcp.json"]) writeFileSync(join(f.brand, name), "operator");
    writeFileSync(join(f.brand, "region"), "test-region");
    writeFileSync(join(f.brand, "device_id"), "test-device");
    const home = createKimiHermeticHome(f.brand);
    try {
      const config = Bun.TOML.parse(readFileSync(join(home.kimiHome, "config.toml"), "utf8")) as Record<string, any>;
      expect(Object.keys(config).sort()).toEqual([...KIMI_CONFIG_ALLOWLIST, "auto_session_title"].sort());
      expect(config.auto_session_title).toBe(false);
      expect(config.providers.example.oauth).toEqual({ storage: "file", key: "kimi" });
      expect(config.models["example/model.v1"].overrides.display_name).toBe("Test model");
      expect(config.models["example/model.v1"].capabilities).toEqual(["thinking", "tool_use"]);
      expect(config.mcp).toEqual({ startup_timeout_ms: 123, tool_timeout_ms: 456 });
      expect(config.telemetry).toBe(false);
      expect(config.builtin_product_skills).toBeUndefined();
      expect(readdirSync(home.kimiHome).sort()).toEqual(["config.toml", "credentials", "device_id", "region"]);
      expect(readdirSync(home.skillsDir)).toEqual([]);
      expect(readFileSync(home.agentFile, "utf8")).toContain("${base_prompt}");
      expect(readFileSync(home.agentFile, "utf8")).not.toContain("tools:");
      expect(readFileSync(join(home.kimiHome, "region"), "utf8")).toBe("test-region");
      expect(readFileSync(join(home.kimiHome, "device_id"), "utf8")).toBe("test-device");
      expect(home.home.startsWith(join(f.brand, ".codemux-hermetic", `run-${process.pid}-`))).toBe(true);
      expect(statSync(home.home).mode & 0o777).toBe(0o700);
      expect(statSync(join(home.kimiHome, "config.toml")).mode & 0o777).toBe(0o600);
    } finally { home.finalize(); f.cleanup(); }
  });

  test("a symlink swapped in for region is refused and its target never reaches the private home", () => {
    const f = fixture();
    const target = join(f.home, "operator-secret");
    writeFileSync(target, "symlinked-region");
    symlinkSync(target, join(f.brand, "region"));
    writeFileSync(join(f.brand, "device_id"), "test-device");
    let refusal: unknown;
    try {
      createKimiHermeticHome(f.brand);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("region");
    expect((refusal as Error).message).toContain("symbolic link");
    // The launch failed, so the private home is finalized: no partial
    // copy of the other state file survives anywhere under the parent.
    expect(readdirSync(join(f.brand, ".codemux-hermetic")).length).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("symlinked-region");
  });

  test("a FIFO swapped in for device_id is refused at once, not blocked on", () => {
    const f = fixture();
    writeFileSync(join(f.brand, "region"), "test-region");
    const fifo = join(f.brand, "device_id");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const started = Date.now();
    let refusal: unknown;
    try {
      createKimiHermeticHome(f.brand);
    } catch (error) {
      refusal = error;
    }
    // The bounded reader opens nonblocking and refuses the descriptor on
    // its fstat: no writer ever appears, so a regression to a plain copy
    // would block this test instead of refusing.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("device_id");
    expect((refusal as Error).message).toContain("not a regular file");
    expect(readdirSync(join(f.brand, ".codemux-hermetic")).length).toBe(0);
    rmSync(fifo, { force: true });
    f.cleanup();
  });

  test("region and device_id are copied byte for byte with private permissions", () => {
    const f = fixture();
    const region = join(f.brand, "region");
    writeFileSync(region, "eu-central\r\n");
    writeFileSync(join(f.brand, "device_id"), Buffer.from([0x61, 0x0a, 0x62]));
    const home = createKimiHermeticHome(f.brand);
    try {
      expect(readFileSync(join(home.kimiHome, "region"))).toEqual(readFileSync(region));
      expect(readFileSync(join(home.kimiHome, "device_id"))).toEqual(Buffer.from([0x61, 0x0a, 0x62]));
      expect(statSync(join(home.kimiHome, "region")).mode & 0o777).toBe(0o600);
      expect(statSync(join(home.kimiHome, "device_id")).mode & 0o777).toBe(0o600);
    } finally { home.finalize(); f.cleanup(); }
  });

  test("directory symlink preserves atomic token refresh and source files at cleanup", () => {
    const f = fixture();
    const home = createKimiHermeticHome(f.brand, true);
    try {
      const credentials = join(home.kimiHome, "credentials");
      expect(lstatSync(credentials).isSymbolicLink()).toBe(true);
      expect(realpathSync(credentials)).toBe(realpathSync(join(f.brand, "credentials")));
      mkdirSync(credentials, { recursive: true, mode: 0o700 });
      writeFileSync(join(credentials, "kimi.json.tmp"), "refreshed");
      renameSync(join(credentials, "kimi.json.tmp"), join(credentials, "kimi.json"));
      expect(readFileSync(join(f.brand, "credentials", "kimi.json"), "utf8")).toBe("refreshed");
      expect(readFileSync(home.agentFile, "utf8")).toContain("tools: []");
      home.finalize(); home.finalize();
      expect(existsSync(home.home)).toBe(false);
      expect(readFileSync(join(f.brand, "credentials", "kimi.json"), "utf8")).toBe("refreshed");
    } finally { home.finalize(); f.cleanup(); }
  });

  test("sweeps stale dead-owner homes and retains live, recent, and unrelated entries", () => {
    const f = fixture();
    const parent = join(f.brand, ".codemux-hermetic");
    mkdirSync(parent);
    const dead = "run-2147483647-old";
    const kept = [`run-${process.pid}-live`, "run-2147483647-young", "unrelated"];
    for (const entry of [dead, ...kept]) mkdirSync(join(parent, entry));
    const old = new Date(Date.now() - 4 * 86_400_000);
    utimesSync(join(parent, dead), old, old);
    utimesSync(join(parent, kept[0]!), old, old);
    const home = createKimiHermeticHome(f.brand);
    try {
      expect(existsSync(join(parent, dead))).toBe(false);
      for (const entry of kept) expect(existsSync(join(parent, entry))).toBe(true);
    } finally { home.finalize(); f.cleanup(); }
  });

  test("refuses linked parents and malformed or oversized configuration", () => {
    const f = fixture();
    try {
      symlinkSync(f.cwd, join(f.brand, ".codemux-hermetic"));
      expect(() => createKimiHermeticHome(f.brand)).toThrow("must be a directory");
      writeFileSync(join(f.brand, "config.toml"), "invalid = [");
      expect(() => createKimiHermeticHome(f.brand)).toThrow();
      writeFileSync(join(f.brand, "config.toml"), "#".repeat(1024 * 1024 + 1));
      expect(() => createKimiHermeticHome(f.brand)).toThrow("exceeds");
    } finally { f.cleanup(); }
  });

  test("per-run lifecycle keeps homes independent and removes signal listeners", () => {
    const f = fixture();
    const before = process.listenerCount("SIGHUP");
    const first = f.adapter.prepareRun(f.request), second = f.adapter.prepareRun(f.request);
    try {
      expect(first.kimiHermeticHome!.home).not.toBe(second.kimiHermeticHome!.home);
      expect(process.listenerCount("SIGHUP")).toBe(before + 1);
      f.adapter.cleanupRunSync(first);
      expect(existsSync(second.kimiHermeticHome!.home)).toBe(true);
      f.adapter.cleanupRunSync(second);
      expect(process.listenerCount("SIGHUP")).toBe(before);
    } finally { f.adapter.cleanupRunSync(first); f.adapter.cleanupRunSync(second); f.cleanup(); }
  });

  test.each(["exit", "SIGINT", "SIGTERM", "SIGHUP"])("finalizes private homes on %s without a harness", async (mode) => {
    const f = fixture();
    const code = `import {createKimiHermeticHome} from ${JSON.stringify(join(import.meta.dir, "../src/kimi-hermetic.ts"))};
const home = createKimiHermeticHome(${JSON.stringify(f.brand)});
console.log(home.home);
${mode === "exit" ? "" : "setInterval(() => {}, 1000);"}`;
    const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    try {
      const reader = child.stdout.getReader();
      const first = await reader.read();
      const path = new TextDecoder().decode(first.value).trim();
      expect(path).toContain(".codemux-hermetic");
      if (mode !== "exit") {
        expect(existsSync(path)).toBe(true);
        child.kill(mode as NodeJS.Signals);
      }
      const expected = { exit: 0, SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[mode];
      expect(await child.exited).toBe(expected);
      expect(await new Response(child.stderr).text()).toBe("");
      expect(existsSync(path)).toBe(false);
      await reader.cancel();
    } finally { if (child.exitCode === null) child.kill(); await child.exited; f.cleanup(); }
  });
});

describe("Kimi hermetic adapter", () => {
  test.each([false, true])("argv disables binary updates only for hermetic runs; experiment=%s", (experiment) => {
    const f = fixture({ KIMI_CODE_NO_AUTO_UPDATE: "0", KIMI_CLI_NO_AUTO_UPDATE: "0" });
    const context = f.adapter.prepareRun(f.request);
    const request = { ...f.request, experimentMcp: experiment ? join(f.home, "spec.json") : undefined,
      passthroughEnv: ["KIMI_CODE_NO_AUTO_UPDATE", "KIMI_CLI_NO_AUTO_UPDATE"] };
    try {
      for (const prepared of [undefined, context]) {
        const argv = f.adapter.buildRunCommand(request, prepared);
        expect(argv[0]).toBe("env");
        expect(argv.slice(1, argv.indexOf("kimi"))).toContain("KIMI_CODE_NO_AUTO_UPDATE=1");
        expect(argv.filter((arg) => arg.startsWith("KIMI_CODE_NO_AUTO_UPDATE=")))
          .toEqual(["KIMI_CODE_NO_AUTO_UPDATE=1"]);
        const plain = f.adapter.buildRunCommand({ ...request, hermetic: false }, prepared);
        expect(plain[0]).toBe("kimi");
        expect(plain).not.toContain("KIMI_CODE_NO_AUTO_UPDATE=1");
      }
    } finally { f.adapter.cleanupRunSync(context); f.cleanup(); }
  });

  test.each(["KIMI_MCP_TOOL_TIMEOUT_MS", "KIMI_MCP_STARTUP_TIMEOUT_MS"])("private argv removes inherited %s", (name) => {
    const f = fixture();
    const context = f.adapter.prepareRun(f.request);
    try {
      const argv = f.adapter.buildRunCommand(f.request, context);
      const position = argv.indexOf(name);
      expect(position).toBeGreaterThan(0);
      expect(argv[position - 1]).toBe("-u");
      expect(position).toBeLessThan(argv.indexOf(`HOME=${context.kimiHermeticHome!.home}`));
    } finally { f.adapter.cleanupRunSync(context); f.cleanup(); }
  });

  test.each([undefined, "none"] as const)("prepared argv and environment with tools %s", (tools) => {
    const f = fixture();
    const request = { ...f.request, tools, resultJson: true };
    const context = f.adapter.prepareRun(request);
    try {
      const home = context.kimiHermeticHome!;
      expect(f.adapter.capabilities().supportsHermetic).toBe(true);
      expect(f.adapter.capabilities().supportsResultJson).toBe(true);
      expect(f.adapter.buildRunCommand(request, context)).toEqual(["env",
        ...KIMI_HERMETIC_ENV_OMISSIONS.flatMap((name) => ["-u", name]),
        "KIMI_CODE_NO_AUTO_UPDATE=1", "KIMI_CODE_REPEAT_BREAKER=false", `HOME=${home.home}`, `KIMI_CODE_HOME=${home.kimiHome}`, "kimi", "--skills-dir", home.skillsDir,
        "--agent-file", home.agentFile, "--output-format", "stream-json", "--prompt", "hello"]);
      expect(f.adapter.getRunEnv(request, context)).toEqual({});
      expect(f.adapter.getRunEnv({ ...request, sandboxed: true }, context)).toEqual({});
      expect(f.adapter.buildExecutionEnv(f.adapter.getRunEnv(request, context)).HOME).toBe(f.home);
      const env = f.adapter.buildExecutionEnv({}, ["KIMI_CODE_TRUST_WORKSPACE"]);
      expect(env.KIMI_CODE_TRUST_WORKSPACE).toBe("true");
      expect(context.kimiNoToolsFile).toBeUndefined();
      expect(existsSync(join(f.brand, ".codemux"))).toBe(false);
      expect(readFileSync(home.agentFile, "utf8").includes("tools: []")).toBe(tools === "none");
      expect(f.adapter.buildTuiCommand()).toEqual(["kimi"]);
    } finally { f.adapter.cleanupRunSync(context); f.cleanup(); }
  });

  test("fails closed without preparation and refuses the brand-home pass-through", () => {
    const f = fixture();
    try {
      expect(() => f.adapter.getRunEnv(f.request)).toThrow("not prepared");
      expect(() => f.adapter.validateRunRequest({ ...f.request, passthroughEnv: ["KIMI_CODE_HOME"] })).toThrow(UsageRefusalError);
      expect(() => f.adapter.validateRunRequest({ ...f.request, passthroughEnv: ["KIMI_CODE_HOME"] })).toThrow("owns KIMI_CODE_HOME");
      const argv = f.adapter.buildRunCommand(f.request);
      expect(argv[argv.indexOf("--agent-file") + 1]).toContain("unprepared");
    } finally { f.cleanup(); }
  });

  for (const name of ["AGENTS.md", "agents.md", ".kimi-code", ".agents", ".mcp.json"]) {
    test.each(["file", "directory", "dangling"])(`refuses ${name} as %s at the Git root`, (kind) => {
      const f = fixture();
      const nested = join(f.cwd, "nested");
      mkdirSync(nested);
      const path = join(f.cwd, name);
      try {
        if (kind === "file") writeFileSync(path, "instructions");
        else if (kind === "directory") mkdirSync(path);
        else symlinkSync(join(f.home, "absent"), path);
        expect(() => f.adapter.validateRunRequest({ ...f.request, cwd: nested })).toThrow(UsageRefusalError);
        try { f.adapter.validateRunRequest({ ...f.request, cwd: nested }); }
        catch (error) { expect((error as Error).message.toLowerCase()).toContain(path.toLowerCase()); }
      } finally { f.cleanup(); }
    });
  }

  test("checks cwd through Git root in order and only cwd without Git", () => {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), "kimi-non-git-"));
    try {
      writeFileSync(join(f.home, "AGENTS.md"), "outside");
      expect(() => f.adapter.validateRunRequest(f.request)).not.toThrow();
      writeFileSync(join(outside, "AGENTS.md"), "outside");
      const bare = join(outside, "bare"); mkdirSync(bare);
      expect(() => f.adapter.validateRunRequest({ ...f.request, cwd: bare })).not.toThrow();
      const child = join(f.cwd, "nested"); mkdirSync(child);
      writeFileSync(join(child, "AGENTS.md"), "child");
      writeFileSync(join(f.cwd, "agents.md"), "root");
      // The refusal names the Git root's file in the spelling the file
      // system reports: AGENTS.md on case-insensitive APFS, agents.md on
      // case-sensitive ext4 (CI run 42681779732, ubuntu-latest), so the
      // path is compared case-insensitively, as the test above does.
      expect(() => f.adapter.validateRunRequest({ ...f.request, cwd: child })).toThrow(UsageRefusalError);
      try { f.adapter.validateRunRequest({ ...f.request, cwd: child }); }
      catch (error) { expect((error as Error).message.toLowerCase()).toContain(join(f.cwd, "agents.md").toLowerCase()); }
    } finally { rmSync(outside, { recursive: true, force: true }); f.cleanup(); }
  });

  test.each(["dangling", "invalid-file"])("a %s .git marker cannot hide parent instructions", (kind) => {
    const f = fixture();
    const nested = join(f.cwd, "nested"); mkdirSync(nested);
    try {
      writeFileSync(join(f.cwd, "AGENTS.md"), "parent instructions");
      if (kind === "dangling") symlinkSync(join(f.home, "absent"), join(nested, ".git"));
      else writeFileSync(join(nested, ".git"), "not a Git pointer");
      expect(() => f.adapter.validateRunRequest({ ...f.request, cwd: nested })).toThrow(join(f.cwd, "AGENTS.md"));
    } finally { f.cleanup(); }
  });

  test("a valid Git pointer ends the instruction walk", () => {
    const f = fixture();
    const nested = join(f.cwd, "nested"); mkdirSync(nested);
    try {
      writeFileSync(join(f.cwd, "AGENTS.md"), "parent instructions");
      writeFileSync(join(nested, ".git"), "\uFEFF gitdir: ../control\n");
      expect(() => f.adapter.validateRunRequest({ ...f.request, cwd: nested })).not.toThrow();
    } finally { f.cleanup(); }
  });
});

test("Kimi home canary plants home instructions and shares login", () => {
  const f = fixture();
  const canary = plantKimiCanary({ HOME: f.home });
  try {
    expect(existsSync(join(canary.cwd, "AGENTS.md"))).toBe(false);
    expect(readFileSync(join(canary.brandHome, "AGENTS.md"), "utf8")).toContain(canary.marker);
    expect(readFileSync(join(canary.operatorHome, ".agents", "AGENTS.md"), "utf8")).toContain(canary.marker);
    expect(realpathSync(join(canary.brandHome, "credentials"))).toBe(realpathSync(join(f.brand, "credentials")));
  } finally { canary.cleanup(); expect(existsSync(canary.cwd)).toBe(false); f.cleanup(); }
});

test.each([{ flags: [] }, { flags: ["--tools", "none"] }])("Kimi check canary pair uses the same tools $flags", async ({ flags }) => {
  const f = fixture();
  const log = join(f.home, "canary.jsonl");
  const script = join(f.home, "shim.ts");
  writeFileSync(script, `import {appendFileSync, existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.3.2"); process.exit(0); }
const brand = process.env.KIMI_CODE_HOME;
const privateRun = args.includes("--skills-dir");
const agent = args.includes("--agent-file") ? readFileSync(args[args.indexOf("--agent-file") + 1], "utf8") : "";
if (!brand || !existsSync(join(brand,"credentials","kimi.json"))) process.exit(7);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({privateRun, toolsNone:agent.includes("tools: []"), home:process.env.HOME, brand, cwd:process.cwd(), overrides: ${JSON.stringify(KIMI_HERMETIC_ENV_OMISSIONS)}.map(name => process.env[name] ?? null)}) + "\\n");
const answer = existsSync(join(brand,"AGENTS.md")) ? readFileSync(join(brand,"AGENTS.md"), "utf8").match(/CODEMUX-CANARY-[A-Z0-9]+/)[0] : "OK";
console.log("• " + answer + "\\n");`);
  const fake = createFakeBinaryEnv({ kimi: `exec bun '${script}' "$@"`,
    scode: `[ "$HOME" = '${f.home}' ] || exit 9
while [ "$1" != "--" ]; do shift; done; shift
case "$1" in */env|env) [ "$2" = -u ] || exit 10 ;; */kimi|kimi) ;; *) exit 11 ;; esac
exec "$@"` });
  try {
    const result = await runCli(["check", "-a", "kimi", "--hermetic", "--pass-env", KIMI_HERMETIC_ENV_OMISSIONS.join(","), ...flags],
      { ...fake.env, HOME: f.home, ...Object.fromEntries(KIMI_HERMETIC_ENV_OMISSIONS.map((name) => [name, "operator"])) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("HERMETIC kimi: OK\n");
    expect(result.stderr).toContain("control: planted code word reached the model");
    const records = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.privateRun)).toEqual([true, false]);
    expect(records.map((record) => record.toolsNone)).toEqual([Boolean(flags.length), Boolean(flags.length)]);
    expect(records[0].overrides).toEqual(KIMI_HERMETIC_ENV_OMISSIONS.map(() => null));
    expect(records[1].overrides).toEqual(KIMI_HERMETIC_ENV_OMISSIONS.map(() => "operator"));
    expect(existsSync(records[0].home)).toBe(false);
    expect(existsSync(records[1].brand)).toBe(false);
    expect(records[1].home).toBe(f.home);
  } finally { fake.cleanup(); f.cleanup(); }
});
