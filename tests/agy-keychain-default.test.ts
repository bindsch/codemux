import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGY_MIRROR_PATH, AGY_TEMPLATE_NAME, agyKeychainHost, agyKeychainStateDir, prepareAgyPrivateKeychain } from "../src/agy-keychain.js";
import { AgyAdapter } from "../src/adapters/agy.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function setup(mode: "private" | "concurrent" | "mirror" | "private-mismatch",
  { initialReadFailures = 0, readBackFailures = 0, unreadableDefault = false,
    unlockFailures = 0, deleteFailure = false, staleTemplate = false } = {}) {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "agy-default-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const homeMock = spyOn(agyKeychainHost, "home").mockReturnValue(home);
  const securityMock = spyOn(agyKeychainHost, "securityPath").mockReturnValue(process.execPath);
  cleanup.push(() => homeMock.mockRestore(), () => securityMock.mockRestore());
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "agy"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const environment = { HOME: home, PATH: bin };
  const privateHome = join(home, ".gemini/.codemux-isolation-probes/run-current");
  const mirror = join(privateHome, AGY_MIRROR_PATH);
  const original = join(home, "original.keychain-db");
  const concurrent = join(home, "operator-selected.keychain-db");
  mkdirSync(agyKeychainStateDir(), { recursive: true });
  writeFileSync(join(agyKeychainStateDir(), AGY_TEMPLATE_NAME), "empty template");
  writeFileSync(join(agyKeychainStateDir(), `${AGY_TEMPLATE_NAME}.password`), "a".repeat(32));
  let realDefault: string | undefined = unreadableDefault ? undefined : original;
  let privateDefault: string | undefined;
  let selectedExistingMirror = false;
  let failedInitialReads = 0;
  let failedReads = 0;
  let failedUnlocks = 0;
  let templatePassword = (staleTemplate ? "b" : "a").repeat(32);
  const unlocked = new Set<string>();
  const calls: { args: string[]; home: string }[] = [];
  const inputs: string[][] = [];
  const result = (stdout = "", exitCode = 0) => ({ stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), exitCode, signalCode: null });
  const spawn = spyOn(agyKeychainHost, "spawnSync").mockImplementation(((command: string[], options: { env: NodeJS.ProcessEnv; stdin: Buffer | "ignore" }) => {
    const args = command.slice(1);
    const callerHome = options.env.HOME!;
    calls.push({ args, home: callerHome });
    const input = Buffer.isBuffer(options.stdin) ? [...options.stdin.toString().matchAll(/"((?:\\.|[^"\\])*)"/g)]
      .map((match) => match[1]!.replace(/\\(.)/g, "$1")) : args;
    inputs.push(input);
    if (input[0] === "create-keychain") {
      writeFileSync(input.at(-1)!, "empty template");
      templatePassword = input[2]!;
    }
    if (input[0] === "unlock-keychain") {
      const keychain = input.at(-1)!;
      unlocked.delete(keychain);
      if (failedUnlocks++ < unlockFailures || input[2] !== templatePassword) return result("synthetic secret detail", 1);
      unlocked.add(keychain);
    }
    if (["set-keychain-settings", "add-generic-password"].includes(input[0]!) && !unlocked.has(input.at(-1)!)) {
      return result("synthetic secret detail", 1);
    }
    if (input[0] === "delete-generic-password" && deleteFailure) return result("synthetic secret detail", 1);
    if (args[0] === "find-generic-password") return result("synthetic token\n");
    if (args[0] === "list-keychains") return result(`"${original}"\n`);
    if (args[0] !== "default-keychain") return result();
    if (args.includes("-s")) {
      if (callerHome !== home) {
        selectedExistingMirror = existsSync(args.at(-1)!);
        privateDefault = mode === "private-mismatch" ? original : args.at(-1)!;
        if (mode === "concurrent") realDefault = concurrent;
        if (mode === "mirror") realDefault = mirror;
      } else {
        realDefault = args.at(-1)!;
      }
      return result();
    }
    if (callerHome === home && !privateDefault && failedInitialReads < initialReadFailures) {
      failedInitialReads++;
      return result("", 1);
    }
    if (callerHome === home && privateDefault && failedReads < readBackFailures) {
      failedReads++;
      return result("", 1);
    }
    if (callerHome === home && realDefault === undefined) return result("", 1);
    return result(`"${callerHome === home ? realDefault : privateDefault}"\n`);
  }) as unknown as typeof Bun.spawnSync);
  cleanup.push(() => spawn.mockRestore());
  return { home, privateHome, mirror, original, concurrent, environment, calls, inputs, current: () => realDefault,
    selectedMirror: () => privateDefault, selectedExistingMirror: () => selectedExistingMirror };
}

