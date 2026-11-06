/** The agy file-token copy (review round 169, finding 7): the token is
 * read once through a single non-following, non-blocking, bounded open
 * (readAgyTokenForCopy) and the private copy is written from those bytes,
 * undecoded (review round 170).
 * A symlink, a FIFO, or an oversized token refuses naming the reason; a
 * missing token takes the Keychain path. The host seam is stubbed and
 * every home is a temp directory, so the real home's token is never
 * read. */

import { afterEach, expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyAdapter } from "../src/adapters/agy.js";
import {
  AGY_MIRROR_PATH,
  AGY_TEMPLATE_NAME,
  agyKeychainHost,
  agyKeychainStateDir,
} from "../src/agy-keychain.js";
import type { RunRequest } from "../src/types.js";

const TOKEN = ".gemini/antigravity-cli/antigravity-oauth-token";

const dirs: string[] = [];
const mocks: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const mock of mocks.splice(0).reverse()) mock.mockRestore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(apiKey: boolean): {
  home: string;
  request: RunRequest;
  keychainCalls: { args: string[]; home: string }[];
  adapter: AgyAdapter;
} {
  const home = mkdtempSync(join(tmpdir(), "codemux-agy-token-copy-"));
  dirs.push(home);
  mocks.push(spyOn(agyKeychainHost, "home").mockReturnValue(home));
  mocks.push(spyOn(agyKeychainHost, "securityPath").mockReturnValue(process.execPath));
  mkdirSync(agyKeychainStateDir(), { recursive: true });
  writeFileSync(join(agyKeychainStateDir(), AGY_TEMPLATE_NAME), "empty template");
  writeFileSync(join(agyKeychainStateDir(), `${AGY_TEMPLATE_NAME}.password`), "a".repeat(32));
  const keychainCalls: { args: string[]; home: string }[] = [];
  mocks.push(spyOn(agyKeychainHost, "spawnSync").mockImplementation(((
    command: string[],
    options: { env: NodeJS.ProcessEnv; stdin: Buffer | "ignore" }
  ) => {
    const args = command.slice(1);
    keychainCalls.push({ args, home: options.env.HOME! });
    const output =
      args[0] === "default-keychain" ? `"${join(options.env.HOME!, AGY_MIRROR_PATH)}"\n` : "";
    return { stdout: Buffer.from(output), stderr: Buffer.alloc(0), exitCode: 0, signalCode: null };
  }) as unknown as typeof Bun.spawnSync));
  const cwd = join(home, "workspace");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const request: RunRequest = { agent: "agy", prompt: "probe", cwd, autonomy: "read-only", sandboxed: true };
  return {
    home,
    request,
    keychainCalls,
    adapter: new AgyAdapter({ HOME: home, ...(apiKey ? { GEMINI_API_KEY: "synthetic-api-key" } : {}) }),
  };
}

const writeToken = (home: string, content: string): string => {
  const path = join(home, TOKEN);
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  writeFileSync(path, content);
  return path;
};

test("a regular file token is copied byte for byte into the probe home", () => {
  const { home, request, keychainCalls, adapter } = setup(false);
  const content = "synthetic token with multibyte text — dots · and one rocket 🚀";
  writeToken(home, content);
  const context = adapter.prepareRun(request);
  try {
    const copy = join(context.agyProbe!.home!, TOKEN);
    expect(readFileSync(copy, "utf8")).toBe(content);
    expect(readFileSync(copy)).toEqual(Buffer.from(content, "utf8"));
    // A present file token means no Keychain login read.
    expect(keychainCalls.some((call) => call.args[0] === "find-generic-password")).toBe(false);
  } finally {
    adapter.cleanupRun(context);
  }
});

test("the copy keeps a leading byte-order mark and bytes that are not UTF-8", () => {
  // Review round 170: the token is opaque to codemux. A text decode drops
  // a leading EF BB BF and refuses bytes that are not UTF-8; the copy is
  // made from the bytes as read.
  const shapes = [
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("synthetic token after a mark")]),
    Buffer.from([0x73, 0x79, 0x6e, 0xff, 0xfe, 0x00, 0x80, 0x74]),
  ];
  for (const bytes of shapes) {
    const { home, request, keychainCalls, adapter } = setup(false);
    const path = join(home, TOKEN);
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(path, bytes);
    const context = adapter.prepareRun(request);
    try {
      expect(readFileSync(join(context.agyProbe!.home!, TOKEN))).toEqual(bytes);
      expect(keychainCalls.some((call) => call.args[0] === "find-generic-password")).toBe(false);
    } finally {
      adapter.cleanupRun(context);
    }
  }
});

test("an empty token file is a token, not an absence", () => {
  // The copy branch compares against null, never truthiness: an empty
  // token file still suppresses the Keychain path and still copies.
  const { home, request, keychainCalls, adapter } = setup(false);
  writeToken(home, "");
  const context = adapter.prepareRun(request);
  try {
    expect(readFileSync(join(context.agyProbe!.home!, TOKEN), "utf8")).toBe("");
    expect(keychainCalls.some((call) => call.args[0] === "find-generic-password")).toBe(false);
  } finally {
    adapter.cleanupRun(context);
  }
});

test("a symlinked token is refused, never followed", () => {
  const { home, request, adapter } = setup(false);
  const target = join(home, "real-token");
  writeFileSync(target, "secret");
  const path = join(home, TOKEN);
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  symlinkSync(target, path);
  expect(() => adapter.prepareRun(request)).toThrow(
    "the agy file token must not be a symbolic link"
  );
});

test("a FIFO token is refused without blocking", () => {
  if (process.platform === "win32") return;
  const { home, request, adapter } = setup(false);
  const path = join(home, TOKEN);
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  if (Bun.spawnSync(["mkfifo", path]).exitCode !== 0) return; // mkfifo unavailable
  expect(() => adapter.prepareRun(request)).toThrow(
    "the agy file token is not a regular file"
  );
});

test("an oversized token is refused", () => {
  const { home, request, adapter } = setup(false);
  writeToken(home, "x".repeat(1024 * 1024 + 1));
  expect(() => adapter.prepareRun(request)).toThrow("the agy file token exceeds 1048576 bytes");
});

test("no token file takes the Keychain login path", () => {
  const { request, keychainCalls, adapter } = setup(false);
  // The stubbed login read answers, the mirror build then stops at the
  // missing agy executable — the Keychain path's own failure, reached
  // only because no file token existed.
  expect(() => adapter.prepareRun(request)).toThrow("agy executable is unavailable");
  expect(keychainCalls.some((call) => call.args[0] === "find-generic-password")).toBe(true);
});
