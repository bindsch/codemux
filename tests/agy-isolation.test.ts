import { afterEach, expect, spyOn, test } from "bun:test";
import { AGY_MIRROR_PATH } from "../src/agy-keychain.js";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { AgyAdapter, markAgyIsolationProbe } from "../src/adapters/agy.js";
import { summarizeAgyProbe } from "../src/agy-isolation-probe.js";
import { summarizeAgyStream } from "../src/agy-stream.js";
import type { RunRequest } from "../src/types.js";
import { runCli, minimalPath, createFakeBinaryEnv } from "./helpers/cli.js";
import { Command } from "commander";
import { registerCheckCommand } from "../src/check-command.js";
import { getDefaultConfig } from "../src/config.js";
import * as fs from "node:fs";
import { registerRunExitCleanup } from "../src/run-exit-cleanup.js";
import { trackScratchRemoval, untrackScratchRemoval } from "../src/hermetic-canary.js";
import { cleanupAgyIsolation, setup } from "./helpers/agy-isolation-setup.js";

test("an array init is malformed even with a valid result", () => {
  const stdout = JSON.stringify({ event: "init", init: [] }) + "\n" +
    JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "OK" } });
  expect(summarizeAgyStream(stdout).malformed).toBe(true);
});

afterEach(cleanupAgyIsolation);

test.each(["exit", "SIGTERM"])("canary adapter cleanup precedes scratch removal on %s", (event) => {
  const { home, request, adapter } = setup();
  const before = new Set(process.listeners("exit"));
  trackScratchRemoval(home);
  const context = adapter.prepareRun(request);
  const clean = spyOn(adapter, "cleanupRunSync");
  const report = spyOn(console, "error").mockImplementation(() => {});
  const release = registerRunExitCleanup(adapter, context);
  const exitCallbacks = () => {
    for (const listener of process.listeners("exit")) if (!before.has(listener)) listener(143);
  };
  const exit = spyOn(process, "exit").mockImplementation(() => { exitCallbacks(); return undefined as never; });
  try {
    if (event === "exit") exitCallbacks();
    else process.emit("SIGTERM");
    expect(clean).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
    expect(existsSync(home)).toBe(false);
  } finally {
    release();
    untrackScratchRemoval(home);
    exit.mockRestore();
    report.mockRestore();
    clean.mockRestore();
  }
});

test("a failed ownership marker write removes the fresh private home", () => {
  const { adapter, request, home } = setup();
  const original = fs.writeFileSync;
  const write = spyOn(fs, "writeFileSync").mockImplementation(((path, ...args) => {
    if (String(path).endsWith(".codemux-probe-owner")) throw new Error("ENOSPC: marker write failed");
    return original(path, ...args);
  }) as typeof fs.writeFileSync);
  try {
    expect(() => adapter.prepareRun(request)).toThrow("ENOSPC: marker write failed");
    expect(readdirSync(join(home, ".gemini/.codemux-isolation-probes"))).toEqual([]);
  } finally { write.mockRestore(); }
});

test("agy isolation requires scode at every autonomy", () => {
  const { adapter, request } = setup();
  // The full matrix — every autonomy with scode, both isolation flags —
  // lives in tests/sandbox-blocks-agy.test.ts beside the argv tests.
  expect(() => adapter.validateRunRequest({ ...request, hermetic: true })).not.toThrow();
  expect(() => adapter.validateRunRequest({ ...request, tools: "none" })).not.toThrow();
  expect(() => adapter.validateRunRequest({ ...request, hermetic: true, sandboxed: false }))
    .toThrow("agy isolation requires scode (--sandbox) at every autonomy");
});

test("stale sweeping retains live, unknown, and symlinked homes", () => {
  const { adapter, request, home } = setup();
  const root = join(home, ".gemini/.codemux-isolation-probes");
  mkdirSync(root, { recursive: true });
  for (const [name, pid] of [["live", String(process.pid)], ["unknown", "2147483647"], ["invalid", "bad pid"]]) {
    const path = join(root, `run-${name}`);
    mkdirSync(path);
    writeFileSync(join(path, ".codemux-probe-pid"), pid!);
  }
  symlinkSync(join(root, "run-unknown"), join(root, "run-symlink"));
  const realKill = process.kill;
  const kill = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === 2147483647) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    return realKill(pid, signal);
  });
  try {
    const context = adapter.prepareRun(request);
    adapter.cleanupRun(context);
    expect(readdirSync(root).sort()).toEqual(["run-invalid", "run-live", "run-symlink", "run-unknown"]);
  } finally { kill.mockRestore(); }
});

