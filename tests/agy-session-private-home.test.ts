import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { UsageRefusalError } from "../src/validation.js";
import { setup, cleanupAgyIsolation } from "./helpers/agy-isolation-setup.js";
import { populateAgySessionPrivateHome, verifyAgySessionPrivateHome, settledAgyHarnessHome } from "../src/session/agy-private-home.js";
import { AGY_FILE_TOKEN, AGY_NATIVE_PATHS, agyLoginPaths, linkAgyLogin } from "../src/agy-auth.js";
import { buildScodeCommand } from "../src/sandbox.js";
afterEach(cleanupAgyIsolation);

function fixture() {
  const { home } = setup(false);
  const source = join(home, "operator");
  const privateHome = join(home, "private");
  mkdirSync(privateHome);
  mkdirSync(join(source, "Library/Keychains"), { recursive: true });
  mkdirSync(join(source, "Library/Preferences"), { recursive: true });
  mkdirSync(join(source, ".gemini/antigravity-cli"), { recursive: true });
  writeFileSync(join(source, AGY_NATIVE_PATHS[1]), "synthetic preferences");
  writeFileSync(join(source, AGY_FILE_TOKEN), "synthetic token");
  return { source, privateHome, options: { environment: { HOME: source }, scrubbing: false } };
}

test("private HOME links native paths without copying or inspecting their contents", () => {
  const { source, privateHome } = fixture();
  linkAgyLogin(privateHome, source, "darwin");
  for (const relative of [...AGY_NATIVE_PATHS, AGY_FILE_TOKEN]) {
    expect(readlinkSync(join(privateHome, relative))).toBe(join(source, relative));
  }
  linkAgyLogin(privateHome, source, "darwin");
  // Atomic replacement at the source remains visible, unlike a credential copy.
  writeFileSync(join(source, "replacement"), "refreshed synthetic token");
  renameSync(join(source, "replacement"), join(source, AGY_FILE_TOKEN));
  expect(readFileSync(join(privateHome, AGY_FILE_TOKEN), "utf8")).toBe("refreshed synthetic token");
});

test("missing optional preferences and non-macOS homes do not require native paths", () => {
  const { home } = setup(false);
  linkAgyLogin(join(home, "private"), join(home, "missing"), "darwin");
  expect(existsSync(join(home, "private"))).toBe(false);
  expect(agyLoginPaths(home, "linux")).toEqual([]);
  const { source, privateHome } = fixture();
  linkAgyLogin(privateHome, source, "linux");
  expect(existsSync(join(privateHome, "Library"))).toBe(false);
  expect(readlinkSync(join(privateHome, AGY_FILE_TOKEN))).toBe(join(source, AGY_FILE_TOKEN));
});

test("an existing different login link is never overwritten", () => {
  const { source, privateHome } = fixture();
  mkdirSync(join(privateHome, "Library"), { recursive: true });
  symlinkSync(source, join(privateHome, AGY_NATIVE_PATHS[0]));
  expect(() => linkAgyLogin(privateHome, source, "darwin")).toThrow("already links somewhere other than");
  expect(readlinkSync(join(privateHome, AGY_NATIVE_PATHS[0]))).toBe(source);
});

