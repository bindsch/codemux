import { afterEach, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { markAgyIsolationProbe } from "../src/adapters/agy.js";
import {
  AGY_MIRROR_PATH,
  AGY_TEMPLATE_NAME,
  agyKeychainHost,
  agyKeychainStateDir,
  prepareAgyPrivateKeychain,
} from "../src/agy-keychain.js";
import { productionSecurityPath } from "./fixtures/agy-host.js";
import { runCli } from "./helpers/cli.js";
import { cleanup, item, loginItem, setup } from "./helpers/agy-keychain.js";

afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

test.each([false, true])("parent builds one private mirror; hermetic=%s", (hermetic) => {
  const { home, adapter, request, records, secret, calls, env, originalList } = setup();
  mkdirSync(join(home, ".gemini"));
  writeFileSync(join(home, ".gemini/GEMINI.md"), "operator state");
  // ACL follows the actual executable, including a PATH symlink.
  const agy = Bun.which("agy", { PATH: env.PATH })!;
  const linked = join(home, "bin");
  mkdirSync(linked);
  symlinkSync(agy, join(linked, "agy"));
  env.PATH = `${linked}:${env.PATH}`;
  const run = { ...request, hermetic };
  const context = adapter.prepareRun(run);
  cleanup.push(() => adapter.cleanupRun(context));
  const privateHome = context.agyProbe!.home!;
  const mirror = join(privateHome, AGY_MIRROR_PATH);
  expect(lstatSync(privateHome).mode & 0o777).toBe(0o700);
  expect(lstatSync(mirror).mode & 0o777).toBe(0o600);
  expect(item(mirror)).toBe("one synthetic Antigravity item");
  expect(lstatSync(join(privateHome, "Library/Keychains")).isSymbolicLink()).toBe(false);
  expect(records().map((r) => r.input[0])).toEqual([
    "list-keychains", "list-keychains", "list-keychains", "create-keychain",
    "list-keychains", "list-keychains", "unlock-keychain", "set-keychain-settings", "add-generic-password", "delete-generic-password",
    "default-keychain", "default-keychain", "default-keychain", "default-keychain",
    "find-generic-password", "add-generic-password",
  ]);
  expect(records().find((r) => r.input[0] === "find-generic-password").args).toEqual(["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"]);
  const template = join(agyKeychainStateDir(), AGY_TEMPLATE_NAME);
  const creation = records().find((r) => r.input[0] === "create-keychain");
  const password = creation.input[2];
  expect(creation.input).toEqual(["create-keychain", "-p", expect.stringMatching(/^[a-f0-9]{32}$/), template]);
  expect(creation.args).toEqual(["-i"]);
  expect(JSON.parse(readFileSync(template, "utf8"))).toEqual({ password, unlocked: false, item: "empty" });
  expect(lstatSync(template).mode & 0o777).toBe(0o600);
  expect(lstatSync(`${template}.password`).mode & 0o777).toBe(0o600);
  expect(readFileSync(`${template}.password`, "utf8")).toBe(password);
  expect(records().find((r) => r.args[0] === "list-keychains" && r.args.includes("-s")).args).toEqual(["list-keychains", "-d", "user", "-s", ...originalList]);
  expect(JSON.parse(readFileSync(`${calls}.list`, "utf8"))).toEqual(originalList);
  expect(records().find((r) => r.input[0] === "unlock-keychain").input).toEqual(["unlock-keychain", "-p", password, mirror]);
  expect(records().find((r) => r.input[0] === "set-keychain-settings").input).toEqual(["set-keychain-settings", mirror]);
  const insertion = records().find((r) => r.input[0] === "add-generic-password" && loginItem(r));
  expect(insertion.input).toEqual(["add-generic-password", "-s", "gemini", "-a", "antigravity", "-l", "gemini",
    "-w", secret, "-T", "/usr/bin/security", "-T", realpathSync(agy), mirror]);
  expect(insertion.args).toEqual(["-i"]);
  expect(insertion.stdin).toContain(secret.slice(0, 64));
  expect(records().filter((r) => r.args[0] === "default-keychain").map((r) => ({ args: r.args, home: r.home }))).toEqual([
    { args: ["default-keychain", "-d", "user"], home },
    { args: ["default-keychain", "-d", "user", "-s", mirror], home: privateHome },
    { args: ["default-keychain", "-d", "user"], home },
    { args: ["default-keychain", "-d", "user"], home: privateHome },
  ]);
  expect(records().filter((r) => r.args[0] === "list-keychains" && r.args.includes("-s")).map((r) => r.home)).toEqual([home]);
  expect(records().every((r) => r.home === home ||
    (r.home === privateHome && r.args[0] === "default-keychain"))).toBe(true);
  expect(JSON.stringify(records().map((r) => r.args))).not.toContain(secret.slice(0, 64));
  const state = join(privateHome, ".gemini");
  expect(lstatSync(state).isSymbolicLink()).toBe(false);
  if (hermetic) expect(readdirSync(join(state, "antigravity-cli"))).toEqual([]);
  else expect(realpathSync(join(state, "GEMINI.md"))).toBe(realpathSync(join(home, ".gemini/GEMINI.md")));
  expect(adapter.buildRunCommand(run, context)).toContain(`HOME=${privateHome}`);
  if (!hermetic) {
    // Every agy run is a stream run (adapters/agy.ts: the stdin prompt carrier requires it).
    expect(adapter.buildRunCommand(run, context)).toContain("--output-format=stream-json");
    const stream = '{"event":"init","init":{}}\n{"event":"result","result":{"status":"SUCCESS","response":"OK"}}\n';
    expect(adapter.processRunResult({ stdout: stream, stderr: "", success: true, exitCode: 0 }, run, context).stdout).toBe("OK\n");
  }
  const beforeCleanup = records().length;
  adapter.cleanupRun(context);
  expect(existsSync(privateHome)).toBe(false);
  expect(records().slice(beforeCleanup).every((r) => r.args[0] === "list-keychains")).toBe(true);
  expect(records().at(-1).args).toEqual(["list-keychains", "-d", "user"]);
  expect(readdirSync(join(home, ".gemini/.codemux-isolation-probes"))).toEqual([]);
  expect(readFileSync(join(home, ".gemini/GEMINI.md"), "utf8")).toBe("operator state");
});
test.each(["find-generic-password", "create-keychain", "set-keychain-settings", "probe-add", "delete-generic-password", "add-generic-password"])(
  "security failure at %s is redacted and removes partial mirror", (step) => {
    const { home, adapter, request, secret, records } = setup(step);
    let error: unknown;
    try { adapter.prepareRun(request); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(records().map((r) => r.args))).not.toContain(secret.slice(0, 64));
    if (step === "find-generic-password") expect(String(error)).toContain("agy is not logged in; run `agy` to log in");
    expect(readdirSync(join(home, ".gemini/.codemux-isolation-probes"))).toEqual([]);
  });

test.each(["login", "hermetic", "control", "tools", "tools-control"] as const)("probe %s has a private mirror and clean state", (mode) => {
  const { adapter, request, home, records } = setup();
  const planted = join(home, "planted");
  mkdirSync(planted);
  markAgyIsolationProbe(request, mode, planted);
  const context = adapter.prepareRun(request);
  cleanup.push(() => adapter.cleanupRun(context));
  expect(context.agyProbe!.home).not.toBe(planted);
  expect(lstatSync(join(context.agyProbe!.home!, ".gemini")).isSymbolicLink()).toBe(false);
  expect(existsSync(join(context.agyProbe!.home!, AGY_MIRROR_PATH))).toBe(true);
  expect(records().every((r) => r.home === home ||
    (r.home === context.agyProbe!.home && r.args[0] === "default-keychain"))).toBe(true);
});

test("missing security refuses unauthenticated private HOME; an API key needs no mirror", () => {
  const { adapter, request, env, calls } = setup();
  delete env.CODEMUX_TEST_AGY_SECURITY;
  expect(() => adapter.prepareRun(request)).toThrow("agy is not logged in");
  env.GOOGLE_API_KEY = "synthetic-api-key";
  const context = adapter.prepareRun(request);
  cleanup.push(() => adapter.cleanupRun(context));
  expect(existsSync(join(context.agyProbe!.home!, AGY_MIRROR_PATH))).toBe(false);
  expect(existsSync(calls)).toBe(false);
  const direct = { ...request, sandboxed: false };
  expect(adapter.prepareRun(direct)).toEqual({});
  expect(adapter.buildRunCommand(direct)[0]).toBe("agy");
});

test.each(["", "find-generic-password", "add-generic-password"])("CLI never records the mirror secret, failure=%s", async (fail) => {
  const { env, home, calls, secret, request } = setup(fail);
  const ledger = join(home, "calls.jsonl");
  const result = await runCli(["run", "-a", "agy", "--cwd", request.cwd!, "-p", "OK", "--result-json"],
    { ...env, CODEMUX_CALL_LOG: ledger });
  expect(result.exitCode).toBe(fail ? 1 : 0);
  expect(JSON.stringify(result)).not.toContain(secret.slice(0, 64));
  expect(readFileSync(calls, "utf8")).not.toContain(secret);
  if (fail) {
    expect(result.stdout).toBe("");
    expect(existsSync(ledger)).toBe(false);
    expect(existsSync(join(home, "harness.log"))).toBe(false);
  } else {
    expect(readFileSync(ledger, "utf8")).not.toContain(secret.slice(0, 64));
    expect(JSON.parse(result.stdout).response).toBe("OK");
  }
  expect(readdirSync(join(home, ".gemini/.codemux-isolation-probes"))).toEqual([]);
});

test("native diagnostic recording contains no mirror secret", () => {
  const { adapter, request, secret, home } = setup();
  markAgyIsolationProbe(request, "login");
  const context = adapter.prepareRun(request);
  cleanup.push(() => adapter.cleanupRun(context));
  const stdout = JSON.stringify({ event: "init", init: { tools: [] } }) + "\n" +
    JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "OK" } });
  const processed = adapter.processRunResult({ stdout, stderr: "", exitCode: 0, success: true }, request, context);
  expect(processed.success).toBe(true);
  for (const name of ["native-events.jsonl", "native-stderr.txt"]) {
    expect(readFileSync(join(home, name), "utf8")).not.toContain(secret);
  }
  expect(JSON.stringify(processed)).not.toContain(secret);
});