test("a probe home with an unreadable owner pid is swept only once its pid file is old (review rounds 115, 116)", () => {
  const { adapter, request, home } = setup(); // The agy child can rewrite the pid file: unreadable is not dead.
  const root = join(home, ".gemini/.codemux-isolation-probes");
  for (const [name, owner, ageMs] of [["fresh-range", "4294967297", 0], ["fresh-bad", "bad pid", 0], ["old-range", "4294967297", 3 * 86_400_000], ["old-bad", "", 3 * 86_400_000]] as const) {
    mkdirSync(join(root, `run-${name}`), { recursive: true });
    writeFileSync(join(root, `run-${name}`, ".codemux-probe-owner"), crypto.randomUUID());
    writeFileSync(join(root, `run-${name}`, ".codemux-probe-pid"), owner);
    fs.utimesSync(join(root, `run-${name}`, ".codemux-probe-pid"), new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
  }
  adapter.cleanupRun(adapter.prepareRun(request));
  expect(readdirSync(root).filter((name) => /^run-(fresh|old)-/.test(name)).sort()).toEqual(["run-fresh-bad", "run-fresh-range"]);
});

test("a concurrent stale-home removal does not refuse the next launch", () => {
  const { adapter, request, home } = setup();
  const stale = join(home, ".gemini/.codemux-isolation-probes/run-stale");
  mkdirSync(stale, { recursive: true });
  const pid = join(stale, ".codemux-probe-pid");
  writeFileSync(join(stale, ".codemux-probe-owner"), crypto.randomUUID());
  writeFileSync(pid, "2147483647");
  const read = fs.readFileSync;
  const concurrent = spyOn(fs, "readFileSync").mockImplementation(((path, ...args) => {
    if (String(path) === pid) rmSync(stale, { recursive: true });
    return read(path, ...args);
  }) as typeof fs.readFileSync);
  try {
    const context = adapter.prepareRun(request);
    adapter.cleanupRun(context);
    expect(existsSync(stale)).toBe(false);
  } finally { concurrent.mockRestore(); }
});

test("agy session cleanup tolerates an absent run context", () => {
  expect(() => new AgyAdapter({}).cleanupRun()).not.toThrow();
});

test("agy session environment lookup still accepts an absent run context", () => {
  const { adapter, request } = setup();
  expect(adapter.getRunEnv(request)).toEqual({});
});

test("private HOME carries only login material and codemux deny settings", () => {
  const { adapter, request, home, keychainCalls } = setup(false);
  const realState = join(home, ".gemini/antigravity-cli");
  mkdirSync(realState, { recursive: true });
  writeFileSync(join(realState, "antigravity-oauth-token"), "fake-login");
  writeFileSync(join(realState, "settings.json"), '{"operator":"CANARY"}');
  writeFileSync(join(home, ".gemini/GEMINI.md"), "CANARY");
  markAgyIsolationProbe(request, "tools");
  adapter.validateRunRequest(request);
  const context = adapter.prepareRun(request);
  const privateHome = context.agyProbe!.home!;
  expect(readFileSync(join(privateHome, AGY_MIRROR_PATH), "utf8")).toBe("empty template");
  expect(keychainCalls).toContainEqual({ home: privateHome, input: "",
    args: ["default-keychain", "-d", "user", "-s", join(privateHome, AGY_MIRROR_PATH)] });
  expect(keychainCalls.some((call) => call.args[0] === "find-generic-password" || call.input.startsWith('"add-generic-password" "-s" "gemini"'))).toBe(false);
  const privateState = join(privateHome, ".gemini/antigravity-cli");
  expect(readdirSync(privateState).sort()).toEqual(["antigravity-oauth-token", "settings.json"]);
  expect(readFileSync(join(privateState, "antigravity-oauth-token"), "utf8")).toBe("fake-login");
  expect(readFileSync(join(privateState, "settings.json"), "utf8")).not.toContain("CANARY");
  expect(JSON.parse(readFileSync(join(privateState, "settings.json"), "utf8")).permissions.deny).toContain("read_file(*)");
  expect(existsSync(join(privateHome, ".gemini/GEMINI.md"))).toBe(false);
  const cmd = adapter.buildRunCommand(request, context);
  expect(cmd[0]).toBe("env");
  expect(cmd).toContain(`HOME=${privateHome}`);
  expect(cmd.filter((arg) => arg.startsWith("--"))).toEqual([
    "--disable-slash-commands", "--mode=plan", "--output-format=stream-json", "--input-format=stream-json",
  ]);
  // The prompt rides stdin as one stream-json user frame, never argv.
  expect(cmd).not.toContain("probe");
  expect(adapter.getStdinInput(request)).toBe(`${JSON.stringify({ event: "user", message: { content: "probe" } })}\n`);
  expect(cmd).toContain("--mode=plan");
  expect(cmd).toContain("--output-format=stream-json");
  expect(adapter.buildExecutionEnv().HOME).not.toBe(privateHome);
  adapter.cleanupRun(context);
  expect(existsSync(privateHome)).toBe(false);
  expect(readFileSync(join(realState, "antigravity-oauth-token"), "utf8")).toBe("fake-login");
});

test("a private home works without a file credential, preserving the Keychain login path", () => {
  const { adapter, request } = setup();
  markAgyIsolationProbe(request, "hermetic");
  const context = adapter.prepareRun(request);
  expect(readdirSync(join(context.agyProbe!.home!, ".gemini/antigravity-cli"))).toEqual([]);
  adapter.cleanupRun(context);
});

test("unverified diagnostics cannot loosen scode or accept public capability flags", () => {
  const { request } = setup();
  for (const change of [{ sandboxed: false }, { autonomy: "high" }, { hermetic: true }, { tools: "none" }]) {
    expect(() => markAgyIsolationProbe({ ...request, ...change } as RunRequest, "tools")).toThrow("plain read-only");
  }
});

test("controls get their own clean HOME", () => {
  const { adapter, request } = setup();
  markAgyIsolationProbe(request, "control");
  const context = adapter.prepareRun(request);
  const cmd = adapter.buildRunCommand(request, context);
  expect(cmd[0]).toBe("env");
  expect(cmd).toContain(`HOME=${context.agyProbe!.home}`);
  expect(lstatSync(join(context.agyProbe!.home!, ".gemini")).isSymbolicLink()).toBe(false);
  adapter.cleanupRun(context);
});

test("project executable configuration remains refused, including on a probe", () => {
  const { adapter, request } = setup();
  mkdirSync(join(request.cwd!, ".agents/rules"), { recursive: true });
  writeFileSync(join(request.cwd!, ".agents/rules/canary.md"), "CANARY");
  markAgyIsolationProbe(request, "hermetic");
  expect(() => adapter.validateRunRequest(request)).toThrow(join(request.cwd!, ".agents"));
});

test("symlinked token files are refused without leaving a private home", () => {
  const { adapter, request, home } = setup(false);
  const state = join(home, ".gemini/antigravity-cli");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(home, "target"), "fake-login");
  symlinkSync(join(home, "target"), join(state, "antigravity-oauth-token"));
  markAgyIsolationProbe(request, "hermetic");
  expect(() => adapter.prepareRun(request)).toThrow("must not be a symbolic link");
  expect(readdirSync(join(home, ".gemini/.codemux-isolation-probes"))).toEqual([]);
});