test.each(["GEMINI_API_KEY", "GOOGLE_API_KEY", "file", "keychain"].flatMap((source) =>
  [false, true].map((staleTemplate) => ({ source, staleTemplate }))))(
  "$source authentication verifies the copy before selecting credentials; stale template=$staleTemplate", ({ source, staleTemplate }) => {
    const state = setup("private", { staleTemplate });
    const environment: NodeJS.ProcessEnv = { ...state.environment };
    if (source === "file") {
      const directory = join(state.home, ".gemini/antigravity-cli");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "antigravity-oauth-token"), "synthetic file token");
    } else if (source !== "keychain") environment[source] = "synthetic API key";
    const adapter = new AgyAdapter(environment);
    const context = adapter.prepareRun({ agent: "agy", prompt: "unused", sandboxed: true });
    cleanup.push(() => adapter.cleanupRun(context));
    const home = context.agyProbe!.home!;
    const mirror = join(home, AGY_MIRROR_PATH);
    expect(readFileSync(mirror, "utf8")).toBe("empty template");
    expect(state.current()).toBe(state.original);
    expect(state.calls.filter((call) => call.args[0] === "default-keychain")).toEqual([
      { home: state.home, args: ["default-keychain", "-d", "user"] },
      { home, args: ["default-keychain", "-d", "user", "-s", mirror] },
      { home: state.home, args: ["default-keychain", "-d", "user"] },
      { home, args: ["default-keychain", "-d", "user"] },
    ]);
    const unlocks = state.inputs.filter((args) => args[0] === "unlock-keychain");
    expect(unlocks[0]).toEqual(["unlock-keychain", "-p", "a".repeat(32), mirror]);
    expect(unlocks).toHaveLength(staleTemplate ? 2 : 1);
    const creations = state.inputs.filter((args) => args[0] === "create-keychain");
    expect(creations).toHaveLength(staleTemplate ? 1 : 0);
    if (staleTemplate) expect(unlocks[1]).toEqual(["unlock-keychain", "-p", creations[0]![2]!, mirror]);
    expect(state.inputs.filter((args) => args[0] === "set-keychain-settings"))
      .toEqual(Array.from({ length: staleTemplate ? 2 : 1 }, () => ["set-keychain-settings", mirror]));
    const probe = ["add-generic-password", "-s", "codemux-usability-probe", "-a", "probe",
      "-w", expect.stringMatching(/^[a-f0-9]{32}$/), mirror];
    expect(state.inputs.filter((args) => args[2] === "codemux-usability-probe"))
      .toEqual([probe,
        ["delete-generic-password", "-s", "codemux-usability-probe", "-a", "probe", mirror]]);
    const probeIndex = state.inputs.findIndex((args) => args[2] === "codemux-usability-probe");
    expect(state.calls[probeIndex]!.args).toEqual(["-i"]);
    expect(probeIndex)
      .toBeGreaterThan(state.inputs.findIndex((args) => args[0] === "set-keychain-settings"));
    expect(state.inputs.findIndex((args) => args[0] === "default-keychain"))
      .toBeGreaterThan(state.inputs.findIndex((args) => args[0] === "delete-generic-password"));
    expect(state.inputs.filter((args) => args[0] === "find-generic-password")).toHaveLength(source === "keychain" ? 1 : 0);
    expect(state.inputs.filter((args) => args[0] === "add-generic-password" && args[2] === "gemini"))
      .toHaveLength(source === "keychain" ? 1 : 0);
    if (source === "keychain") {
      expect(state.inputs.findIndex((args) => args[0] === "find-generic-password"))
        .toBeGreaterThan(state.inputs.findLastIndex((args) => args[0] === "default-keychain"));
    }
  });

