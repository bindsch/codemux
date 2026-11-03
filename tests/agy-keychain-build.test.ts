import { afterEach, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { AgyAdapter } from "../src/adapters/agy.js";
import {
  AGY_MIRROR_PATH,
  AGY_TEMPLATE_NAME,
  agyKeychainStateDir,
} from "../src/agy-keychain.js";
import { launchRunRequest } from "../src/launch.js";
import { cleanup, item, loginItem, setup } from "./helpers/agy-keychain.js";

afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

test.each(["GEMINI_API_KEY", "GOOGLE_API_KEY", "file"])("%s authentication prepares an empty private Keychain without reading the login item", (auth) => {
  const { home, env, adapter, request, records } = setup("find-generic-password");
  if (auth === "file") {
    mkdirSync(join(home, ".gemini/antigravity-cli"), { recursive: true });
    writeFileSync(join(home, ".gemini/antigravity-cli/antigravity-oauth-token"), "synthetic file token");
  } else env[auth] = "synthetic-api-key";
  for (const hermetic of [false, true]) {
    const context = adapter.prepareRun({ ...request, hermetic });
    cleanup.push(() => adapter.cleanupRun(context));
    const mirror = join(context.agyProbe!.home!, AGY_MIRROR_PATH);
    expect(item(mirror)).toBe("empty");
    if (auth === "file") expect(readFileSync(join(context.agyProbe!.home!, ".gemini/antigravity-cli/antigravity-oauth-token"), "utf8")).toBe("synthetic file token");
  }
  expect(records().filter(loginItem)).toHaveLength(0);
  expect(records().filter((r) => r.input[0] === "default-keychain")).toHaveLength(8);
  expect(existsSync(join(agyKeychainStateDir(), AGY_TEMPLATE_NAME))).toBe(true);
});
test("scrubbed ambient keys use the Keychain mirror, while exempt keys retain precedence", async () => {
  const { env, adapter, request } = setup();
  env.GEMINI_API_KEY = "synthetic-api-key";
  const run = { ...request, hermetic: true };
  let mirror: string | undefined;
  const command = spyOn(adapter, "buildRunCommand").mockImplementation((_request, context) => {
    const path = join(context!.agyProbe!.home!, AGY_MIRROR_PATH);
    mirror = existsSync(path) ? item(path) : undefined;
    throw new Error("stop before harness spawn");
  });
  cleanup.push(() => command.mockRestore());
  for (const sandboxPolicyOverrides of [{ scrubEnv: true }, { trust: "untrusted" as const }]) {
    await expect(launchRunRequest(adapter, run, {
      sandbox: true, requestedAutonomy: "read-only", cwd: request.cwd, sandboxPolicyOverrides,
    })).rejects.toThrow("stop before harness spawn");
    expect(mirror).toBe("one synthetic Antigravity item");
  }
  const injected = spyOn(adapter, "getEnv").mockReturnValue({ GEMINI_API_KEY: env.GEMINI_API_KEY });
  cleanup.push(() => injected.mockRestore());
  await expect(launchRunRequest(adapter, run, {
    sandbox: true, requestedAutonomy: "read-only", cwd: request.cwd, sandboxPolicyOverrides: { scrubEnv: true },
  })).rejects.toThrow("stop before harness spawn");
  expect(mirror).toBe("empty");
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
  expect(records().slice(before).some(loginItem)).toBe(false);
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
  expect(item(join(context.agyProbe!.home!, AGY_MIRROR_PATH))).toBe("empty");
  if (!hermetic) {
    expect(readFileSync(join(context.agyProbe!.home!, ".gemini/GEMINI.md"), "utf8")).toBe("supplied instructions");
    expect(lstatSync(join(context.agyProbe!.home!, ".gemini/antigravity-cli/settings.json")).isSymbolicLink()).toBe(true);
  }
  writeFileSync(copied, "rotated copy");
  adapter.cleanupRun(context);
  expect(readFileSync(join(home, tokenPath), "utf8")).toBe("selected token");
  expect(readFileSync(join(supplied, tokenPath), "utf8")).toBe("other token");
  expect(records().some(loginItem)).toBe(false);
});

test.each(["add-once", "add-generic-password"])("insertion failure rebuilds the template exactly once: %s", (fail) => {
  const { adapter, request, records, calls, originalList } = setup(fail);
  if (fail === "add-once") {
    const context = adapter.prepareRun(request);
    cleanup.push(() => adapter.cleanupRun(context));
    expect(item(join(context.agyProbe!.home!, AGY_MIRROR_PATH))).toBe("one synthetic Antigravity item");
  } else expect(() => adapter.prepareRun(request)).toThrow("cannot populate agy keychain mirror");
  expect(records().filter((r) => r.input[0] === "create-keychain")).toHaveLength(2);
  expect(records().filter((r) => r.input[0] === "add-generic-password" && loginItem(r))).toHaveLength(2);
  expect(JSON.parse(readFileSync(`${calls}.list`, "utf8"))).toEqual(originalList);
});
test("concurrent builders with different call logs share one lock and template", async () => {
  const { env, home, records, calls, originalList } = setup();
  env.AGY_TEST_CREATE_DELAY = "500";
  const builder = `import { prepareAgyPrivateKeychain, insertAgyKeychainItem } from ${JSON.stringify(join(import.meta.dir, "../src/agy-keychain.ts"))};
    const password = prepareAgyPrivateKeychain(process.argv[1], process.env);
    insertAgyKeychainItem(process.argv[1], process.env, password); console.log("copied");`;
  const start = (name: string) => Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "fixtures/agy-host.ts"),
    "-e", builder, join(home, name)], { env: { ...env, CODEMUX_CALL_LOG: join(home, name, "calls.jsonl") }, stdout: "pipe", stderr: "pipe" });
  const first = start("first");
  let second: ReturnType<typeof start> | undefined;
  try {
    const deadline = Date.now() + 3000;
    while ((!existsSync(calls) || !records().some((r) => r.input[0] === "create-keychain")) && Date.now() < deadline) await Bun.sleep(10);
    expect(records().filter((r) => r.input[0] === "create-keychain")).toHaveLength(1);
    second = start("second");
    // No fixed sleep before the absence assertion: the barrier is the loop
    // above, which exited within one 10 ms poll of first's create-keychain
    // record — and the fake records that invocation BEFORE its
    // AGY_TEST_CREATE_DELAY sleep (500 ms), so first provably still holds
    // the template lock here. Second (spawned, running or still starting)
    // cannot have produced a mirror without the lock, under any load.
    expect(existsSync(join(home, "second", AGY_MIRROR_PATH))).toBe(false);
    const outcomes = await Promise.all([first, second].map(async (child) => ({
      exit: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text(),
    })));
    expect(outcomes).toEqual([{ exit: 0, stdout: "copied\n", stderr: "" }, { exit: 0, stdout: "copied\n", stderr: "" }]);
    expect(records().filter((r) => r.input[0] === "create-keychain")).toHaveLength(1);
    expect(records().filter((r) => r.args.includes("-s") && r.args[0] === "list-keychains")).toHaveLength(1);
    expect(records().find((r) => r.input[0] === "create-keychain").input.at(-1)).toBe(join(agyKeychainStateDir(), AGY_TEMPLATE_NAME));
    for (const name of ["first", "second"]) expect(item(join(home, name, AGY_MIRROR_PATH))).toBe("one synthetic Antigravity item");
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
