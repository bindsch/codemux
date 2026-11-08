/**
 * The agy isolation probe's --cwd requirement (review round 341): a probe
 * request without a working directory used to pass the door check and
 * crash at the diagnostic write's null dereference; it is a usage refusal
 * at markAgyIsolationProbe now. Split from tests/agy-isolation.test.ts at
 * the 500-line cap. The keychain host is stubbed (temp home, fake
 * security, spawnSync recorder) — no real Keychain read ever runs.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyAdapter, markAgyIsolationProbe } from "../src/adapters/agy.js";
import { AGY_MIRROR_PATH, AGY_TEMPLATE_NAME, agyKeychainHost, agyKeychainStateDir } from "../src/agy-keychain.js";
import { UsageRefusalError } from "../src/validation.js";
import type { RunRequest, RunResult } from "../src/types.js";

const dirs: string[] = [];
const mocks: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const mock of mocks.splice(0).reverse()) mock.mockRestore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "codemux-agy-probe-cwd-"));
  dirs.push(home);
  mocks.push(spyOn(agyKeychainHost, "home").mockReturnValue(home));
  mocks.push(spyOn(agyKeychainHost, "securityPath").mockReturnValue(process.execPath));
  mkdirSync(agyKeychainStateDir(), { recursive: true });
  writeFileSync(join(agyKeychainStateDir(), AGY_TEMPLATE_NAME), "empty template");
  writeFileSync(join(agyKeychainStateDir(), `${AGY_TEMPLATE_NAME}.password`), "a".repeat(32));
  mocks.push(spyOn(agyKeychainHost, "spawnSync").mockImplementation(((command: string[], options: { env: NodeJS.ProcessEnv }) => {
    const args = command.slice(1);
    const output = args[0] === "default-keychain" ? `"${join(options.env.HOME ?? home, AGY_MIRROR_PATH)}"\n` : "";
    return { stdout: Buffer.from(output), stderr: Buffer.alloc(0), exitCode: 0, signalCode: null };
  }) as unknown as typeof Bun.spawnSync));
  const cwd = join(home, "workspace");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const request: RunRequest = { agent: "agy", prompt: "probe", cwd, autonomy: "read-only", sandboxed: true };
  return { home, cwd, request, adapter: new AgyAdapter({ HOME: home, GEMINI_API_KEY: "synthetic-api-key" }) };
}

const result = (stdout: string, exitCode = 0): RunResult => ({
  stdout,
  stderr: "native stderr",
  exitCode,
  success: exitCode === 0,
});

test("an isolation probe request without --cwd is a usage refusal, not a crash (round 341)", () => {
  const { home, request } = setup();
  const bare: RunRequest = { ...request, cwd: undefined };
  // The pre-fix code marked the request and crashed at the diagnostic
  // write's null dereference; the refusal names the missing flag.
  expect(() => markAgyIsolationProbe(bare, "tools", home)).toThrow(UsageRefusalError);
  expect(() => markAgyIsolationProbe(bare, "tools", home)).toThrow(/require an explicit --cwd/);
  // A request with a working directory still marks.
  expect(() => markAgyIsolationProbe(request, "tools", home)).not.toThrow();
});

test("a marked probe writes its native captures beside --cwd (round 341)", () => {
  const { home, cwd, request, adapter } = setup();
  markAgyIsolationProbe(request, "tools", home);
  const context = adapter.prepareRun(request);
  try {
    const stdout = [
      JSON.stringify({ event: "init", init: {} }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "OK", denied_actions: [] } }),
    ].join("\n");
    adapter.processRunResult(result(stdout), request, context);
    expect(readFileSync(join(cwd, "..", "native-events.jsonl"), "utf8")).toBe(stdout);
    expect(readFileSync(join(cwd, "..", "native-stderr.txt"), "utf8")).toBe("native stderr");
  } finally {
    adapter.cleanupRun(context);
  }
});