test("mirror refresh stays private; a later run creates a fresh mirror", () => {
  const { adapter, request, home, records } = setup();
  const first = adapter.prepareRun(request);
  const second = adapter.prepareRun(request);
  cleanup.push(() => adapter.cleanupRun(first), () => adapter.cleanupRun(second));
  expect(first.agyProbe!.home).not.toBe(second.agyProbe!.home);
  writeFileSync(join(first.agyProbe!.home!, AGY_MIRROR_PATH), "synthetic refresh");
  expect(item(join(second.agyProbe!.home!, AGY_MIRROR_PATH))).toBe("one synthetic Antigravity item");
  expect(records().filter((r) => r.args[0] === "find-generic-password")).toHaveLength(2);
  expect(records().filter((r) => r.input[0] === "create-keychain")).toHaveLength(1);
  expect(records().filter((r) => r.args[0] === "list-keychains" && r.args.includes("-s"))).toHaveLength(1);
  expect(existsSync(join(home, AGY_MIRROR_PATH))).toBe(false);
  adapter.cleanupRun(first);
  expect(existsSync(second.agyProbe!.home!)).toBe(true);
  adapter.cleanupRun(second);
  expect(readdirSync(join(home, ".gemini/.codemux-isolation-probes"))).toEqual([]);
});

