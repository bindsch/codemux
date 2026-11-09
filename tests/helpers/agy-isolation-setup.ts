/** Shared synthetic agy isolation setup: a private HOME, a mocked
 * Keychain host, and an agy adapter with a synthetic API key. No harness,
 * Keychain, or provider is used. Callers register `cleanupAgyIsolation`
 * in afterEach. */
import { spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGY_MIRROR_PATH, AGY_TEMPLATE_NAME, agyKeychainHost, agyKeychainStateDir } from "../../src/agy-keychain.js";
import { AgyAdapter } from "../../src/adapters/agy.js";
import type { RunRequest } from "../../src/types.js";

export const dirs: string[] = [];
let homeMock: ReturnType<typeof spyOn> | undefined;
const keychainMocks: ReturnType<typeof spyOn>[] = [];
export function cleanupAgyIsolation(): void {
  for (const mock of keychainMocks.splice(0).reverse()) mock.mockRestore();
  homeMock?.mockRestore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}
export function setup(apiKey = true) {
  const home = mkdtempSync(join(tmpdir(), "codemux-agy-probe-test-"));
  dirs.push(home);
  homeMock = spyOn(agyKeychainHost, "home").mockReturnValue(home);
  keychainMocks.push(spyOn(agyKeychainHost, "securityPath").mockReturnValue(process.execPath));
  mkdirSync(agyKeychainStateDir(), { recursive: true });
  writeFileSync(join(agyKeychainStateDir(), AGY_TEMPLATE_NAME), "empty template");
  writeFileSync(join(agyKeychainStateDir(), `${AGY_TEMPLATE_NAME}.password`), "a".repeat(32));
  const keychainCalls: { args: string[]; home: string; input: string }[] = [];
  keychainMocks.push(spyOn(agyKeychainHost, "spawnSync").mockImplementation(((command: string[], options: { env: NodeJS.ProcessEnv; stdin: Buffer | "ignore" }) => {
    const args = command.slice(1);
    keychainCalls.push({ args, home: options.env.HOME!, input: Buffer.isBuffer(options.stdin) ? options.stdin.toString() : "" });
    const output = args[0] === "default-keychain" ? `"${join(options.env.HOME!, AGY_MIRROR_PATH)}"\n` : "";
    return { stdout: Buffer.from(output), stderr: Buffer.alloc(0), exitCode: 0, signalCode: null };
  }) as unknown as typeof Bun.spawnSync));
  const cwd = join(home, "workspace");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const request: RunRequest = { agent: "agy", prompt: "probe", cwd, autonomy: "read-only", sandboxed: true };
  return { home, request, keychainCalls, adapter: new AgyAdapter({ HOME: home, ...(apiKey ? { GEMINI_API_KEY: "synthetic-api-key" } : {}) }) };
}
