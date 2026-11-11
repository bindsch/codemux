/**
 * Hermetic and tools-none agy runs isolate through scode, not a harness
 * flag: the launcher blocks the operator's real ~/.gemini and re-allows
 * only the run's private home (src/launch/agy-isolation-sandbox.ts), so
 * every autonomy is accepted with scode and a launch without it is
 * refused. These tests pin the adapter rule, the real spawn's scode argv
 * at low and medium, the --print-sandbox preview, and the caller-block
 * refusals. The fake `security` on the fake PATH keeps every Keychain
 * operation synthetic (helpers/cli.ts).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyAdapter } from "../src/adapters/agy.js";
import type { RunRequest } from "../src/types.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

const scratch: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

/** A throwaway HOME with a CANONICAL path: the launch blocks
 * `join(HOME, ".gemini")` under HOME's own spelling (launch.ts,
 * operatorHome) while the private home it re-allows is created under the
 * canonicalized probe root (agy-keychain.ts, agyProbeRoots), so an
 * aliased TMPDIR spelling (/var vs /private/var on macOS) would
 * otherwise decide these assertions — the full-suite host runs one. */
const tempHome = (): string => realpathSync(tempDir("codemux-agy-sb-home-"));
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** The block and allow arguments of a printed or recorded scode argv. */
const valuesAfter = (argv: readonly string[], flag: string): string[] =>
  argv.filter((_, index) => index > 0 && argv[index - 1] === flag);

/** The fake agy: a version arm above the 1.2.14 floor, then the
 * stream-json frames an isolated run's result parser accepts. */
const FAKE_AGY = `if [ "$1" = "--version" ]; then printf '1.3.3\\n'; exit 0; fi
printf '%s\\n' '{"event":"init","init":{"tools":[]}}'
printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","response":"OK","usage":{"input_tokens":1,"output_tokens":1}}}'`;

/** The fake scode that proves it ran: a marker line, then one argument
 * per line. `--print-sandbox` output must carry the marker's absence. */
const RECORDING_SCODE = `printf 'FAKE-SCODE-RAN\\n'\nprintf '%s\\n' "$@"`;

const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
/** The fake scode of a real spawn: records its argv, then execs the
 * harness child unchanged (the session fixture's shape). */
const executingScode = (log: string): string =>
  `printf '%s\\n' "$@" >> ${quote(log)}\n` +
  'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n' +
  '[ "$#" -gt 0 ] || exit 99\nshift\nexec "$@"';

/** The operator state root the launch must block, and the probe root
 * whose only surviving entry may be the run's own private home. */
const stateRoots = (home: string) => {
  const real = join(home, ".gemini");
  return { real, probes: join(real, ".codemux-isolation-probes") };
};

/** One sandboxed hermetic or tools-none run's argv. */
const agyRunFlags = (isolation: readonly string[], autonomy: string, cwd: string): string[] => [
  "run", "-a", "agy", "--sandbox", ...isolation,
  "--auto", autonomy, "--cwd", cwd, "-p", "probe",
];

/** A clean working directory the hermetic walk accepts (the .git entry
 * stops it at the run's own tree). */
const cleanCwd = (): string => {
  const cwd = tempDir("codemux-agy-sb-cwd-");
  mkdirSync(join(cwd, ".git"));
  return cwd;
};

/** The block/allow contract of every isolated agy spawn: exactly the real
 * state tree blocked, exactly one allow inside it for the private home,
 * and the block ahead of the allow. */
const expectBlockedState = (argv: readonly string[], home: string, prefix = "run-"): string => {
  const { real, probes } = stateRoots(home);
  expect(valuesAfter(argv, "--block")).toEqual([real]);
  const allows = valuesAfter(argv, "--allow");
  expect(allows).toHaveLength(1);
  expect(allows[0]!.startsWith(join(probes, prefix))).toBe(true);
  // The block comes first: scode emits the child allow after the parent
  // block and re-asserts both in its final guards.
  expect(argv.indexOf("--block")).toBeLessThan(argv.indexOf("--allow"));
  return allows[0]!;
};

