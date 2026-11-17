// agy's file token is agy's own state file, not the Keychain login store:
// every agy sandbox on the operator login is granted that one file by exact
// path, on every platform, without --sandbox-login-store (review round 3).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGY_FILE_TOKEN } from "../src/agy-auth.js";
import { applyAgyIsolationSandboxBlocks } from "../src/launch/agy-isolation-sandbox.js";
import { buildScodeCommand, type SandboxOptions } from "../src/sandbox.js";
import { grantsAgyFileToken } from "../src/sandbox-login-policy.js";

const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/agy-file-token-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const state = join(root, ".gemini");
const token = join(root, AGY_FILE_TOKEN);
const privateHome = join(state, ".codemux-isolation-probes", "run-synthetic");
for (const path of [join(state, "antigravity-cli"), privateHome, join(root, "Library/Keychains")]) {
  mkdirSync(path, { recursive: true });
}
writeFileSync(token, "synthetic token");

const values = (argv: string[], flag: string) => argv.filter((_, i) => argv[i - 1] === flag);
/** The isolated launch's options: real state blocked, private home re-allowed. */
function isolated(extra: SandboxOptions = {}): SandboxOptions {
  const options: SandboxOptions = { agentId: "agy", ...extra };
  applyAgyIsolationSandboxBlocks(options, { realStateRoot: state, privateHome });
  return options;
}
const build = (options: SandboxOptions, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}) =>
  buildScodeCommand(["/bin/echo", "synthetic"], undefined, "low", options, "scode",
    { HOME: root, ...env }, true, true, true, platform);

test.each(["darwin", "linux"] as const)(
  "%s: an isolated agy sandbox grants the file token alone, without the login-store opt-in", (platform) => {
    const argv = build(isolated(), platform);
    expect(argv).toContain("--no-login-store");
    expect(values(argv, "--block")).toEqual([state]);
    // The private home and the one token file: never the token's directory,
    // never the Keychain paths.
    expect(values(argv, "--allow")).toEqual([privateHome, token]);
    expect(values(argv, "--allow-ro")).toEqual([]);
    expect(argv).not.toContain(join(state, "antigravity-cli"));
    expect(argv).not.toContain(join(root, "Library/Keychains"));
  });

test.each(["darwin", "linux"] as const)(
  "%s: untrusted trust, --sandbox-no-login-store and an API key withhold the file token", (platform) => {
    for (const [options, env] of [
      [isolated({ trust: "untrusted" }), {}],
      [isolated({ noLoginStore: true }), {}],
      [isolated({ loginStore: true, noLoginStore: true }), {}],
      [isolated(), { GEMINI_API_KEY: "synthetic" }],
      [isolated(), { GOOGLE_API_KEY: "synthetic" }],
    ] as const) {
      expect(build(options, platform, env)).not.toContain(token);
    }
  });

test.each(["darwin", "linux"] as const)("%s: plain agy sandboxes get the same grant; other agents never do", (platform) => {
  expect(values(build({ agentId: "agy" }, platform), "--allow")).toEqual([token]);
  for (const agentId of ["claude", "zai", "codex", "kimi"] as const) {
    expect(build({ agentId }, platform)).not.toContain(token);
  }
});

test("a missing token is not granted and not created; the login-store opt-in keeps the grant", () => {
  const empty = join(root, "no-token");
  mkdirSync(join(empty, ".gemini/antigravity-cli"), { recursive: true });
  const argv = build({ agentId: "agy" }, "linux", { HOME: empty });
  expect(values(argv, "--allow")).toEqual([]);
  expect(values(build({ agentId: "agy", loginStore: true }, "linux"), "--allow")).toEqual([token]);
  expect(values(build({ agentId: "agy", loginStore: true }, "darwin"), "--allow"))
    .toEqual([join(root, "Library/Keychains"), token]);
});

test("a caller's own block over the token wins over the default grant and is refused with the opt-in", () => {
  for (const blocked of [token, join(state, "antigravity-cli"), state]) {
    const argv = build({ agentId: "agy", blockPaths: [blocked] }, "linux");
    expect(values(argv, "--block")).toEqual([blocked]);
    expect(values(argv, "--allow")).toEqual([]);
  }
  expect(() => build({ agentId: "agy", loginStore: true, blockPaths: [token] }, "linux")).toThrow("--sandbox-block");
});

test("the token decision is made on the delivered environment", () => {
  expect(grantsAgyFileToken({ agentId: "agy" }, {})).toBe(true);
  expect(grantsAgyFileToken({ agentId: "agy", scrubEnv: true }, { GEMINI_API_KEY: "synthetic" })).toBe(true);
  expect(grantsAgyFileToken({ agentId: "agy", scrubEnv: true, keepEnv: ["GEMINI_API_KEY"] },
    { GEMINI_API_KEY: "synthetic" })).toBe(false);
  expect(grantsAgyFileToken({ agentId: "claude" }, {})).toBe(false);
});
