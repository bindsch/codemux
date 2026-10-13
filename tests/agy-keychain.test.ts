import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyAdapter, markAgyIsolationProbe } from "../src/adapters/agy.js";
import { AGY_MIRROR_PATH, AGY_TEMPLATE_NAME, agyKeychainHost, agyKeychainStateDir, buildAgyKeychainMirror } from "../src/agy-keychain.js";
import { productionSecurityPath } from "./fixtures/agy-host.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import type { RunRequest } from "../src/types.js";
import { launchRunRequest } from "../src/launch.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function setup(fail = "") {
  const home = mkdtempSync(join(tmpdir(), "agy-mirror-test-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const homeMock = spyOn(agyKeychainHost, "home").mockReturnValue(home);
  cleanup.push(() => homeMock.mockRestore());
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const fake = createFakeBinaryEnv({
    security: `exec ${quote(process.execPath)} ${quote(join(import.meta.dir, "fixtures/agy-security.ts"))} "$@"`,
    agy: `if [ "$1" = "--version" ]; then printf '1.3.3\\n'; exit 0; fi
printf 'launched\\n' >> ${quote(join(home, "harness.log"))}
printf '%s\\n' '{"status":"SUCCESS","response":"OK"}'`,
    scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
  });
  cleanup.push(fake.cleanup);
  const calls = join(home, "security.jsonl");
  const secret = "opaque-synthetic-refresh-token:" + "x".repeat(2237) + " 'quoted' \\\" $() `literal` ";
  const originalList = [join(home, "Library/Keychains/login.keychain-db"), join(home, 'other "quoted" keychain-db')];
  writeFileSync(`${calls}.list`, JSON.stringify(originalList));
  const env: Record<string, string> = { ...fake.env, PATH: fake.env.PATH!, HOME: home, AGY_TEST_SECRET: secret, AGY_TEST_CALLS: calls, AGY_TEST_FAIL: fail };
  env.CODEMUX_CALL_LOG = join(home, "state/calls.jsonl");
  const adapter = new AgyAdapter(env);
  const cwd = join(home, "work");
  mkdirSync(cwd);
  const request: RunRequest = { agent: "agy", cwd, prompt: "OK", sandboxed: true, autonomy: "read-only" };
  const records = () => readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { home, calls, secret, env, adapter, request, records, originalList };
}

test.each(["GEMINI_API_KEY", "GOOGLE_API_KEY", "file"])("%s authentication bypasses a missing Keychain item", (auth) => {
  const { home, env, adapter, request, records } = setup("find-generic-password");
  if (auth === "file") {
    mkdirSync(join(home, ".gemini/antigravity-cli"), { recursive: true });
    writeFileSync(join(home, ".gemini/antigravity-cli/antigravity-oauth-token"), "synthetic file token");
  } else env[auth] = "synthetic-api-key";
  for (const hermetic of [false, true]) {
    const context = adapter.prepareRun({ ...request, hermetic });
    cleanup.push(() => adapter.cleanupRun(context));
    expect(existsSync(join(context.agyProbe!.home!, AGY_MIRROR_PATH))).toBe(false);
    if (auth === "file") expect(readFileSync(join(context.agyProbe!.home!, ".gemini/antigravity-cli/antigravity-oauth-token"), "utf8"))
      .toBe("synthetic file token");
  }
  expect(records().every((r) => r.input[0] === "list-keychains")).toBe(true);
  expect(existsSync(join(agyKeychainStateDir(), AGY_TEMPLATE_NAME))).toBe(false);
});

test("scrubbed ambient keys use the Keychain mirror, while exempt keys retain precedence", async () => {
  const { env, adapter, request } = setup();
  env.GEMINI_API_KEY = "synthetic-api-key";
  const run = { ...request, hermetic: true };
  let mirror = false;
  const command = spyOn(adapter, "buildRunCommand").mockImplementation((_request, context) => {
    mirror = existsSync(join(context!.agyProbe!.home!, AGY_MIRROR_PATH));
    throw new Error("stop before harness spawn");
  });
  cleanup.push(() => command.mockRestore());
  for (const sandboxPolicyOverrides of [{ scrubEnv: true }, { trust: "untrusted" as const }]) {
    await expect(launchRunRequest(adapter, run, {
      sandbox: true, requestedAutonomy: "read-only", cwd: request.cwd, sandboxPolicyOverrides,
    })).rejects.toThrow("stop before harness spawn");
    expect(mirror).toBe(true);
  }
  const injected = spyOn(adapter, "getEnv").mockReturnValue({ GEMINI_API_KEY: env.GEMINI_API_KEY });
  cleanup.push(() => injected.mockRestore());
  await expect(launchRunRequest(adapter, run, {
    sandbox: true, requestedAutonomy: "read-only", cwd: request.cwd, sandboxPolicyOverrides: { scrubEnv: true },
  })).rejects.toThrow("stop before harness spawn");
  expect(mirror).toBe(false);
});

test("the template passphrase appears only on stdin, including creation and rebuild", () => {
  const { adapter, request, records } = setup("add-once");
  const context = adapter.prepareRun(request);
  cleanup.push(() => adapter.cleanupRun(context));
  const creations = records().filter((r) => r.input[0] === "create-keychain");
  expect(creations).toHaveLength(2);
  for (const creation of creations) {
    const password = creation.input[2];
    expect(creation.args).toEqual(["-i"]);
    expect(creation.stdin).toContain(password);
    expect(records().some((r) => r.args.some((arg: string) => arg.includes(password)))).toBe(false);
  }
});

test("a scrubbed API key without a file token or Keychain login refuses before spawning", async () => {
  const { env, adapter, request } = setup("find-generic-password");
  env.GEMINI_API_KEY = "synthetic-api-key";
  const command = spyOn(adapter, "buildRunCommand");
  cleanup.push(() => command.mockRestore());
  await expect(launchRunRequest(adapter, { ...request, hermetic: true }, {
    sandbox: true, requestedAutonomy: "read-only", cwd: request.cwd, sandboxPolicyOverrides: { scrubEnv: true },
  })).rejects.toThrow("agy is not logged in");
  expect(command).not.toHaveBeenCalled();
});

test.each([false, true])("every launch sweeps a crashed owner's mirror; sandbox=%s", async (sandboxed) => {
  const { home, env, adapter, request } = setup();
  const live = adapter.prepareRun(request);
  cleanup.push(() => adapter.cleanupRun(live));
  const script = `import { AgyAdapter } from ${JSON.stringify(join(import.meta.dir, "../src/adapters/agy.ts"))};
    const context = new AgyAdapter(process.env).prepareRun(${JSON.stringify(request)});
    console.log(context.agyProbe.home); setInterval(() => {}, 1000);`;
  const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "fixtures/agy-host.ts"), "-e", script],
    { env, stdout: "pipe", stderr: "pipe" });
  let privateHome = "";
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    privateHome = new TextDecoder().decode(first.value).trim();
    expect(readFileSync(join(privateHome, ".codemux-probe-pid"), "utf8")).toBe(String(child.pid));
    expect(existsSync(join(privateHome, AGY_MIRROR_PATH))).toBe(true);
  } finally { child.kill("SIGKILL"); await child.exited; }
  expect(existsSync(privateHome)).toBe(true);
  env.GEMINI_API_KEY = "synthetic-api-key";
  const next = adapter.prepareRun({ ...request, sandboxed });
  cleanup.push(() => adapter.cleanupRun(next));
  expect(existsSync(privateHome)).toBe(false);
  expect(existsSync(live.agyProbe!.home!)).toBe(true);
  expect(readdirSync(join(home, ".gemini/.codemux-isolation-probes"))).not.toContain(privateHome.split("/").at(-1)!);
});