test("tool detection uses native inventory and step types, never assistant claims", () => {
  const summary = summarizeAgyProbe([
    { event: "init", init: { tools: ["run_command"] } },
    { event: "step_update", step_update: { step_type: "run_command" } },
    { event: "result", result: { response: "NO_TOOLS" } },
  ].map((frame) => JSON.stringify(frame)).join("\n"));
  expect(summary).toMatchObject({ tools: ["run_command"], stepTypes: ["run_command"], possibleToolActivity: true, malformed: false });
  expect(summarizeAgyProbe('{"event":"new_event"}').malformed).toBe(true);
  expect(summarizeAgyProbe("bad json").malformed).toBe(true);
});

test("CLI refuses the diagnostic without its exact safety constraints", async () => {
  const result = await runCli(["check", "-a", "agy", "--agy-isolation-probe", "tools", "--no-sandbox"], { PATH: minimalPath() });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("default scode");
});

test("cleanup refuses a replaced parent even when the run basename exists", () => {
  const { adapter, request, home } = setup();
  markAgyIsolationProbe(request, "hermetic");
  const context = adapter.prepareRun(request);
  const privateHome = context.agyProbe!.home!;
  const parent = dirname(privateHome);
  const unrelated = join(home, "unrelated");
  mkdirSync(join(unrelated, basename(privateHome)), { recursive: true });
  const keep = join(unrelated, basename(privateHome), "keep");
  writeFileSync(keep, "unrelated data");
  renameSync(parent, `${parent}-original`);
  symlinkSync(unrelated, parent);
  expect(() => adapter.cleanupRun(context)).toThrow("replaced agy probe");
  expect(readFileSync(keep, "utf8")).toBe("unrelated data");
});

