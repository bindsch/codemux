/** Synthetic login fixture. No native credential backend. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyAdapter } from "../../src/adapters/agy.js";
import { createFakeBinaryEnv } from "./cli.js";
import type { RunRequest } from "../../src/types.js";

export const cleanup: (() => void)[] = [];
export function setup() {
  const home = mkdtempSync(join(tmpdir(), "agy-api-test-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const calls = join(home, "forbidden-calls.jsonl");
  // A recording fake sits first on PATH: any `security` invocation the
  // launch path could make appends its arguments here, so the tests'
  // "the file does not exist" assertions can actually fail.
  const fake = createFakeBinaryEnv({
    agy: 'if [ "$1" = "--version" ]; then printf "1.5.9\\n"; exit 0; fi\ncat >/dev/null\nprintf \'%s\\n\' \'{"event":"result","result":{"status":"SUCCESS","response":"OK"}}\'',
    scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
    security: `printf '%s\\n' "$*" >> "${calls}"`,
  });
  cleanup.push(fake.cleanup);
  const env: Record<string, string> = { ...fake.env, HOME: home, GEMINI_API_KEY: "synthetic" };
  const adapter = new AgyAdapter(env);
  const cwd = join(home, "work");
  mkdirSync(cwd);
  const request: RunRequest = { agent: "agy", cwd, prompt: "OK", sandboxed: true, autonomy: "read-only" };
  return { home, calls, env, adapter, request };
}
