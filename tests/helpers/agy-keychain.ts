import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spyOn } from "bun:test";
import { AgyAdapter } from "../../src/adapters/agy.js";
import { agyKeychainHost } from "../../src/agy-keychain.js";
import { createFakeBinaryEnv } from "./cli.js";
import type { RunRequest } from "../../src/types.js";

export const cleanup: (() => void)[] = [];
export const item = (path: string): string => JSON.parse(readFileSync(path, "utf8")).item;
export const loginItem = (record: { input: string[] }) => record.input[0] === "find-generic-password" ||
  (record.input[0] === "add-generic-password" && record.input[2] === "gemini");
export function setup(fail = "") {
  const home = mkdtempSync(join(tmpdir(), "agy-mirror-test-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const homeMock = spyOn(agyKeychainHost, "home").mockReturnValue(home);
  cleanup.push(() => homeMock.mockRestore());
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const fake = createFakeBinaryEnv({
    security: `exec ${quote(process.execPath)} ${quote(join(import.meta.dir, "..", "fixtures/agy-security.ts"))} "$@"`,
    agy: `if [ "$1" = "--version" ]; then printf '1.3.3\\n'; exit 0; fi
printf 'launched\\n' >> ${quote(join(home, "harness.log"))}
cat >/dev/null
printf '%s\\n' '{"event":"init","init":{}}' '{"event":"result","result":{"status":"SUCCESS","response":"OK"}}'`,
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
  // Only complete lines: a poller may read while a builder is still
  // appending, and the trailing partial line is not a record yet.
  const records = () => readFileSync(calls, "utf8").split("\n").slice(0, -1).filter((line) => line !== "").map((line) => JSON.parse(line));
  return { home, calls, secret, env, adapter, request, records, originalList };
}