test("a cleanup refusal names the mirror without disclosing its secret", () => {
  const { adapter, request, secret } = setup();
  const context = adapter.prepareRun(request);
  writeFileSync(join(context.agyProbe!.home!, ".codemux-probe-owner"), "replaced");
  let error: unknown;
  try { adapter.cleanupRun(context); } catch (caught) { error = caught; }
  expect(String(error)).toContain(`keychain mirror at ${join(context.agyProbe!.home!, AGY_MIRROR_PATH)}`);
  expect(String(error)).not.toContain(secret);
  expect(existsSync(join(context.agyProbe!.home!, AGY_MIRROR_PATH))).toBe(true);
});

test("the production security path ignores PATH and receives only the real login HOME", () => {
  const { home, env, request } = setup();
  const supplied = join(home, "supplied");
  mkdirSync(supplied);
  expect(productionSecurityPath(env)).toBe(existsSync("/usr/bin/security") ? "/usr/bin/security" : undefined);
  const path = spyOn(agyKeychainHost, "securityPath").mockImplementation(productionSecurityPath);
  const spawn = spyOn(agyKeychainHost, "spawnSync").mockImplementation((() => {
    throw new Error("synthetic stop before any Keychain access");
  }) as typeof Bun.spawnSync);
  try {
    if (!existsSync("/usr/bin/security")) return;
    expect(() => prepareAgyPrivateKeychain(home, { ...env, HOME: supplied, DYLD_INSERT_LIBRARIES: "hostile" }, request.cwd))
      .toThrow("cannot read user Keychain search list");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]![0][0]).toBe(realpathSync("/usr/bin/security"));
    expect(spawn.mock.calls[0]![1]!.env).toEqual({ HOME: home, PATH: "/usr/bin:/bin" });
  } finally { spawn.mockRestore(); path.mockRestore(); }
});

