import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { AgyAdapter } from "../src/adapters/agy.js";
import { AGY_MIRROR_PATH, AGY_TEMPLATE_NAME, agyKeychainHost, agyKeychainStateDir,
  recoverAgyKeychainSearchList, verifyAgyKeychainSearchList } from "../src/agy-keychain.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const action of cleanup.splice(0).reverse()) action(); });

function fixture() {
  const scratch = join(import.meta.dir, "../scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const home = fs.realpathSync(fs.mkdtempSync(join(scratch, "agy-0133-")));
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const host = spyOn(agyKeychainHost, "home").mockReturnValue(home);
  const security = spyOn(agyKeychainHost, "securityPath").mockReturnValue(process.execPath);
  let list: string[] = [];
  const spawn = spyOn(agyKeychainHost, "spawnSync").mockImplementation(((args: string[]) => {
    if (args[4] === "-s") list = args.slice(5);
    return { exitCode: 0, stdout: Buffer.from(list.map((path) => `"${path}"`).join("\n")), stderr: Buffer.alloc(0) };
  }) as typeof Bun.spawnSync);
  cleanup.push(() => host.mockRestore(), () => security.mockRestore(), () => spawn.mockRestore());
  return { home, list: () => list, setList: (paths: string[]) => { list = paths; } };
}

test("owned mirror and template canonicalization errors fail recovery, verification, and cleanup loudly", () => {
  const state = fixture();
  const environment = { HOME: state.home, GEMINI_API_KEY: "synthetic-key" };
  const adapter = new AgyAdapter(environment);
  const context = adapter.prepareRun({ agent: "agy", prompt: "test", sandboxed: true });
  const home = context.agyProbe!.home!;
  const library = join(home, "Library");
  fs.mkdirSync(library);
  fs.renameSync(library, join(home, "Library-original"));
  fs.writeFileSync(library, "a file replaced the directory");
  const mirror = join(home, AGY_MIRROR_PATH);
  const alias = join(state.home, "alias");
  fs.symlinkSync(home, alias);
  for (const path of [mirror, join(alias, AGY_MIRROR_PATH)]) {
    state.setList([path]);
    expect(() => recoverAgyKeychainSearchList(environment)).toThrow("ENOTDIR");
    expect(() => verifyAgyKeychainSearchList(environment)).toThrow("ENOTDIR");
    expect(state.list()).toEqual([path]);
  }
  state.setList([mirror]);
  expect(() => adapter.cleanupRunSync(context)).toThrow(library);
  expect(() => adapter.cleanupRunSync(context)).toThrow("ENOTDIR");
  expect(state.list()).toEqual([mirror]);

  const template = join(agyKeychainStateDir(), AGY_TEMPLATE_NAME);
  const original = fs.realpathSync;
  const canonicalize = spyOn(fs, "realpathSync").mockImplementation(((path: fs.PathLike) => {
    if (String(path) === template) throw Object.assign(new Error(`EACCES: ${template}`), { code: "EACCES" });
    return original(path);
  }) as typeof fs.realpathSync);
  cleanup.push(() => canonicalize.mockRestore());
  state.setList([template]);
  expect(() => recoverAgyKeychainSearchList(environment)).toThrow(template);
  expect(() => verifyAgyKeychainSearchList(environment)).toThrow("EACCES");
  expect(state.list()).toEqual([template]);
});

test("symlinked Gemini configuration supports absent and existing probe roots in plain and private runs", () => {
  const state = fixture();
  const supplied = join(state.home, "supplied");
  fs.mkdirSync(supplied);
  for (const home of [state.home, supplied]) {
    const configuration = join(home, "dotfiles-gemini");
    fs.mkdirSync(configuration);
    fs.symlinkSync(configuration, join(home, ".gemini"));
  }
  const adapter = new AgyAdapter({ HOME: supplied, GEMINI_API_KEY: "synthetic-key" });
  const request = { agent: "agy" as const, prompt: "test", sandboxed: false };
  expect(adapter.prepareRun(request)).toEqual({});
  for (const home of [state.home, supplied]) {
    expect(fs.existsSync(join(home, "dotfiles-gemini/.codemux-isolation-probes"))).toBe(false);
  }
  for (const hermetic of [false, true]) {
    const context = adapter.prepareRun({ ...request, sandboxed: true, hermetic });
    const home = context.agyProbe!.home!;
    expect(home.startsWith(join(supplied, "dotfiles-gemini/.codemux-isolation-probes/run-"))).toBe(true);
    state.setList([join(supplied, ".gemini/.codemux-isolation-probes", home.split("/").at(-1)!, AGY_MIRROR_PATH)]);
    adapter.cleanupRunSync(context);
    expect(state.list()).toEqual([]);
    expect(fs.existsSync(home)).toBe(false);
  }
  for (const home of [state.home, supplied]) {
    const stale = join(home, "dotfiles-gemini/.codemux-isolation-probes/run-dead");
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(join(stale, ".codemux-probe-owner"), crypto.randomUUID());
    fs.writeFileSync(join(stale, ".codemux-probe-pid"), "2147483647");
    state.setList([...state.list(), join(home, ".gemini/.codemux-isolation-probes/run-dead", AGY_MIRROR_PATH)]);
  }
  expect(adapter.prepareRun(request)).toEqual({});
  expect(state.list()).toEqual([]);
  for (const home of [state.home, supplied]) {
    expect(fs.readdirSync(join(home, "dotfiles-gemini/.codemux-isolation-probes"))).toEqual([]);
  }
});