test.each(["cached", "incomplete"])("launch repairs only owned %s keychain paths and reports unrelated names", (kind) => {
  const { home, env, adapter, request, records, calls, originalList } = setup();
  if (kind === "cached") {
    const context = adapter.prepareRun(request);
    adapter.cleanupRun(context);
  }
  const template = join(agyKeychainStateDir(), AGY_TEMPLATE_NAME);
  const mirror = join(home, ".gemini/.codemux-isolation-probes/run-crashed", AGY_MIRROR_PATH);
  const unrelated = join(home, "old-log", AGY_TEMPLATE_NAME);
  const escaped = join(home, ".codemux-isolation-probes/run-old/../../unrelated.keychain-db");
  const privateTemplate = join(home, ".codemux-isolation-probes/run-old", AGY_TEMPLATE_NAME);
  writeFileSync(`${calls}.list`, JSON.stringify([originalList[0], template, mirror, privateTemplate, unrelated, escaped, originalList[1]]));
  env.GEMINI_API_KEY = "synthetic-api-key";
  env.AGY_TEST_FAIL = "find-generic-password";
  const before = existsSync(calls) ? records().length : 0;
  const warning = spyOn(console, "error").mockImplementation(() => {});
  try {
    const next = adapter.prepareRun(request);
    cleanup.push(() => adapter.cleanupRun(next));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("left an unrelated keychain"));
  } finally { warning.mockRestore(); }
  expect(JSON.parse(readFileSync(`${calls}.list`, "utf8"))).toEqual([originalList[0], privateTemplate, unrelated, escaped, originalList[1]]);
  expect(records().slice(before).every((r) => r.input[0] === "list-keychains")).toBe(true);
});