test("security uses the executable trust check before any invocation", () => {
  const { env, adapter, request, calls } = setup();
  chmodSync(env.CODEMUX_TEST_AGY_SECURITY!, 0o777);
  expect(() => adapter.prepareRun(request)).toThrow("group- or world-writable");
  expect(existsSync(calls)).toBe(false);
});

test("the secret appears in interactive stdin only, never in any security argv", () => {
  const { adapter, request, env, records } = setup();
  env.AGY_TEST_SECRET = "synthetic-refresh-token-stdin-only";
  const context = adapter.prepareRun(request);
  cleanup.push(() => adapter.cleanupRun(context));
  expect(records().filter((r) => r.stdin.includes(env.AGY_TEST_SECRET))).toHaveLength(1);
  expect(records().find((r) => r.stdin.includes(env.AGY_TEST_SECRET)).args).toEqual(["-i"]);
  expect(records().some((r) => r.args.some((arg: string) => arg.includes(env.AGY_TEST_SECRET!)))).toBe(false);
});

test.each(["create-keychain", "set-keychain-settings", "add-generic-password"])(
  "search list is restored on %s failure, including creation that already changed it", (fail) => {
    const { adapter, request, calls, originalList, records } = setup(fail);
    expect(() => adapter.prepareRun(request)).toThrow();
    expect(JSON.parse(readFileSync(`${calls}.list`, "utf8"))).toEqual(originalList);
    const create = records().findIndex((r) => r.input[0] === "create-keychain");
    expect(records()[create + 1].args).toEqual(["list-keychains", "-d", "user", "-s", ...originalList]);
  });

test.each(["restore-list", "restore-noop"])("restoration failure %s refuses launch and reports the lingering entry", (fail) => {
  const { adapter, request, records, home } = setup(fail);
  expect(() => adapter.prepareRun(request)).toThrow("search list");
  expect(records().some((r) => r.input[0] === "add-generic-password" && loginItem(r))).toBe(false);
  expect(readdirSync(join(home, ".gemini/.codemux-isolation-probes"))).toEqual([]);
});

test("synchronous exit cleanup refuses an empty search-list restore and still removes the home (round 372, item 14)", () => {
  const { adapter, request, calls, records } = setup();
  const context = adapter.prepareRun(request);
  const mirrorOnly = [join(context.agyProbe!.home!, AGY_MIRROR_PATH)];
  writeFileSync(`${calls}.list`, JSON.stringify(mirrorOnly));
  let error: unknown;
  try { adapter.cleanupRunSync(context); } catch (caught) { error = caught; }
  // A list holding only the mirror is the interrupted-cleanup state:
  // filtering it yields nothing, and the old cleanup set that empty list
  // and accepted it as restored — leaving the account with no search
  // list. The empty restore is refused by name, `list-keychains -s`
  // never runs, and the home is still removed so the token copy inside
  // it cannot survive the refusal.
  expect(String(error)).toContain("refusing to set an empty user Keychain search list");
  expect(records().filter((r) => r.args[0] === "list-keychains" && r.args.includes("-s"))).toHaveLength(1);
  expect(JSON.parse(readFileSync(`${calls}.list`, "utf8"))).toEqual(mirrorOnly);
  expect(existsSync(context.agyProbe!.home!)).toBe(false);
});

test.each(["\nextra-command", "\r", "x".repeat(4096)])("unsafe login input is refused before insertion: %#", (suffix) => {
  const { adapter, request, env, records } = setup();
  env.AGY_TEST_SECRET = `synthetic${suffix}`;
  expect(() => adapter.prepareRun(request)).toThrow("interactive input");
  expect(records().some((r) => r.input[0] === "create-keychain")).toBe(true);
  expect(records().some((r) => r.input[0] === "add-generic-password" && loginItem(r))).toBe(false);
});

test.each(["login", "hermetic", "control", "tools", "tools-control"] as const)(
  "%s copies file fallback from the real home, independently of planted operator state", (mode) => {
    const { home, adapter, env, request } = setup();
    env.AGY_TEST_FAIL = "find-generic-password";
    const planted = join(home, "planted");
    for (const root of [home, planted]) {
      mkdirSync(join(root, ".gemini/antigravity-cli"), { recursive: true });
      writeFileSync(join(root, ".gemini/antigravity-cli/antigravity-oauth-token"), root === home ? "real login" : "wrong login");
    }
    markAgyIsolationProbe(request, mode, planted);
    const context = adapter.prepareRun(request);
    cleanup.push(() => adapter.cleanupRun(context));
    expect(readFileSync(join(context.agyProbe!.home!, ".gemini/antigravity-cli/antigravity-oauth-token"), "utf8")).toBe("real login");
  });
