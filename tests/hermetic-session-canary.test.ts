/**
 * The hermetic session canary's own tests (lane H4). The three-session
 * flow drives the fake codemux session CLI (the fixture below) through
 * the canary's command seam — one scenario per failure the canary must
 * catch, plus the request guards and the per-agent planting shapes. No
 * harness binary and no provider is contacted: every child the canary
 * starts is the fixture under the running bun.
 */
import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSessionCanaryRequest,
  plantSessionCanary,
  runHermeticSessionCanary,
  sessionCanary,
  type SessionCanaryGuards,
} from "../src/hermetic-session-canary.js";
import { runCanarySession } from "../src/hermetic-session-canary-driver.js";

const FAKE = fileURLToPath(new URL("./fixtures/live/fake-codemux-session.ts", import.meta.url));

interface FakeSpawn {
  argv: string[];
  hermetic: boolean;
  resume: string | null;
  final: boolean;
  sessionId: string;
  marker: string;
}

const scratch = (): string => mkdtempSync(join(tmpdir(), "hermetic-session-canary-test-"));

/** Points the canary's sessions at the fixture (scenario selected) and
 * returns the fake's state file and home root. */
function useFake(scenario: string): { homeRoot: string; stateFile: string; restore: () => void } {
  const homeRoot = scratch();
  const stateFile = join(homeRoot, "state.jsonl");
  const command = spyOn(sessionCanary, "command").mockReturnValue([process.execPath, FAKE]);
  const scenario0 = process.env.FAKE_CODEMUX_SCENARIO;
  const homeRoot0 = process.env.FAKE_CODEMUX_HOME_ROOT;
  const state0 = process.env.FAKE_CODEMUX_STATE;
  process.env.FAKE_CODEMUX_SCENARIO = scenario;
  process.env.FAKE_CODEMUX_HOME_ROOT = homeRoot;
  process.env.FAKE_CODEMUX_STATE = stateFile;
  return {
    homeRoot,
    stateFile,
    restore: () => {
      command.mockRestore();
      for (const [name, value] of [
        ["FAKE_CODEMUX_SCENARIO", scenario0],
        ["FAKE_CODEMUX_HOME_ROOT", homeRoot0],
        ["FAKE_CODEMUX_STATE", state0],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

/** One JSON line per session the canary started, as the fake recorded. */
const spawns = (stateFile: string): FakeSpawn[] =>
  readFileSync(stateFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as FakeSpawn);

/** Captures everything the canary prints, so failures are asserted on
 * their messages without drowning the test output. */
function capture(): { errors: string[]; out: string[]; restore: () => void } {
  const errors: string[] = [];
  const out: string[] = [];
  const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    errors.push(values.map(String).join(" "));
  });
  const stderrWrite = spyOn(process.stderr, "write").mockImplementation(((chunk: Uint8Array | string) => {
    errors.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write);
  const write = spyOn(process.stdout, "write").mockImplementation(((chunk: Uint8Array | string) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  return { errors, out, restore: () => { error.mockRestore(); stderrWrite.mockRestore(); write.mockRestore(); } };
}

async function runCanary(
  scenario: string,
  timeoutMs = 10_000,
  killGraceMs = 2_000
): Promise<{ code: number; errors: string; out: string; homeRoot: string; stateFile: string; restore: () => void }> {
  const fake = useFake(scenario);
  const printed = capture();
  try {
    const code = await runHermeticSessionCanary({ agent: "claude", autonomy: "read-only", passthroughEnv: [], timeoutMs, killGraceMs });
    return {
      code, errors: printed.errors.join("\n"), out: printed.out.join(""),
      homeRoot: fake.homeRoot, stateFile: fake.stateFile,
      restore: () => { printed.restore(); fake.restore(); },
    };
  } finally {
    printed.restore();
    fake.restore();
  }
}

test("the canary's default command is this checkout's own CLI", () => {
  // The tests point the seam at the fixture; the unmocked default must
  // still be this build's entry point, not whatever codemux is on PATH.
  const command = sessionCanary.command();
  expect(command[0]).toBe(process.execPath);
  expect(command.at(-1)!.endsWith(join("src", "index.ts"))).toBe(true);
});

test("a clean harness passes the hermetic session, the control, and the resume", async () => {
  const run = await runCanary("clean");
  try {
    expect(run.code).toBe(0);
    expect(run.out).toContain("HERMETIC SESSION claude: OK");
    const runs = spawns(run.stateFile);
    expect(runs).toHaveLength(3);
    expect(runs[0]!.argv.slice(0, 3)).toEqual(["session", "-a", "claude"]);
    expect(runs[0]!.hermetic).toBe(true);
    expect(runs[0]!.resume).toBeNull();
    expect(runs[0]!.final).toBe(false);
    expect(runs[0]!.argv).toContain("-s");
    expect(runs[0]!.argv).toContain("--auto");
    expect(runs[0]!.argv.join(" ")).toContain("--auto read-only");
    expect(runs[1]!.hermetic).toBe(false);
    expect(runs[1]!.final).toBe(false);
    expect(runs[2]!.hermetic).toBe(true);
    expect(runs[2]!.resume).toBe("fake-session-1");
    expect(runs[2]!.final).toBe(true);
    // The planted cwd is scratch: gone after the check, and the private
    // home the resumed session's --final was to remove is gone too.
    expect(existsSync(runs[0]!.argv[runs[0]!.argv.indexOf("--cwd") + 1]!)).toBe(false);
    expect(readdirSync(run.homeRoot)).toEqual(["state.jsonl"]);
  } finally {
    rmSync(run.homeRoot, { recursive: true, force: true });
  }
});

test("a first-session leak fails, names the leak, and cleans up its scratch", async () => {
  const run = await runCanary("leak");
  try {
    expect(run.code).toBe(1);
    expect(run.errors).toContain(
      "Error: the hermetic claude session is NOT hermetic: the planted code word reached the model"
    );
    const runs = spawns(run.stateFile);
    expect(runs).toHaveLength(1);
    expect(existsSync(runs[0]!.argv[runs[0]!.argv.indexOf("--cwd") + 1]!)).toBe(false);
    // The private home was reported before the failure, so the finally
    // removed it even though the session never reached --final.
    expect(existsSync(join(run.homeRoot, "fake-session-1"))).toBe(false);
  } finally {
    rmSync(run.homeRoot, { recursive: true, force: true });
  }
});

test("a clean control fails the check as proving nothing", async () => {
  const run = await runCanary("clean-control");
  try {
    expect(run.code).toBe(1);
    expect(run.errors).toContain(
      "Error: hermetic claude session answered OK, but the check proved nothing: clean too, so the planted files never reached the model"
    );
    expect(spawns(run.stateFile)).toHaveLength(2);
  } finally {
    rmSync(run.homeRoot, { recursive: true, force: true });
  }
});

test("a resume leak fails the resumed session by name", async () => {
  const run = await runCanary("resume-leak");
  try {
    expect(run.code).toBe(1);
    expect(run.errors).toContain(
      "Error: the resumed hermetic claude session is NOT hermetic: the planted code word reached the model"
    );
    const runs = spawns(run.stateFile);
    expect(runs).toHaveLength(3);
    expect(runs[2]!.resume).toBe("fake-session-1");
  } finally {
    rmSync(run.homeRoot, { recursive: true, force: true });
  }
});

test("a private home that does not persist past its session fails the check", async () => {
  const run = await runCanary("no-persist");
  try {
    expect(run.code).toBe(1);
    expect(run.errors).toContain("did not persist past the hermetic session's end");
    expect(spawns(run.stateFile)).toHaveLength(1);
  } finally {
    rmSync(run.homeRoot, { recursive: true, force: true });
  }
});

test("a --final that leaves the home behind fails, and the canary removes it anyway", async () => {
  const run = await runCanary("final-keeps-home");
  try {
    expect(run.code).toBe(1);
    expect(run.errors).toContain("Error: --final left the private session home behind");
    expect(spawns(run.stateFile)).toHaveLength(3);
    expect(readdirSync(run.homeRoot)).toEqual(["state.jsonl"]);
  } finally {
    rmSync(run.homeRoot, { recursive: true, force: true });
  }
});

test("a session refusal surfaces as the check's failure naming the exit", async () => {
  const run = await runCanary("refuse");
  try {
    expect(run.code).toBe(1);
    expect(run.errors).toContain("Error: the hermetic claude session exited 64");
    expect(run.errors).toContain("--hermetic is refused for sessions in this release");
    expect(spawns(run.stateFile)).toHaveLength(1);
  } finally {
    rmSync(run.homeRoot, { recursive: true, force: true });
  }
});

test("a mid-turn crash fails the check naming the exit", async () => {
  const run = await runCanary("crash");
  try {
    expect(run.code).toBe(1);
    expect(run.errors).toContain("Error: the hermetic claude session exited 1");
  } finally {
    rmSync(run.homeRoot, { recursive: true, force: true });
  }
});

test("a hung session is stopped at the deadline and fails the check", async () => {
  const run = await runCanary("hang", 700, 300);
  try {
    expect(run.code).toBe(1);
    expect(run.errors).toContain("the session ran past its deadline and was stopped");
  } finally {
    rmSync(run.homeRoot, { recursive: true, force: true });
  }
});

test("a session child that cannot start fails the check naming the spawn error", async () => {
  const command = spyOn(sessionCanary, "command").mockReturnValue(["/nonexistent/codemux-h4"]);
  const printed = capture();
  try {
    const code = await runHermeticSessionCanary({
      agent: "claude", autonomy: "read-only", passthroughEnv: [], timeoutMs: 2_000,
    });
    expect(code).toBe(1);
    expect(printed.errors.join("\n")).toContain("the codemux session child could not start");
  } finally {
    printed.restore();
    command.mockRestore();
  }
});

test("the deadline kill escalates to SIGKILL when the child ignores SIGTERM", async () => {
  const fake = useFake("hang");
  const ignore0 = process.env.FAKE_CODEMUX_IGNORE_SIGTERM;
  process.env.FAKE_CODEMUX_IGNORE_SIGTERM = "1";
  try {
    const run = await runCanarySession(
      ["session", "-a", "claude", "--hermetic", "-s", "--auto", "read-only"],
      process.env, "the question", 500, 200
    );
    expect(run.stopped).toBe(true);
    expect(run.failure).toBe("the session ran past its deadline and was stopped");
    expect(run.exitCode).not.toBe(0);
  } finally {
    if (ignore0 === undefined) delete process.env.FAKE_CODEMUX_IGNORE_SIGTERM;
    else process.env.FAKE_CODEMUX_IGNORE_SIGTERM = ignore0;
    fake.restore();
    rmSync(fake.homeRoot, { recursive: true, force: true });
  }
});

test("a session that ends by stdin-close instead of the shutdown frame fails", async () => {
  const run = await runCanary("wrong-end");
  try {
    expect(run.code).toBe(1);
    expect(run.errors).toContain("ended with reason 'stdin-close', not 'shutdown'");
  } finally {
    rmSync(run.homeRoot, { recursive: true, force: true });
  }
});

const guards: SessionCanaryGuards = {
  wanted: true,
  agent: "claude",
  hermetic: true,
  supportsHermetic: true,
  sandbox: true,
  tools: undefined,
  experimentMcp: false,
  agyProbe: false,
  printSandbox: false,
  sandboxOverrides: undefined,
};

test("assertSessionCanaryRequest passes a valid session check request", () => {
  // A sandboxed probe always parses a policy object; with no flag set it
  // carries no override, so it is as good as none.
  expect(() => assertSessionCanaryRequest(guards)).not.toThrow();
  expect(() => assertSessionCanaryRequest({ ...guards, sandboxOverrides: { noNet: false } })).not.toThrow();
  expect(() => assertSessionCanaryRequest({ ...guards, wanted: false, hermetic: false })).not.toThrow();
});

test("assertSessionCanaryRequest refuses every shape the session canary cannot carry", () => {
  const refusals: [Partial<SessionCanaryGuards>, RegExp][] = [
    [{ hermetic: false }, /--session requires --hermetic/],
    [{ agent: "qwen" }, /qwen has no session driver:.*docs\/sessions\.md/],
    [{ agent: "aider", supportsHermetic: false }, /aider has no verified hermetic mode;.*docs\/isolation\.md/],
    [{ tools: "none" }, /--session cannot carry --tools/],
    [{ experimentMcp: true }, /--session cannot carry --experiment-mcp/],
    [{ agyProbe: true }, /--session cannot carry --agy-isolation-probe/],
    [{ printSandbox: true }, /--session cannot carry --print-sandbox/],
    [{ sandbox: false }, /--session cannot carry --no-sandbox/],
    [{ sandboxOverrides: { trust: "standard" } }, /--session cannot carry the sandbox policy overrides/],
    [{ sandboxOverrides: { noNet: true } }, /--session cannot carry the sandbox policy overrides/],
    [{ sandboxOverrides: { blockPaths: ["/tmp"] } }, /--session cannot carry the sandbox policy overrides/],
  ];
  for (const [override, message] of refusals) {
    expect(() => assertSessionCanaryRequest({ ...guards, ...override })).toThrow(message);
  }
});

test("plantSessionCanary plants the run canary's files for plain agents", () => {
  const parent = scratch();
  const planted = plantSessionCanary("claude", parent);
  try {
    expect(existsSync(join(planted.cwd, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(planted.cwd, "CLAUDE.md"))).toBe(true);
    expect(readFileSync(join(planted.cwd, "AGENTS.md"), "utf8")).toContain(planted.marker);
    expect(planted.secrets).toEqual([]);
    expect(planted.env).toEqual({});
  } finally {
    planted.cleanup();
    rmSync(parent, { recursive: true, force: true });
  }
  expect(existsSync(planted.cwd)).toBe(false);
});

test("plantSessionCanary redirects kimi's homes into scratch", () => {
  const home = scratch();
  const original = process.env.HOME;
  process.env.HOME = home;
  let planted: ReturnType<typeof plantSessionCanary> | undefined;
  let plantedHome: string | undefined;
  try {
    planted = plantSessionCanary("kimi");
    plantedHome = planted.env.HOME!;
    const brandHome = planted.env.KIMI_CODE_HOME!;
    expect(plantedHome.startsWith(tmpdir())).toBe(true);
    expect(brandHome.startsWith(`${plantedHome}/`)).toBe(true);
    expect(readFileSync(join(brandHome, "AGENTS.md"), "utf8")).toContain(planted.marker);
    expect(existsSync(join(plantedHome, ".agents", "AGENTS.md"))).toBe(true);
  } finally {
    process.env.HOME = original;
    planted?.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
  expect(existsSync(plantedHome!)).toBe(false);
});

test("plantSessionCanary carries agy's planted server name as a secret", () => {
  const planted = plantSessionCanary("agy");
  const plantedHome = planted.env.HOME!;
  try {
    expect(plantedHome.startsWith(tmpdir())).toBe(true);
    expect(readFileSync(join(plantedHome, ".gemini", "GEMINI.md"), "utf8")).toContain(planted.marker);
    expect(planted.secrets).toHaveLength(1);
    expect(planted.secrets[0]).toMatch(/^codemux-planted-/);
    expect(existsSync(join(planted.cwd, ".git"))).toBe(true);
  } finally {
    planted.cleanup();
  }
  expect(existsSync(plantedHome)).toBe(false);
});
