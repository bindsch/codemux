/**
 * The hermetic agy session's private-home content (src/session/
 * agy-private-home.ts): the populate callback's login selection and the
 * resume verification, entirely against the stubbed keychain host — no
 * real Keychain, no real security binary (the host seams home,
 * securityPath, spawnSync, and linkSync are all under the test's
 * control), every path under a throwaway home.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { linkSync } from "node:fs";
import {
  AGY_MIRROR_PATH,
  AGY_TEMPLATE_NAME,
  agyKeychainHost,
  agyKeychainStateDir,
} from "../src/agy-keychain.js";
import { PROBE_MARKER, PROBE_PID } from "../src/adapters/agy-homes.js";
import {
  populateAgySessionPrivateHome,
  settledAgyHarnessHome,
  verifyAgySessionPrivateHome,
} from "../src/session/agy-private-home.js";
import { UsageRefusalError } from "../src/validation.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

const TOKEN_PATH = ".gemini/antigravity-cli/antigravity-oauth-token";
const LOGIN_MARKER = ".codemux-login";
const SECRET = "synthetic-refresh-token-never-on-argv";

/** One stubbed keychain world: a throwaway login home with the template
 * and password pre-created (so no create-keychain runs), an `agy` on
 * PATH for the insert arm's executable resolution, and a spawnSync fake
 * whose answers come from per-HOME default-keychain state — the real
 * client and the private one are told apart by HOME alone, exactly as
 * production tells them apart. The gemini login item is tracked per
 * keychain path: the real login keychain starts with it (unless
 * loginItem: false), the private mirror gains it only through the
 * insert arm's add, and a find answers by the keychain it names (the
 * trailing path) or the caller's default. */