test.each([false, true])("file tokens are copied before configuration links with a supplied HOME; hermetic=%s", (hermetic) => {
  const { home, env, request, records } = setup("find-generic-password");
  const supplied = join(home, "supplied");
  const tokenPath = ".gemini/antigravity-cli/antigravity-oauth-token";
  for (const root of [home, supplied]) {
    mkdirSync(join(root, ".gemini/antigravity-cli"), { recursive: true });
    writeFileSync(join(root, tokenPath), root === home ? "selected token" : "other token");
  }
  writeFileSync(join(supplied, ".gemini/GEMINI.md"), "supplied instructions");
  writeFileSync(join(supplied, ".gemini/antigravity-cli/settings.json"), "{}");
  const adapter = new AgyAdapter({ ...env, HOME: supplied });
  const context = adapter.prepareRun({ ...request, hermetic });
  cleanup.push(() => adapter.cleanupRun(context));
  const copied = join(context.agyProbe!.home!, tokenPath);
  expect(readFileSync(copied, "utf8")).toBe("selected token");
  expect(lstatSync(copied).isFile()).toBe(true);
  expect(lstatSync(copied).mode & 0o777).toBe(0o600);
  expect(existsSync(join(context.agyProbe!.home!, AGY_MIRROR_PATH))).toBe(false);
  if (!hermetic) {
    expect(readFileSync(join(context.agyProbe!.home!, ".gemini/GEMINI.md"), "utf8")).toBe("supplied instructions");
    expect(lstatSync(join(context.agyProbe!.home!, ".gemini/antigravity-cli/settings.json")).isSymbolicLink()).toBe(true);
  }
  writeFileSync(copied, "rotated copy");
  adapter.cleanupRun(context);
  expect(readFileSync(join(home, tokenPath), "utf8")).toBe("selected token");
  expect(readFileSync(join(supplied, tokenPath), "utf8")).toBe("other token");
  expect(records().every((r) => r.input[0] === "list-keychains")).toBe(true);
});

test.each(["add-once", "add-generic-password"])("insertion failure rebuilds the template exactly once: %s", (fail) => {
  const { adapter, request, records, calls, originalList } = setup(fail);
  if (fail === "add-once") {
    const context = adapter.prepareRun(request);
    cleanup.push(() => adapter.cleanupRun(context));
    expect(readFileSync(join(context.agyProbe!.home!, AGY_MIRROR_PATH), "utf8")).toBe("one synthetic Antigravity item");
  } else expect(() => adapter.prepareRun(request)).toThrow("cannot populate agy keychain mirror");
  expect(records().filter((r) => r.input[0] === "create-keychain")).toHaveLength(2);
  expect(records().filter((r) => r.input[0] === "add-generic-password")).toHaveLength(2);
  expect(JSON.parse(readFileSync(`${calls}.list`, "utf8"))).toEqual(originalList);
});