test("a stale template rebuilds after settings fail on the locked copy", () => {
  const state = setup("private", { staleTemplate: true });
  const password = prepareAgyPrivateKeychain(state.privateHome, state.environment)!;
  expect(password).toMatch(/^[a-f0-9]{32}$/);
  expect(password).not.toBe("a".repeat(32));
  expect(password).not.toBe("b".repeat(32));
  expect(state.inputs.map((args) => args[0]).filter((command) =>
    ["unlock-keychain", "set-keychain-settings", "create-keychain", "add-generic-password", "delete-generic-password"].includes(command!)))
    .toEqual([
      "unlock-keychain", "set-keychain-settings", "create-keychain",
      "unlock-keychain", "set-keychain-settings", "add-generic-password", "delete-generic-password",
    ]);
  expect(state.inputs.filter((args) => args[0] === "create-keychain"))
    .toEqual([["create-keychain", "-p", password, join(agyKeychainStateDir(), AGY_TEMPLATE_NAME)]]);
  expect(state.inputs.filter((args) => args[0] === "unlock-keychain"))
    .toEqual([["unlock-keychain", "-p", "a".repeat(32), state.mirror], ["unlock-keychain", "-p", password, state.mirror]]);
  expect(readFileSync(join(agyKeychainStateDir(), `${AGY_TEMPLATE_NAME}.password`), "utf8")).toBe(password);
  expect(state.selectedMirror()).toBe(state.mirror);
  expect(state.current()).toBe(state.original);
});

test.each([1, 2])("private keychain usability retries once after %s locked copies", (unlockFailures) => {
  const state = setup("private", { unlockFailures });
  if (unlockFailures === 1) {
    expect(prepareAgyPrivateKeychain(state.privateHome, state.environment)).toMatch(/^[a-f0-9]{32}$/);
    expect(state.selectedMirror()).toBe(state.mirror);
  } else {
    expect(() => prepareAgyPrivateKeychain(state.privateHome, state.environment))
      .toThrow("cannot prepare agy private keychain");
    expect(state.calls.some((call) => call.args[0] === "default-keychain")).toBe(false);
  }
  expect(state.inputs.filter((args) => args[0] === "add-generic-password")).toHaveLength(unlockFailures === 1 ? 1 : 0);
  expect(state.inputs.filter((args) => args[0] === "delete-generic-password")).toHaveLength(unlockFailures === 1 ? 1 : 0);
  const creations = state.inputs.filter((args) => args[0] === "create-keychain");
  expect(creations).toHaveLength(1);
  const password = creations[0]![2]!;
  expect(password).toMatch(/^[a-f0-9]{32}$/);
  expect(password).not.toBe("a".repeat(32));
  expect(state.inputs.filter((args) => args[0] === "unlock-keychain"))
    .toEqual([["unlock-keychain", "-p", "a".repeat(32), state.mirror], ["unlock-keychain", "-p", password, state.mirror]]);
  expect(state.inputs.filter((args) => args[0] === "set-keychain-settings"))
    .toEqual(Array.from({ length: 2 }, () => ["set-keychain-settings", state.mirror]));
  expect(readFileSync(join(agyKeychainStateDir(), `${AGY_TEMPLATE_NAME}.password`), "utf8")).toBe(password);
  expect(readFileSync(state.mirror, "utf8")).toBe("empty template");
  expect(state.current()).toBe(state.original);
});

test("failed usability probe deletion refuses preparation without rebuilding", () => {
  const state = setup("private", { deleteFailure: true });
  expect(() => prepareAgyPrivateKeychain(state.privateHome, state.environment))
    .toThrow("cannot prepare agy private keychain");
  expect(state.inputs.filter((args) => args[0] === "add-generic-password")).toHaveLength(1);
  expect(state.inputs.filter((args) => args[0] === "delete-generic-password")).toHaveLength(1);
  expect(state.inputs.some((args) => ["create-keychain", "default-keychain"].includes(args[0]!))).toBe(false);
});