test("cleanup requires the run's ownership marker and original directory", () => {
  const { adapter, request } = setup();
  markAgyIsolationProbe(request, "hermetic");
  const context = adapter.prepareRun(request);
  const privateHome = context.agyProbe!.home!;
  writeFileSync(join(privateHome, ".codemux-probe-owner"), "different run");
  expect(() => adapter.cleanupRun(context)).toThrow("replaced agy probe");
  expect(existsSync(privateHome)).toBe(true);
  expect(() => adapter.cleanupRun({ agyProbe: { mode: "hermetic", home: privateHome } })).toThrow("unowned");
});

test.each(["home", "parent"])("cleanup finds a renamed probe %s by inode when the original path is absent", (renamed) => {
  const { adapter, request, home } = setup(false);
  const state = join(home, ".gemini/antigravity-cli");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "antigravity-oauth-token"), "synthetic-token");
  markAgyIsolationProbe(request, "hermetic");
  const context = adapter.prepareRun(request);
  const privateHome = context.agyProbe!.home!;
  const original = renamed === "home" ? privateHome : dirname(privateHome);
  const moved = `${original}-renamed`;
  renameSync(original, moved);
  const movedHome = renamed === "home" ? moved : join(moved, basename(privateHome));
  expect(existsSync(privateHome)).toBe(false);
  expect(readFileSync(join(movedHome, ".gemini/antigravity-cli/antigravity-oauth-token"), "utf8"))
    .toBe("synthetic-token");
  adapter.cleanupRun(context);
  expect(existsSync(movedHome)).toBe(false);
  expect(() => adapter.cleanupRun(context)).not.toThrow();
});

test("a credential copy lasts for the probe and any cleanup refusal names it", () => {
  const { adapter, request, home } = setup(false);
  const state = join(home, ".gemini/antigravity-cli");
  mkdirSync(state, { recursive: true });
  const token = join(state, "antigravity-oauth-token");
  writeFileSync(token, "synthetic-token");
  markAgyIsolationProbe(request, "hermetic");
  const context = adapter.prepareRun(request);
  const privateHome = context.agyProbe!.home!;
  const copy = join(privateHome, ".gemini/antigravity-cli/antigravity-oauth-token");
  expect(lstatSync(copy).mode & 0o777).toBe(0o600);
  expect(lstatSync(copy).ino).not.toBe(lstatSync(token).ino);
  rmSync(join(privateHome, ".codemux-probe-owner"));
  expect(() => adapter.cleanupRun(context)).toThrow(`token copy may remain at ${copy}`);
  expect(() => adapter.cleanupRun(context)).toThrow(`token copy may remain at ${copy}`);
  expect(readFileSync(token, "utf8")).toBe("synthetic-token");
});

test("a probe home moved outside its parent makes the diagnostic exit nonzero with a token warning", async () => {
  const { home } = setup();
  const state = join(home, ".gemini/antigravity-cli");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "antigravity-oauth-token"), "synthetic-token");
  const fake = createFakeBinaryEnv({
    agy: `if [ "$1" = "--version" ]; then printf '1.3.2\\n'; exit 0; fi
/bin/mv "$HOME" "$HOME/../../escaped-probe"
printf '%s\\n' '{"event":"result","result":{"status":"OK","response":"OK"}}'`,
    scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
  });
  try {
    const result = await runCli(["check", "-a", "agy", "--agy-isolation-probe", "hermetic"], { ...fake.env, HOME: home });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("cannot be found");
    expect(result.stderr).toContain("token copy may remain at");
    expect(result.stderr).toContain("antigravity-oauth-token");
    expect(readFileSync(join(state, "antigravity-oauth-token"), "utf8"))
      .toBe("synthetic-token");
  } finally { fake.cleanup(); }
});