test("concurrent builders with different call logs share one lock and template", async () => {
  const { env, home, records, calls, originalList } = setup();
  env.AGY_TEST_CREATE_DELAY = "500";
  const builder = `import { buildAgyKeychainMirror } from ${JSON.stringify(join(import.meta.dir, "../src/agy-keychain.ts"))};
    buildAgyKeychainMirror(process.argv[1], process.env); console.log("copied");`;
  const start = (name: string) => Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "fixtures/agy-host.ts"),
    "-e", builder, join(home, name)], { env: { ...env, CODEMUX_CALL_LOG: join(home, name, "calls.jsonl") }, stdout: "pipe", stderr: "pipe" });
  const first = start("first");
  let second: ReturnType<typeof start> | undefined;
  try {
    const deadline = Date.now() + 3000;
    while ((!existsSync(calls) || !records().some((r) => r.input[0] === "create-keychain")) && Date.now() < deadline) await Bun.sleep(10);
    expect(records().filter((r) => r.input[0] === "create-keychain")).toHaveLength(1);
    second = start("second");
    await Bun.sleep(100);
    expect(existsSync(join(home, "second", AGY_MIRROR_PATH))).toBe(false);
    const outcomes = await Promise.all([first, second].map(async (child) => ({
      exit: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text(),
    })));
    expect(outcomes).toEqual([{ exit: 0, stdout: "copied\n", stderr: "" }, { exit: 0, stdout: "copied\n", stderr: "" }]);
    expect(records().filter((r) => r.input[0] === "create-keychain")).toHaveLength(1);
    expect(records().filter((r) => r.args.includes("-s") && r.args[0] === "list-keychains")).toHaveLength(1);
    expect(records().find((r) => r.input[0] === "create-keychain").input.at(-1)).toBe(join(agyKeychainStateDir(), AGY_TEMPLATE_NAME));
    for (const name of ["first", "second"]) expect(readFileSync(join(home, name, AGY_MIRROR_PATH), "utf8")).toBe("one synthetic Antigravity item");
    expect(JSON.parse(readFileSync(`${calls}.list`, "utf8"))).toEqual(originalList);
  } finally {
    for (const child of [first, second]) if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  }
});