test("unsandboxed runs do not prepare a private keychain or select credentials", () => {
  const state = setup("private");
  expect(new AgyAdapter(state.environment).prepareRun({ agent: "agy", prompt: "unused", sandboxed: false })).toEqual({});
  expect(state.inputs).toEqual([["list-keychains", "-d", "user"]]);
  expect(existsSync(state.mirror)).toBe(false);
});

test("private mirror selection preserves the real default and reads both defaults back", () => {
  const state = setup("private");
  expect(() => prepareAgyPrivateKeychain(state.privateHome, state.environment)).not.toThrow();
  expect(state.current()).toBe(state.original);
  expect(state.calls.filter((call) => call.args[0] === "default-keychain")).toEqual([
    { home: state.home, args: ["default-keychain", "-d", "user"] },
    { home: state.privateHome, args: ["default-keychain", "-d", "user", "-s", state.mirror] },
    { home: state.home, args: ["default-keychain", "-d", "user"] },
    { home: state.privateHome, args: ["default-keychain", "-d", "user"] },
  ]);
});

test("private mirror selection refuses a mismatched private default", () => {
  const state = setup("private-mismatch");
  expect(() => prepareAgyPrivateKeychain(state.privateHome, state.environment))
    .toThrow("agy keychain mirror is not the private HOME's default keychain");
  expect(state.current()).toBe(state.original);
  expect(state.calls.filter((call) => call.home === state.home && call.args[0] === "default-keychain" && call.args.includes("-s"))).toEqual([]);
});

test("a failed initial real-default read retries before private mirror selection", () => {
  const state = setup("private", { initialReadFailures: 1 });
  const warning = spyOn(console, "error").mockImplementation(() => {});
  cleanup.push(() => warning.mockRestore());
  expect(() => prepareAgyPrivateKeychain(state.privateHome, state.environment))
    .not.toThrow();
  expect(state.current()).toBe(state.original);
  expect(state.selectedMirror()).toBe(state.mirror);
  expect(state.selectedExistingMirror()).toBe(true);
  expect(state.calls.filter((call) => call.args[0] === "default-keychain")).toEqual([
    { home: state.home, args: ["default-keychain", "-d", "user"] },
    { home: state.home, args: ["default-keychain", "-d", "user"] },
    { home: state.privateHome, args: ["default-keychain", "-d", "user", "-s", state.mirror] },
    { home: state.home, args: ["default-keychain", "-d", "user"] },
    { home: state.privateHome, args: ["default-keychain", "-d", "user"] },
  ]);
  expect(warning).not.toHaveBeenCalled();
});

test.each([false, true])("an unreadable real default skips private selection with one warning; login exists=%s", (loginExists) => {
  const state = setup("mirror", { unreadableDefault: true });
  const warning = spyOn(console, "error").mockImplementation(() => {});
  cleanup.push(() => warning.mockRestore());
  const login = join(state.home, AGY_MIRROR_PATH);
  if (loginExists) {
    mkdirSync(join(state.home, "Library/Keychains"), { recursive: true });
    writeFileSync(login, "real login keychain");
  }
  expect(() => prepareAgyPrivateKeychain(state.privateHome, state.environment)).not.toThrow();
  expect(existsSync(state.mirror)).toBe(true);
  expect(state.selectedMirror()).toBeUndefined();
  expect(state.selectedExistingMirror()).toBe(false);
  expect(state.current()).toBeUndefined();
  expect(state.calls.every((call) => call.home === state.home)).toBe(true);
  expect(state.calls.filter((call) => call.args[0] === "default-keychain"))
    .toEqual(Array.from({ length: 2 }, () => ({ home: state.home, args: ["default-keychain", "-d", "user"] })));
  expect(warning.mock.calls).toEqual([["codemux: no readable default keychain; agy may prompt to store its token"]]);
});