describe("agy isolation sandbox: unit", () => {
  test("every autonomy passes with scode; without scode every autonomy is refused", () => {
    const home = tempHome();
    const adapter = new AgyAdapter({ HOME: home, GEMINI_API_KEY: "synthetic-api-key" });
    const request: RunRequest =
      { agent: "agy", cwd: cleanCwd(), prompt: "probe", autonomy: "read-only", sandboxed: true };
    for (const isolated of [{ hermetic: true }, { tools: "none" as const }]) {
      for (const autonomy of ["read-only", "low", "medium", "high"] as const) {
        expect(() => adapter.validateRunRequest({ ...request, ...isolated, autonomy })).not.toThrow();
      }
      // Without scode there is no boundary at all, whatever the autonomy.
      expect(() => adapter.validateRunRequest({ ...request, ...isolated, sandboxed: false }))
        .toThrow("agy isolation requires scode (--sandbox) at every autonomy");
    }
  });
});

describe("agy isolation sandbox: run argv", () => {
  test.each([
    { label: "hermetic at low", isolation: ["--hermetic"], autonomy: "low" },
    { label: "hermetic at medium", isolation: ["--hermetic"], autonomy: "medium" },
    { label: "tools none at low", isolation: ["--tools", "none"], autonomy: "low" },
  ])("$label blocks the real state and allows only the private home", async ({ isolation, autonomy }) => {
    const home = tempHome();
    const log = join(tempDir("codemux-agy-sb-state-"), "scode.txt");
    const fake = createFakeBinaryEnv({ agy: FAKE_AGY, scode: executingScode(log) });
    try {
      const result = await runCli(agyRunFlags(isolation, autonomy, cleanCwd()), {
        ...fake.env, HOME: home,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("OK");
      const argv = readFileSync(log, "utf8").trim().split("\n");
      expectBlockedState(argv, home);
      // The requested autonomy reached scode: low and medium are writable,
      // not pinned to the read-only --ro the old rule demanded.
      expect(argv).toContain("--rw");
      // The launch cleaned its private home up.
      expect(readdirSync(stateRoots(home).probes)).toEqual([]);
    } finally {
      fake.cleanup();
    }
  }, 30_000);

  test("a caller --sandbox-block rides the argv; one over the state tree refuses with 64", async () => {
    const home = tempHome();
    const log = join(tempDir("codemux-agy-sb-state-"), "scode.txt");
    const fake = createFakeBinaryEnv({ agy: FAKE_AGY, scode: executingScode(log) });
    try {
      const riding = await runCli(
        [...agyRunFlags(["--hermetic"], "medium", cleanCwd()), "--sandbox-block", "/opt/operator-only"],
        { ...fake.env, HOME: home }
      );
      expect(riding.exitCode, riding.stderr).toBe(0);
      expect(valuesAfter(readFileSync(log, "utf8").trim().split("\n"), "--block")).toEqual([
        "/opt/operator-only",
        stateRoots(home).real,
      ]);

      const refused = await runCli(
        [...agyRunFlags(["--hermetic"], "medium", cleanCwd()), "--sandbox-block", stateRoots(home).real],
        { ...fake.env, HOME: home }
      );
      expect(refused.exitCode).toBe(64);
      // The later --allow would re-open exactly the caller's block, so
      // the launch refuses naming both paths and leaves no home behind.
      expect(refused.stderr).toContain("covers the launch's own harness state directory");
      expect(readdirSync(stateRoots(home).probes)).toEqual([]);
    } finally {
      fake.cleanup();
    }
  }, 30_000);

  test("run --print-sandbox previews the same block and allow without spawning", async () => {
    const home = tempHome();
    const fake = createFakeBinaryEnv({ agy: FAKE_AGY, scode: RECORDING_SCODE });
    try {
      const result = await runCli(
        [...agyRunFlags(["--hermetic"], "low", cleanCwd()), "--print-sandbox"],
        { ...fake.env, HOME: home }
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("FAKE-SCODE-RAN");
      const argv = result.stdout.trimEnd().split("\n");
      expect(argv[0]!.endsWith("/scode")).toBe(true);
      expectBlockedState(argv, home, "preview");
      // Nothing spawned; no private home or parent was created.
      expect(existsSync(stateRoots(home).real)).toBe(false);
    } finally {
      fake.cleanup();
    }
  }, 30_000);
});