test("a dead template lock owner is recovered before creation", () => {
  const { adapter, request } = setup();
  mkdirSync(agyKeychainStateDir(), { recursive: true });
  const lock = join(agyKeychainStateDir(), `${AGY_TEMPLATE_NAME}.lock`);
  writeFileSync(lock, "2147483647", { mode: 0o600 });
  const context = adapter.prepareRun(request);
  cleanup.push(() => adapter.cleanupRun(context));
  expect(existsSync(lock)).toBe(false);
});

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
  expect(readFileSync(mirror, "utf8")).toBe("one synthetic Antigravity item");
  expect(lstatSync(join(privateHome, "Library/Keychains")).isSymbolicLink()).toBe(false);
  expect(records().map((r) => r.input[0])).toEqual([
    "list-keychains", "find-generic-password", "list-keychains", "list-keychains", "create-keychain",
    "list-keychains", "list-keychains", "unlock-keychain", "set-keychain-settings", "add-generic-password",
  ]);
  expect(records()[1].args).toEqual(["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"]);
  const template = join(agyKeychainStateDir(), AGY_TEMPLATE_NAME);
  const creation = records().find((r) => r.input[0] === "create-keychain");
  const password = creation.input[2];
  expect(creation.input).toEqual(["create-keychain", "-p", expect.stringMatching(/^[a-f0-9]{32}$/), template]);
  expect(creation.args).toEqual(["-i"]);
  expect(readFileSync(template, "utf8")).toBe("empty");
  expect(lstatSync(template).mode & 0o777).toBe(0o600);
  expect(lstatSync(`${template}.password`).mode & 0o777).toBe(0o600);
  expect(readFileSync(`${template}.password`, "utf8")).toBe(password);
  expect(records()[5].args).toEqual(["list-keychains", "-d", "user", "-s", ...originalList]);
  expect(JSON.parse(readFileSync(`${calls}.list`, "utf8"))).toEqual(originalList);
  expect(records()[7].input).toEqual(["unlock-keychain", "-p", password, mirror]);
  expect(records()[8].input).toEqual(["set-keychain-settings", mirror]);
  expect(records()[9].input).toEqual(["add-generic-password", "-s", "gemini", "-a", "antigravity", "-l", "gemini",
    "-w", secret, "-T", "/usr/bin/security", "-T", realpathSync(agy), mirror]);
  expect(records()[9].args).toEqual(["-i"]);
  expect(records()[9].stdin).toContain(secret.slice(0, 64));
  expect(records().every((r) => r.home === home)).toBe(true);
  expect(JSON.stringify(records().map((r) => r.args))).not.toContain(secret.slice(0, 64));
  const state = join(privateHome, ".gemini");
  expect(lstatSync(state).isSymbolicLink()).toBe(false);
  if (hermetic) expect(readdirSync(join(state, "antigravity-cli"))).toEqual([]);
  else expect(realpathSync(join(state, "GEMINI.md"))).toBe(realpathSync(join(home, ".gemini/GEMINI.md")));
  expect(adapter.buildRunCommand(run, context)).toContain(`HOME=${privateHome}`);
  if (!hermetic) {
    expect(adapter.buildRunCommand(run, context)).toContain("--output-format=json");
    expect(adapter.processRunResult({ stdout: '{"status":"SUCCESS","response":"OK"}', stderr: "", success: true, exitCode: 0 }, run, context).stdout).toBe("OK\n");
  }
  adapter.cleanupRun(context);
  expect(existsSync(privateHome)).toBe(false);
  expect(records().at(-1).args).toEqual(["list-keychains", "-d", "user"]);
  expect(readdirSync(join(home, ".gemini/.codemux-isolation-probes"))).toEqual([]);
  expect(readFileSync(join(home, ".gemini/GEMINI.md"), "utf8")).toBe("operator state");
});

test.each(["find-generic-password", "create-keychain", "set-keychain-settings", "add-generic-password"])(
  "security failure at %s is redacted and removes partial mirror", (step) => {
    const { home, adapter, request, secret, records } = setup(step);
    let error: unknown;
    try { adapter.prepareRun(request); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(records().map((r) => r.args))).not.toContain(secret.slice(0, 64));
    if (step === "find-generic-password") {
      expect(String(error)).toContain("agy is not logged in; run `agy` to log in");
      expect(records().filter((r) => r.args[0] !== "list-keychains")).toHaveLength(1);
    }
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
  expect(records().every((r) => r.home === home)).toBe(true);
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
  expect(readFileSync(join(second.agyProbe!.home!, AGY_MIRROR_PATH), "utf8")).toBe("one synthetic Antigravity item");
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
    expect(() => buildAgyKeychainMirror(home, { ...env, HOME: supplied, DYLD_INSERT_LIBRARIES: "hostile" }, request.cwd))
      .toThrow("agy is not logged in");
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
  expect(records().some((r) => r.input[0] === "add-generic-password")).toBe(false);
  expect(readdirSync(join(home, ".gemini/.codemux-isolation-probes"))).toEqual([]);
});

test("synchronous exit cleanup restores the search list and removes the home", () => {
  const { adapter, request, calls } = setup();
  const context = adapter.prepareRun(request);
  writeFileSync(`${calls}.list`, JSON.stringify([join(context.agyProbe!.home!, AGY_MIRROR_PATH)]));
  adapter.cleanupRunSync(context);
  expect(JSON.parse(readFileSync(`${calls}.list`, "utf8"))).toEqual([]);
  expect(existsSync(context.agyProbe!.home!)).toBe(false);
});

test.each(["\nextra-command", "\r", "x".repeat(4096)])("unsafe interactive input is refused before creation: %#", (suffix) => {
  const { adapter, request, env, records } = setup();
  env.AGY_TEST_SECRET = `synthetic${suffix}`;
  expect(() => adapter.prepareRun(request)).toThrow("interactive input");
  expect(records().some((r) => r.input[0] === "create-keychain")).toBe(false);
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