test("an unreadable real default allows run preparation and cleanup", () => {
  const state = setup("private", { unreadableDefault: true });
  const warning = spyOn(console, "error").mockImplementation(() => {});
  cleanup.push(() => warning.mockRestore());
  const cwd = join(state.home, "work");
  mkdirSync(cwd);
  const adapter = new AgyAdapter(state.environment);
  const context = adapter.prepareRun({ agent: "agy", prompt: "unused", cwd, sandboxed: true, autonomy: "read-only" });
  cleanup.push(() => adapter.cleanupRun(context));
  expect(existsSync(join(context.agyProbe!.home!, AGY_MIRROR_PATH))).toBe(true);
  adapter.cleanupRun(context);
  expect(readdirSync(join(state.home, ".gemini/.codemux-isolation-probes"))).toEqual([]);
  expect(state.current()).toBeUndefined();
  expect(state.calls.every((call) => call.home === state.home)).toBe(true);
  expect(state.calls.filter((call) => call.args[0] === "default-keychain"))
    .toEqual(Array.from({ length: 2 }, () => ({ home: state.home, args: ["default-keychain", "-d", "user"] })));
  expect(warning.mock.calls).toEqual([["codemux: no readable default keychain; agy may prompt to store its token"]]);
});

test("a concurrent operator default survives private mirror selection", () => {
  const state = setup("concurrent");
  expect(() => prepareAgyPrivateKeychain(state.privateHome, state.environment)).not.toThrow();
  expect(state.current()).toBe(state.concurrent);
  expect(state.calls.filter((call) => call.home === state.home && call.args[0] === "default-keychain" && call.args.includes("-s"))).toEqual([]);
});

test.each([0, 1])("private selection restores only this run's mirror after %s failed reads", (readBackFailures) => {
  const state = setup("mirror", { readBackFailures });
  expect(() => prepareAgyPrivateKeychain(state.privateHome, state.environment))
    .toThrow("agy keychain mirror changed the user's default keychain; restored");
  expect(state.current()).toBe(state.original);
  expect(state.calls.filter((call) => call.home === state.home && call.args[0] === "default-keychain" && call.args.includes("-s")))
    .toEqual([{ home: state.home, args: ["default-keychain", "-d", "user", "-s", state.original] }]);
});

test.each(["private", "concurrent"] as const)("a failed real-default read-back retries without overwriting %s selection", (mode) => {
  const state = setup(mode, { readBackFailures: 1 });
  expect(() => prepareAgyPrivateKeychain(state.privateHome, state.environment)).not.toThrow();
  expect(state.current()).toBe(mode === "concurrent" ? state.concurrent : state.original);
  expect(state.calls.filter((call) => call.home === state.home && call.args[0] === "default-keychain"))
    .toEqual(Array.from({ length: 3 }, () => ({ home: state.home, args: ["default-keychain", "-d", "user"] })));
});

test.each(["private", "concurrent"] as const)("two failed real-default reads refuse without overwriting %s selection", (mode) => {
  const state = setup(mode, { readBackFailures: 2 });
  const cwd = join(state.home, "work");
  mkdirSync(cwd);
  const adapter = new AgyAdapter(state.environment);
  let error: unknown;
  try { adapter.prepareRun({ agent: "agy", prompt: "unused", cwd, sandboxed: true, autonomy: "read-only" }); }
  catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("real default keychain could not be verified after the private selection");
  expect(state.current()).toBe(mode === "concurrent" ? state.concurrent : state.original);
  expect(state.calls.filter((call) => call.home === state.home && call.args[0] === "default-keychain"))
    .toEqual(Array.from({ length: 3 }, () => ({ home: state.home, args: ["default-keychain", "-d", "user"] })));
  expect(state.selectedExistingMirror()).toBe(true);
  expect(existsSync(state.selectedMirror()!)).toBe(false);
  expect(readdirSync(join(state.home, ".gemini/.codemux-isolation-probes"))).toEqual([]);
});