function setup(options: { loginItem?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "agy-session-home-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const homeMock = spyOn(agyKeychainHost, "home").mockReturnValue(home);
  const securityMock = spyOn(agyKeychainHost, "securityPath").mockReturnValue(process.execPath);
  const linkMock = spyOn(agyKeychainHost, "linkSync").mockImplementation(linkSync);
  cleanup.push(() => homeMock.mockRestore(), () => securityMock.mockRestore(), () =>
    linkMock.mockRestore());
  const stateDir = agyKeychainStateDir();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, AGY_TEMPLATE_NAME), "empty template", { mode: 0o600 });
  writeFileSync(join(stateDir, `${AGY_TEMPLATE_NAME}.password`), "a".repeat(32), { mode: 0o600 });
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "agy"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const original = join(home, "Library/Keychains/login.keychain-db");
  const searchList = [original];
  const defaults = new Map<string, string>([[home, original]]);
  const unlocked = new Set<string>();
  const items = new Set<string>(options.loginItem !== false ? [original] : []);
  const calls: { args: string[]; stdin: string; home: string }[] = [];
  const ok = () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, signalCode: null });
  const fail = () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from("synthetic refusal"), exitCode: 1, signalCode: null });
  const decode = (stdin: Buffer | "ignore"): string[] =>
    Buffer.isBuffer(stdin)
      ? [...stdin.toString().matchAll(/"((?:\\.|[^"\\])*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, "$1"))
      : [];
  const fakeSecurity = (
    command: string[],
    options: { env: NodeJS.ProcessEnv; stdin: Buffer | "ignore" }
  ) => {
    const args = command.slice(1);
    const caller = options.env.HOME!;
    const input = args[0] === "-i" ? decode(options.stdin) : args;
    const line = JSON.stringify({ args, input, home: caller });
    calls.push({ args: [...args], stdin: Buffer.isBuffer(options.stdin) ? options.stdin.toString() : "", home: caller });
    const name = input[0];
    if (name === "list-keychains") {
      if (args.includes("-s")) {
        searchList.length = 0;
        searchList.push(...input.slice(1));
        return ok();
      }
      return { ...ok(), stdout: Buffer.from(searchList.map((p) => `    "${p}"\n`).join("")) };
    }
    if (name === "default-keychain") {
      if (args.includes("-s")) {
        defaults.set(caller, input.at(-1)!);
        return ok();
      }
      const path = defaults.get(caller);
      return path === undefined ? fail() : { ...ok(), stdout: Buffer.from(`    "${path}"\n`) };
    }
    if (name === "unlock-keychain") {
      unlocked.add(input.at(-1)!);
      return ok();
    }
    if (name === "set-keychain-settings") return ok();
    if (name === "add-generic-password") {
      // Only the gemini login insert counts; the usability probe's
      // add/delete pair (service codemux-usability-probe) does not.
      if (input.includes("gemini")) items.add(input.at(-1)!);
      return ok();
    }
    if (name === "delete-generic-password") return ok();
    if (name === "find-generic-password" && input.includes("gemini")) {
      // The named keychain when the call carries one (the verify find),
      // else the caller's default (the insert arm's real-home read).
      const last = input.at(-1)!;
      const keychain = last.startsWith("/") ? last : defaults.get(caller);
      return keychain !== undefined && items.has(keychain)
        ? { ...ok(), stdout: Buffer.from(`${SECRET}\n`) }
        : fail();
    }
    throw new Error(`the fake security met an unmodeled command: ${line}`);
  };
  const spawnMock = spyOn(agyKeychainHost, "spawnSync").mockImplementation(
    fakeSecurity as unknown as typeof Bun.spawnSync
  );
  cleanup.push(() => spawnMock.mockRestore());
  const environment: Record<string, string> = { HOME: home, PATH: bin };
  let freshCount = 0;
  const freshHome = () => {
    const dir = join(home, ".gemini", ".codemux-isolation-probes", `run-${++freshCount}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  };
  const plantToken = (dir: string, content = "synthetic token bytes") => {
    mkdirSync(dirname(join(dir, TOKEN_PATH)), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, TOKEN_PATH), content, { mode: 0o600 });
  };
  const plantMirror = (dir: string, withItem = true) => {
    mkdirSync(dirname(join(dir, AGY_MIRROR_PATH)), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, AGY_MIRROR_PATH), "mirror bytes", { mode: 0o600 });
    defaults.set(dir, join(dir, AGY_MIRROR_PATH));
    if (withItem) items.add(join(dir, AGY_MIRROR_PATH));
  };
  const plantMarker = (dir: string, arm: string) => {
    writeFileSync(join(dir, LOGIN_MARKER), arm, { mode: 0o600 });
  };
  return { home, environment, calls, freshHome, plantToken, plantMirror, plantMarker, ok, defaults, unlocked, items, spawnMock };
}

describe("populateAgySessionPrivateHome", () => {
  test("the keychain arm copies the real item into the private mirror and marks the home", () => {
    const world = setup();
    const dir = world.freshHome();
    const source = populateAgySessionPrivateHome(dir, { environment: world.environment, scrubbing: false });
    expect(source).toBe("keychain");
    // The login item was read from the real home and inserted over
    // interactive stdin, never on argv.
    const insert = world.calls.find((call) => call.stdin.includes("add-generic-password") && call.stdin.includes('"gemini"'));
    expect(insert).toBeDefined();
    expect(insert!.home).toBe(world.home);
    expect(insert!.args).toEqual(["-i"]);
    expect(world.calls.some((call) => call.args.some((arg) => arg.includes(SECRET)))).toBe(false);
    expect(existsSync(join(dir, AGY_MIRROR_PATH))).toBe(true);
    // The login marker names the arm that populated the home (round 413,
    // item 3), mode 0600: the resume check proves this arm's credential,
    // never a file's existence.
    expect(readFileSync(join(dir, LOGIN_MARKER), "utf8")).toBe("keychain");
    expect(statSync(join(dir, LOGIN_MARKER)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, PROBE_PID), "utf8")).toBe(String(process.pid));
    expect(statSync(join(dir, PROBE_PID)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, PROBE_MARKER))).toBe(true);
    expect(statSync(join(dir, ".gemini", "antigravity-cli")).mode & 0o777).toBe(0o700);
    // No operator state links and no settings.json: the caller owns that
    // file, and codemux must never write it.
    expect(existsSync(join(dir, ".gemini", "antigravity-cli", "settings.json"))).toBe(false);
  });

  test("the file-token arm copies the operator's token, mode 0600, and skips the real Keychain login", () => {
    const world = setup();
    mkdirSync(dirname(join(world.home, TOKEN_PATH)), { recursive: true });
    writeFileSync(join(world.home, TOKEN_PATH), "opaque token", { mode: 0o600 });
    const dir = world.freshHome();
    const source = populateAgySessionPrivateHome(dir, { environment: world.environment, scrubbing: false });
    expect(source).toBe("file-token");
    expect(readFileSync(join(dir, LOGIN_MARKER), "utf8")).toBe("token");
    expect(readFileSync(join(dir, TOKEN_PATH), "utf8")).toBe("opaque token");
    expect(statSync(join(dir, TOKEN_PATH)).mode & 0o777).toBe(0o600);
    expect(world.calls.some((call) => call.args.includes("find-generic-password"))).toBe(false);
    expect(existsSync(join(dir, AGY_MIRROR_PATH))).toBe(true);
  });

  test("the api-key arm copies nothing; a scrubbed key without a keep does not select it", () => {
    const world = setup();
    const dir = world.freshHome();
    const withKey = { ...world.environment, GEMINI_API_KEY: "synthetic-key" };
    expect(populateAgySessionPrivateHome(dir, { environment: withKey, scrubbing: false })).toBe("api-key");
    expect(readFileSync(join(dir, LOGIN_MARKER), "utf8")).toBe("api-key");
    expect(existsSync(join(dir, TOKEN_PATH))).toBe(false);
    expect(world.calls.some((call) => call.args.includes("find-generic-password"))).toBe(false);
    // Scrubbed without keepEnv: the key is gone from the child's view, so
    // the login selection falls through to the file-token arm.
    mkdirSync(dirname(join(world.home, TOKEN_PATH)), { recursive: true });
    writeFileSync(join(world.home, TOKEN_PATH), "opaque token", { mode: 0o600 });
    const dir2 = world.freshHome();
    expect(
      populateAgySessionPrivateHome(dir2, { environment: withKey, scrubbing: true })
    ).toBe("file-token");
    // Scrubbed WITH the keep exemption the caller forwards: the key arm.
    const dir3 = world.freshHome();
    expect(
      populateAgySessionPrivateHome(dir3, {
        environment: withKey,
        scrubbing: true,
        keepEnv: ["GEMINI_API_KEY"],
      })
    ).toBe("api-key");
  });

  test("a missing login fails closed, repairs the search list, and rethrows for the launcher's removal", () => {
    const world = setup({ loginItem: false });
    const dir = world.freshHome();
    expect(() =>
      populateAgySessionPrivateHome(dir, { environment: world.environment, scrubbing: false })
    ).toThrow("agy is not logged in");
    // The failure path still recovered and verified the search list.
    const lists = world.calls.filter((call) => call.args[0] === "list-keychains" && !call.args.includes("-s"));
    expect(lists.length).toBeGreaterThanOrEqual(2);
  });
});

describe("verifyAgySessionPrivateHome", () => {
  test("a token home verifies on its token file without writing anything", () => {
    const world = setup();
    const dir = world.freshHome();
    world.plantToken(dir);
    world.plantMarker(dir, "token");
    const settings = join(dir, ".gemini", "antigravity-cli", "settings.json");
    writeFileSync(settings, '{"permissions":{"deny":["command(ops/publish)"]}}', { mode: 0o600 });
    expect(verifyAgySessionPrivateHome(dir, { environment: world.environment, scrubbing: false })).toBe("token");
    // The caller's policy file survived byte for byte and no keychain
    // write ran (no -i command at all).
    expect(readFileSync(settings, "utf8")).toBe('{"permissions":{"deny":["command(ops/publish)"]}}');
    expect(world.calls.some((call) => call.args[0] === "-i")).toBe(false);
  });

  test("a keychain home proves the login by finding the item in the private mirror", () => {
    const world = setup();
    const dir = world.freshHome();
    world.plantMirror(dir);
    world.plantMarker(dir, "keychain");
    // Drift: something replaced the private HOME's default.
    world.defaults.set(dir, join(world.home, "other.keychain-db"));
    expect(verifyAgySessionPrivateHome(dir, { environment: world.environment, scrubbing: false })).toBe("keychain");
    // The find named the private mirror (the trailing keychain path), so
    // an empty mirror cannot borrow the real login's existence, and no -w
    // ran: presence is proven without reading the secret.
    const find = world.calls.find(
      (call) => call.args.includes("find-generic-password") && call.home === dir
    );
    expect(find).toBeDefined();
    expect(find!.args.at(-1)).toBe(join(dir, AGY_MIRROR_PATH));
    expect(find!.args.includes("-w")).toBe(false);
    // A drifted private default is re-selected and the mirror re-unlocked,
    // with the operator's default untouched.
    expect(world.defaults.get(dir)).toBe(join(dir, AGY_MIRROR_PATH));
    expect(world.unlocked.has(join(dir, AGY_MIRROR_PATH))).toBe(true);
    expect(world.defaults.get(world.home)).toBe(join(world.home, "Library/Keychains/login.keychain-db"));
  });

  test("an empty mirror — the file exists, the item does not — is refused (round 413, item 3)", () => {
    const world = setup();
    const dir = world.freshHome();
    // The populate order creates the mirror before the login selection, so
    // an api-key or file-token session leaves a mirror with no item in it:
    // the file's existence proves nothing and the resume must refuse.
    world.plantMirror(dir, false);
    world.plantMarker(dir, "keychain");
    expect(() =>
      verifyAgySessionPrivateHome(dir, { environment: world.environment, scrubbing: false })
    ).toThrow(UsageRefusalError);
  });

  test("a missing or unknown marker is refused even when a token and mirror both survive", () => {
    const world = setup();
    const dir = world.freshHome();
    world.plantToken(dir);
    world.plantMirror(dir);
    // No marker: the home proves no arm, so nothing is verified.
    expect(() =>
      verifyAgySessionPrivateHome(dir, { environment: world.environment, scrubbing: false })
    ).toThrow(UsageRefusalError);
    // A marker naming an unknown arm is the same refusal.
    world.plantMarker(dir, "banana");
    expect(() =>
      verifyAgySessionPrivateHome(dir, { environment: world.environment, scrubbing: false })
    ).toThrow(UsageRefusalError);
  });

  test("the api-key arm verifies on a surviving key, honoring keepEnv; the marker's arm alone decides what is proven", () => {
    const world = setup();
    const dir = world.freshHome();
    world.plantMarker(dir, "api-key");
    const withKey = { ...world.environment, GOOGLE_API_KEY: "synthetic-key" };
    expect(verifyAgySessionPrivateHome(dir, { environment: withKey, scrubbing: false })).toBe("api-key");
    // Scrubbed without the keep exemption: the key is gone, so refuse.
    expect(() =>
      verifyAgySessionPrivateHome(dir, { environment: withKey, scrubbing: true })
    ).toThrow(UsageRefusalError);
    // Scrubbed WITH the keep exemption the caller forwards: the key answers.
    expect(
      verifyAgySessionPrivateHome(dir, {
        environment: withKey,
        scrubbing: true,
        keepEnv: ["GOOGLE_API_KEY"],
      })
    ).toBe("api-key");
    // The marker decides which credential is proven, so a marked token arm
    // whose file is gone does not fall back to the surviving key.
    const dir2 = world.freshHome();
    world.plantMarker(dir2, "token");
    expect(() =>
      verifyAgySessionPrivateHome(dir2, { environment: withKey, scrubbing: false })
    ).toThrow(UsageRefusalError);
  });

  test("a marked keychain arm whose item vanished from the mirror is refused", () => {
    const world = setup();
    const dir = world.freshHome();
    world.plantMirror(dir);
    world.plantMarker(dir, "keychain");
    // The mirror survives but its item was removed between sessions.
    world.items.delete(join(dir, AGY_MIRROR_PATH));
    expect(() =>
      verifyAgySessionPrivateHome(dir, { environment: world.environment, scrubbing: false })
    ).toThrow(UsageRefusalError);
  });
});

describe("settledAgyHarnessHome", () => {
  test("names the session-keyed state home under the same parent, from either spelling", () => {
    const parent = join("/tmp", "probes");
    expect(settledAgyHarnessHome(join(parent, "run-123-abc"), "conv-1")).toBe(
      join(parent, "session-conv-1", ".gemini", "antigravity-cli")
    );
    expect(settledAgyHarnessHome(join(parent, "session-conv-1"), "conv-1")).toBe(
      join(parent, "session-conv-1", ".gemini", "antigravity-cli")
    );
  });
});
