/**
 * The cline arm of the hermetic session canary, end to end against the
 * synthetic Cline ACP binary (tests/fixtures/live/fake-cline-acp.ts) on a
 * fake PATH. The canary drives this checkout's own session CLI: hermetic
 * start, plain control, hermetic resume with --final, then caller-home
 * start and resume. The fake answers the canary questions from the files
 * its HOME and config roots expose, so the verdicts come from codemux's
 * real environment wiring. No harness or provider runs.
 */
import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { plantSessionCanary, runHermeticSessionCanary } from "../src/hermetic-session-canary.js";
import { harnessHomeCanarySkillPath, sessionCanaryLaunchCount } from "../src/hermetic-session-canary-home.js";
import { createFakeBinaryEnv } from "./helpers/cli.js";

const FAKE = fileURLToPath(new URL("./fixtures/live/fake-cline-acp.ts", import.meta.url));
const OVERRIDE = {
  CODEMUX_CLINE_PROVIDER_BASE_URL: "https://gateway.example/v1",
  CODEMUX_CLINE_PROVIDER_API_KEY: "fixture-key",
  CODEMUX_CLINE_PROVIDER_MODEL: "fixture-model",
};

interface Call { argv: string[]; env: Record<string, string>; cwd: string }

async function runClineCanary(override: boolean) {
  const fake = createFakeBinaryEnv({
    cline: `if [ "$1" = "--version" ]; then printf '3.0.74\\n'; exit 0; fi\nexec '${process.execPath}' '${FAKE}' "$@"`,
    scode: `while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"`,
  });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hermetic-session-canary-cline-")));
  const variables: Record<string, string> = {
    ...fake.env, FAKE_STATE_DIR: root, XDG_STATE_HOME: join(root, "xdg"), ...(override ? OVERRIDE : {}),
  };
  const saved = Object.fromEntries([...Object.keys(variables), ...Object.keys(OVERRIDE)]
    .map((name) => [name, process.env[name]]));
  for (const name of Object.keys(OVERRIDE)) delete process.env[name];
  Object.assign(process.env, variables);
  const errors: string[] = [];
  const out: string[] = [];
  const mocks = [
    spyOn(console, "error").mockImplementation((...values: unknown[]) => { errors.push(values.map(String).join(" ")); }),
    spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      errors.push(String(chunk)); return true;
    }) as typeof process.stderr.write),
    spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk)); return true;
    }) as typeof process.stdout.write),
  ];
  try {
    const code = await runHermeticSessionCanary({ agent: "cline", autonomy: "read-only",
      passthroughEnv: ["FAKE_STATE_DIR"], timeoutMs: 20_000, killGraceMs: 2_000 });
    const callsFile = join(root, "calls.jsonl");
    const calls = existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Call).filter((call) => call.argv.includes("--acp")) : [];
    return { code, errors: errors.join("\n"), out: out.join(""), calls };
  } finally {
    for (const mock of mocks) mock.mockRestore();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fake.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}

test("cline plants its operator rules in a scratch HOME and keeps the cwd clean", () => {
  const plant = plantSessionCanary("cline");
  try {
    // The hermetic cline launch refuses AGENTS.md, .agents, .cline,
    // .clinerules, and .claude/skills in the cwd, so none may be planted.
    expect(readdirSync(plant.cwd)).toEqual([".git"]);
    // The session registry follows HOME and is refused inside the cwd, so
    // the scratch HOME is the cwd's sibling, not the run check's nested one.
    expect(plant.env.HOME).toBe(join(plant.cwd, "..", "operator"));
    expect(readFileSync(join(plant.env.HOME!, ".agents", "AGENTS.md"), "utf8")).toContain(plant.marker);
  } finally {
    plant.cleanup();
  }
  expect(existsSync(plant.cwd)).toBe(false);
  expect(existsSync(plant.env.HOME!)).toBe(false);
});

test("cline caller-home canary plants its skill under the caller's Cline config root", () => {
  expect(harnessHomeCanarySkillPath("cline", "/caller")).toBe("/caller/.cline/skills/private-canary/SKILL.md");
  expect(sessionCanaryLaunchCount("cline")).toBe(5);
});

test("the cline canary passes hermetic, control, resume, and caller-home sessions over synthetic ACP", async () => {
  const run = await runClineCanary(true);
  expect(run.code, run.errors).toBe(0);
  expect(run.out).toContain("HERMETIC SESSION cline: OK");
  expect(run.errors).toContain("control: planted code word reached the model, as expected");
  expect(run.errors).toContain("--final removed the private home");
  expect(run.errors).toContain("Caller-home session kept its private skill and home across resume and --final");
  // One ACP connection per session: three hermetic-arm sessions and two
  // caller-home sessions.
  expect(run.calls).toHaveLength(sessionCanaryLaunchCount("cline"));
  const [hermetic, control, resumed, caller, callerResumed] = run.calls;
  expect(hermetic!.env.HOME).not.toBe(control!.env.HOME);
  expect(control!.env.HOME!.endsWith("/operator")).toBe(true);
  // The first turn runs in the run-shaped home, which settles to the
  // session-keyed name once Cline reports its id; the resume reopens that.
  expect(hermetic!.env.HOME).toContain("/operator/.cline/.codemux-hermetic/");
  expect(resumed!.env.HOME).toContain("/operator/.cline/.codemux-hermetic/session-");
  expect(caller!.env.HOME).toBe(callerResumed!.env.HOME);
  expect(caller!.env.CLINE_DIR).toBe(join(caller!.env.HOME!, ".cline"));
  for (const call of [hermetic, resumed, caller, callerResumed]) {
    expect(call!.env.CLINE_PROVIDER_SETTINGS_PATH).toBeDefined();
  }
});

test("the cline canary fails closed when the provider override is missing", async () => {
  const run = await runClineCanary(false);
  expect(run.code).toBe(1);
  expect(run.out).not.toContain("HERMETIC SESSION cline: OK");
  expect(run.errors).toContain("provider override");
  expect(run.calls).toHaveLength(0);
});