test("a real file or directory at a link's place refuses by name and is never deleted", () => {
  // Review round 4, edges 1: readlink on a non-link threw a raw EINVAL.
  for (const relative of [AGY_FILE_TOKEN, AGY_NATIVE_PATHS[0]]) {
    const { source, privateHome } = fixture();
    const own = join(privateHome, relative);
    if (relative === AGY_FILE_TOKEN) {
      mkdirSync(dirname(own), { recursive: true });
      writeFileSync(own, "the home's own login");
    } else mkdirSync(own, { recursive: true });
    let thrown: unknown;
    try { linkAgyLogin(privateHome, source, "darwin"); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(UsageRefusalError);
    expect((thrown as Error).message).toContain(`holds its own file or directory at ${own}`);
    expect((thrown as Error).message).not.toContain("EINVAL");
    expect(lstatSync(own).isSymbolicLink()).toBe(false);
    if (relative === AGY_FILE_TOKEN) expect(readFileSync(own, "utf8")).toBe("the home's own login");
  }
});

test("an API-key session home links no native login", () => {
  const { privateHome, options } = fixture();
  const withKey = { ...options, platform: "darwin" as const, environment: { ...options.environment, GEMINI_API_KEY: "synthetic" } };
  expect(populateAgySessionPrivateHome(privateHome, withKey)).toBe("api-key");
  for (const relative of [...AGY_NATIVE_PATHS, AGY_FILE_TOKEN]) {
    expect(lstatSync(join(privateHome, relative), { throwIfNoEntry: false })).toBeUndefined();
  }
});

test("sessions populate and resume their live login without requiring an API key", () => {
  const { source, privateHome, options } = fixture();
  expect(populateAgySessionPrivateHome(privateHome, options)).toBe("native");
  expect(verifyAgySessionPrivateHome(privateHome, options)).toBe("native");
  expect(readFileSync(join(source, AGY_FILE_TOKEN), "utf8")).toBe("synthetic token");
  expect(settledAgyHarnessHome(join(source, "run-1"), "conversation")).toBe(join(source, "session-conversation/.gemini/antigravity-cli"));
});

test("a login path the operator gained since the last turn is linked on resume; a replaced or changed link refuses", () => {
  const { source, privateHome, options } = fixture();
  rmSync(join(source, AGY_FILE_TOKEN));
  rmSync(join(source, AGY_NATIVE_PATHS[1]));
  populateAgySessionPrivateHome(privateHome, { ...options, platform: "darwin" });
  expect(existsSync(join(privateHome, AGY_FILE_TOKEN))).toBe(false);
  // The operator logs in with a file token and gains a preference file.
  writeFileSync(join(source, AGY_FILE_TOKEN), "synthetic token");
  writeFileSync(join(source, AGY_NATIVE_PATHS[1]), "synthetic preferences");
  expect(verifyAgySessionPrivateHome(privateHome, { ...options, platform: "darwin" })).toBe("native");
  for (const relative of [AGY_FILE_TOKEN, AGY_NATIVE_PATHS[1]]) {
    expect(readlinkSync(join(privateHome, relative))).toBe(join(source, relative));
  }
  // A regular file where the link belongs is a login codemux did not link.
  rmSync(join(privateHome, AGY_FILE_TOKEN));
  writeFileSync(join(privateHome, AGY_FILE_TOKEN), "a login stored in the private home");
  expect(() => verifyAgySessionPrivateHome(privateHome, options)).toThrow("login link was replaced");
  rmSync(join(privateHome, AGY_FILE_TOKEN));
  symlinkSync(join(source, "elsewhere"), join(privateHome, AGY_FILE_TOKEN));
  expect(() => verifyAgySessionPrivateHome(privateHome, options)).toThrow("login link changed");
});

test("API key sessions verify the key and leave their settings intact", () => {
  const { privateHome, options } = fixture();
  const withKey = { ...options, environment: { ...options.environment, GEMINI_API_KEY: "synthetic" } };
  expect(populateAgySessionPrivateHome(privateHome, withKey)).toBe("api-key");
  const settings = join(privateHome, ".gemini/antigravity-cli/settings.json");
  writeFileSync(settings, '{"permissions":{"deny":["command(*)"]}}');
  expect(verifyAgySessionPrivateHome(privateHome, withKey)).toBe("api-key");
  expect(readFileSync(settings, "utf8")).toContain("command(*)");
  expect(() => verifyAgySessionPrivateHome(privateHome, options)).toThrow("GEMINI_API_KEY");
});

test("GOOGLE_API_KEY selects and verifies the api-key arm like GEMINI_API_KEY", () => {
  const { privateHome, options } = fixture();
  const withGoogle = { ...options, environment: { ...options.environment, GOOGLE_API_KEY: "synthetic" } };
  expect(populateAgySessionPrivateHome(privateHome, withGoogle)).toBe("api-key");
  expect(verifyAgySessionPrivateHome(privateHome, withGoogle)).toBe("api-key");
  // The scrub rule applies per name: a kept GOOGLE_API_KEY still arms the
  // api-key route, and a scrubbed one does not.
  const extraHome = (name: string) => {
    const dir = join(options.environment.HOME!, name);
    mkdirSync(dir);
    return dir;
  };
  const scrubbed = { ...withGoogle, scrubbing: true };
  expect(populateAgySessionPrivateHome(extraHome("scrubbed-home"), scrubbed)).toBe("native");
  const kept = { ...scrubbed, keepEnv: ["GOOGLE_API_KEY"] };
  expect(populateAgySessionPrivateHome(extraHome("kept-home"), kept)).toBe("api-key");
  // A whitespace-only key is no key: the home arms native.
  const blank = { ...options, environment: { ...options.environment, GEMINI_API_KEY: "   " } };
  expect(populateAgySessionPrivateHome(extraHome("blank-home-1"), blank)).toBe("native");
});

test("an unrecognized marker still refuses the resume", () => {
  const { privateHome, options } = fixture();
  populateAgySessionPrivateHome(privateHome, options);
  writeFileSync(join(privateHome, ".codemux-login"), "unknown-arm", { mode: 0o600 });
  expect(() => verifyAgySessionPrivateHome(privateHome, options))
    .toThrow("lacks its recorded authentication configuration");
});

test.each([false, true])("plain and hermetic run homes retain native and file login: hermetic=%s", (hermetic) => {
  const { adapter, request, home } = setup(false);
  mkdirSync(join(home, ".gemini/antigravity-cli"), { recursive: true });
  writeFileSync(join(home, AGY_FILE_TOKEN), "synthetic-token");
  const context = adapter.prepareRun({ ...request, hermetic });
  expect(readlinkSync(join(context.agyProbe!.home!, AGY_FILE_TOKEN))).toBe(join(home, AGY_FILE_TOKEN));
  adapter.cleanupRunSync(context);
  expect(readFileSync(join(home, AGY_FILE_TOKEN), "utf8")).toBe("synthetic-token");
});

test("sandbox grants native Keychain paths only with opt-in and honors an explicit caller block", () => {
  const { source } = fixture();
  const denied = buildScodeCommand(["agy"], source, "read-only", { agentId: "agy" }, "scode", { HOME: source });
  const command = buildScodeCommand(["agy"], source, "read-only", { agentId: "agy", loginStore: true }, "scode", { HOME: source }, true);
  // The file token is agy's own state file and needs no opt-in.
  expect(denied[denied.indexOf(join(source, AGY_FILE_TOKEN)) - 1]).toBe("--allow");
  const paths = [join(source, AGY_FILE_TOKEN), ...agyLoginPaths(source)];
  for (const path of paths) {
    if (path !== join(source, AGY_FILE_TOKEN)) expect(denied).not.toContain(path);
    expect(command[command.indexOf(path) - 1]).toBe(path.endsWith("com.apple.security.plist") ? "--allow-ro" : "--allow");
  }
  expect(() => buildScodeCommand(["agy"], source, "read-only", { agentId: "agy", loginStore: true, blockPaths: [source] }, "scode", { HOME: source }, true)).toThrow();
});

test("a symlink planted on the way to a login link is never followed", () => {
  // Review round 5, security 4: a recursive mkdir followed a child-planted
  // `Library` or `.gemini/antigravity-cli` link and created the login link outside the home.
  const { source, privateHome, options } = fixture();
  const outside = join(dirname(privateHome), "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(privateHome, "Library"));
  expect(() => linkAgyLogin(privateHome, source, "darwin")).toThrow(join(privateHome, "Library"));
  expect(readdirSync(outside)).toEqual([]);
  rmSync(join(privateHome, "Library"));
  // A resumed session home: the child replaced the state directory with a link.
  populateAgySessionPrivateHome(privateHome, { ...options, platform: "linux" });
  rmSync(join(privateHome, ".gemini/antigravity-cli"), { recursive: true });
  symlinkSync(outside, join(privateHome, ".gemini/antigravity-cli"));
  let refusal: unknown;
  try { verifyAgySessionPrivateHome(privateHome, { ...options, platform: "linux" }); } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(UsageRefusalError);
  expect((refusal as Error).message).toContain(join(privateHome, ".gemini/antigravity-cli"));
  expect(readdirSync(outside)).toEqual([]);
  // A regular file in a directory's place refuses the same way.
  rmSync(join(privateHome, ".gemini/antigravity-cli"));
  writeFileSync(join(privateHome, ".gemini/antigravity-cli"), "not a directory");
  expect(() => linkAgyLogin(privateHome, source, "linux")).toThrow("symbolic link or a file");
});

test("a HOME that ends in a separator still links a gained login path at its real place on resume", () => {
  const { source, privateHome, options } = fixture();
  rmSync(join(source, AGY_FILE_TOKEN));
  populateAgySessionPrivateHome(privateHome, { ...options, platform: "linux" });
  writeFileSync(join(source, AGY_FILE_TOKEN), "synthetic token");
  const slashed = { ...options, environment: { HOME: `${source}/` }, platform: "linux" as const };
  expect(verifyAgySessionPrivateHome(privateHome, slashed)).toBe("native");
  expect(lstatSync(join(privateHome, AGY_FILE_TOKEN)).isSymbolicLink()).toBe(true);
  expect(readdirSync(privateHome).some((name) => name.startsWith("gemini") || name.startsWith("ibrary"))).toBe(false);
});