test("file token copies isolate in-place and replacement rotations from the real login", () => {
  const { adapter, request, home } = setup(false);
  const state = join(home, ".gemini/antigravity-cli");
  mkdirSync(state, { recursive: true });
  const token = join(state, "antigravity-oauth-token");
  writeFileSync(token, "fake-original");
  markAgyIsolationProbe(request, "hermetic");
  const context = adapter.prepareRun(request);
  const privateToken = join(context.agyProbe!.home!, ".gemini/antigravity-cli/antigravity-oauth-token");
  expect(lstatSync(privateToken).isFile()).toBe(true);
  expect(lstatSync(privateToken).mode & 0o777).toBe(0o600);
  writeFileSync(privateToken, "fake-in-place-refresh");
  expect(readFileSync(token, "utf8")).toBe("fake-original");
  const replacement = join(context.agyProbe!.home!, "replacement");
  writeFileSync(replacement, "fake-refreshed", { mode: 0o600 });
  renameSync(replacement, privateToken);
  expect(readFileSync(privateToken, "utf8")).toBe("fake-refreshed");
  adapter.cleanupRun(context);
  expect(existsSync(context.agyProbe!.home!)).toBe(false);
  expect(readFileSync(token, "utf8")).toBe("fake-original");
});

test("agy diagnostic resolves configured model aliases before launch", async () => {
  const { home } = setup();
  const capture = join(home, "argv.log");
  const resultEvent = [JSON.stringify({ event: "init", init: { tools: [] } }),
    JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "OK",
      usage: { input_tokens: 1, output_tokens: 1 } } })].join("\n");
  const fake = createFakeBinaryEnv({
    agy: `printf '%s\\n' "$@" >> ${JSON.stringify(capture)}; printf '%s\\n' '${resultEvent}'`,
    scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
  });
  const previousPath = process.env.PATH;
  const previousKey = process.env.GEMINI_API_KEY;
  const previousCwd = process.cwd();
  const previousExit = process.exitCode;
  try {
    process.env.PATH = fake.env.PATH;
    process.env.GEMINI_API_KEY = fake.env.GEMINI_API_KEY;
    process.chdir(home);
    const config = getDefaultConfig();
    config.models.fast = { agy: "gemini-3.1-pro" };
    const program = new Command();
    registerCheckCommand(program, config, () => {});
    await program.parseAsync(["check", "-a", "agy", "--agy-isolation-probe", "login", "-m", "fast"], { from: "user" });
    expect(process.exitCode).toBe(0);
    // The probe directory is scratch, removed when the probe ends, so the
    // fake agy records the argv it received instead.
    const argv = readFileSync(capture, "utf8");
    expect(argv).toContain("--model=gemini-3.1-pro");
    expect(argv).not.toContain("--model=fast");
  } finally {
    process.env.PATH = previousPath;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previousKey;
    process.chdir(previousCwd);
    process.exitCode = previousExit;
    fake.cleanup();
  }
});

test("the agy probe plants under the temp root and removes its directory when the run fails", async () => {
  const { home } = setup();
  const fake = createFakeBinaryEnv({
    agy: "printf 'partial output'; exit 3",
    scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
  });
  const prefix = ".codemux-agy-check-";
  const stale = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)));
  const previousPath = process.env.PATH;
  const previousKey = process.env.GEMINI_API_KEY;
  const previousCwd = process.cwd();
  const previousExit = process.exitCode;
  try {
    process.env.PATH = fake.env.PATH;
    process.env.GEMINI_API_KEY = fake.env.GEMINI_API_KEY;
    process.chdir(home);
    const config = getDefaultConfig();
    const program = new Command();
    registerCheckCommand(program, config, () => {});
    await program.parseAsync(["check", "-a", "agy", "--agy-isolation-probe", "login"], { from: "user" });
    expect(process.exitCode).not.toBe(0);
    // Nothing planted in the invoking directory, nothing left in the temp
    // root: the probe's scratch is removed on failure too.
    expect(readdirSync(home).filter((name) => name.startsWith(prefix))).toEqual([]);
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith(prefix) && !stale.has(name))).toEqual([]);
  } finally {
    process.env.PATH = previousPath;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previousKey;
    process.chdir(previousCwd);
    process.exitCode = previousExit;
    fake.cleanup();
  }
});
