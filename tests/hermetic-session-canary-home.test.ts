import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HARNESS_HOME_CANARY_PROMPT, plantHarnessHomeCanary, runHarnessHomeSessionCanary,
  runCallerHarnessHomeCanary, sessionCanaryLaunchCount, supportsHarnessHomeCanary,
} from "../src/hermetic-session-canary-home.js";
import { canarySessionProtocolProblem, sessionCanary, type SessionRun } from "../src/hermetic-session-canary-driver.js";
import { AGENT_IDS, type AgentId } from "../src/types.js";

const FAKE = new URL("./fixtures/live/fake-codemux-session.ts", import.meta.url).pathname;
const scratch = (): string => mkdtempSync(join(tmpdir(), "caller-home-canary-test-"));

const callerAgents = AGENT_IDS;
test("the caller-home arm covers every session agent, cline included", () => {
  for (const agent of callerAgents) {
    expect(supportsHarnessHomeCanary(agent)).toBe(true);
    expect(sessionCanaryLaunchCount(agent)).toBe(5);
  }
  expect(callerAgents).toContain("cline");
});

for (const agent of ["claude", "codex", "zai"] as const) {
  test(`${agent} plants separate operator instructions and caller skill without copying settings`, () => {
    const root = scratch();
    const source = join(root, "source");
    const sourceBrand = agent === "codex" ? join(source, ".codex") : source;
    mkdirSync(sourceBrand, { recursive: true });
    const credential = agent === "codex" ? "auth.json" : ".credentials.json";
    const login = join(sourceBrand, credential);
    writeFileSync(login, "synthetic-login");
    writeFileSync(join(sourceBrand, "settings.json"), '{"test":"never copied"}');
    const plant = plantHarnessHomeCanary(agent, source, {
      ZAI_API_KEY: "synthetic-zai-key", CLAUDE_CONFIG_DIR: "/fixture/ambient-claude",
      CODEX_HOME: "/fixture/ambient-codex", XDG_CONFIG_HOME: "/fixture/ambient-config",
      XDG_DATA_HOME: "/fixture/ambient-data", XDG_STATE_HOME: "/fixture/ambient-state",
    }, root);
    try {
      expect(plant.env.HOME).toBe(plant.operatorHome);
      expect(plant.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(plant.env.CODEX_HOME).toBeUndefined();
      expect(plant.env.XDG_CONFIG_HOME).toBeUndefined();
      expect(plant.env.XDG_DATA_HOME).toBeUndefined();
      expect(plant.env.XDG_STATE_HOME).toBeUndefined();
      const brand = agent === "codex" ? ".codex" : ".claude";
      const instruction = join(plant.operatorHome, brand, agent === "codex" ? "AGENTS.md" : "CLAUDE.md");
      expect(readFileSync(instruction, "utf8")).toContain(plant.operatorMarker);
      expect(readFileSync(plant.skillPath, "utf8")).toContain(`description: The private skill code word is ${plant.skillMarker}`);
      expect(plant.operatorMarker).not.toBe(plant.skillMarker);
      expect(HARNESS_HOME_CANARY_PROMPT).not.toContain(plant.operatorMarker);
      expect(HARNESS_HOME_CANARY_PROMPT).not.toContain(plant.skillMarker);
      expect(readdirSync(plant.cwd)).toEqual([".git"]);
      expect(existsSync(join(plant.home, credential))).toBe(false);
      expect(existsSync(join(plant.home, "settings.json"))).toBe(false);
      if (agent === "zai") {
        expect(plant.env.ZAI_API_KEY).toBe("synthetic-zai-key");
        expect(existsSync(join(plant.operatorHome, brand, credential))).toBe(false);
      } else {
        expect(statSync(join(plant.operatorHome, brand, credential)).ino).toBe(statSync(login).ino);
      }
    } finally {
      plant.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
    expect(existsSync(plant.home)).toBe(false);
  });
}

test("a codex hermetic login symlink becomes a regular source hard link", () => {
  const root = scratch();
  const source = join(root, "source");
  mkdirSync(join(source, ".codex"), { recursive: true });
  const login = join(root, "login.json");
  writeFileSync(login, "synthetic-login");
  symlinkSync(login, join(source, ".codex", "auth.json"));
  const plant = plantHarnessHomeCanary("codex", source, {}, root);
  try {
    expect(statSync(join(plant.operatorHome, ".codex", "auth.json")).ino).toBe(statSync(login).ino);
  } finally {
    plant.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fixture creation failure removes its scratch directory", () => {
  const root = scratch();
  try {
    expect(() => plantHarnessHomeCanary("zai", root, { ZAI_API_KEY: "invalid\nkey" }, root)).toThrow("exactly one credential line");
    expect(readdirSync(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the expected caller home uses the canonical path when scratch has a symlinked parent", () => {
  const root = scratch();
  const target = join(root, "target");
  const alias = join(root, "alias");
  mkdirSync(target);
  symlinkSync(target, alias);
  const plant = plantHarnessHomeCanary("claude", root, {}, alias);
  try {
    expect(plant.home).toBe(realpathSync(plant.home));
    expect(plant.home.startsWith(`${realpathSync(target)}/`)).toBe(true);
  } finally {
    plant.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

async function runArm(scenario: string, agent: AgentId = "claude") {
  const root = scratch();
  const state = join(root, "state.jsonl");
  const plant = plantHarnessHomeCanary(agent, root, {
    FAKE_CODEMUX_SCENARIO: scenario, FAKE_CODEMUX_STATE: state, ZAI_API_KEY: "synthetic-zai-key",
  }, root);
  const errors: string[] = [];
  const command = spyOn(sessionCanary, "command").mockReturnValue([process.execPath, FAKE]);
  const log = spyOn(console, "error").mockImplementation((...values: unknown[]) => errors.push(values.join(" ")));
  try {
    const code = await runHarnessHomeSessionCanary({ agent, model: "fixture-model", effort: "low",
      autonomy: "read-only", passthroughEnv: ["FIXTURE_VALUE"], timeoutMs: 2_000, killGraceMs: 200 }, plant);
    const runs = readFileSync(state, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      argv: string[]; harnessHome: string; resume: string | null; sessionId: string; hermetic: boolean; final: boolean;
    });
    return { code, errors: errors.join("\n"), runs, preserved: existsSync(plant.skillPath), home: plant.home };
  } finally {
    log.mockRestore();
    command.mockRestore();
    plant.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}

for (const agent of callerAgents) {
  test(`${agent} caller-home arm preserves its skill and home across resume with final`, async () => {
    const run = await runArm("clean", agent);
    expect(run.code).toBe(0);
    expect(run.runs).toHaveLength(2);
    expect(run.preserved).toBe(true);
    const [first, second] = run.runs;
    expect(first!.argv.join(" ")).toContain("--harness-home");
    expect(first!.argv.join(" ")).toContain("-m fixture-model --effort low --pass-env FIXTURE_VALUE");
    expect(first!.harnessHome).toBe(run.home);
    expect(second!.harnessHome).toBe(first!.harnessHome);
    expect(first!.resume).toBeNull();
    expect(second!.resume).toBe(first!.sessionId);
    expect(first!.hermetic).toBe(false);
    expect(second!.hermetic).toBe(false);
    expect(first!.final).toBe(false);
    expect(second!.final).toBe(true);
  });
}

test.each([
  ["aider", ".aider/oauth-keys.env"], ["cursor", process.platform === "darwin" ? ".cursor/auth.json" : ".config/cursor/auth.json"],
  ["droid", ".factory/auth.json"], ["gemini", ".gemini/oauth_creds.json"],
  ["goose", "config/secrets.yaml"], ["kimi", ".kimi-code/credentials/token.json"],
  ["opencode", ".local/share/opencode/auth.json"], ["pi", "auth.json"], ["qwen", ".qwen/oauth_creds.json"],
] as const)("%s canary carries only dedicated file credentials", (agent, credential) => {
  const root = scratch(); const source = join(root, "source"); const login = join(source, credential);
  mkdirSync(join(login, ".."), { recursive: true }); writeFileSync(login, "synthetic-login");
  const plant = plantHarnessHomeCanary(agent, source, {
    QWEN_RUNTIME_DIR: "/fixture/runtime", FACTORY_HOME_OVERRIDE: "/fixture/factory", KIMI_CODE_HOME: "/fixture/kimi",
    OPENHANDS_CONVERSATIONS_DIR: "/fixture/conversations", PI_CODING_AGENT_DIR: "/fixture/pi",
  }, root);
  try {
    const target = agent === "goose" ? ".config/goose/secrets.yaml" : agent === "pi" ? ".pi/agent/auth.json" : credential;
    if (agent === "kimi") {
      // The kimi store is shared, never linked file by file (review R420 audit).
      expect(existsSync(join(plant.operatorHome, target))).toBe(false);
      expect(plant.env.KIMI_CODE_HOME).toBe(realpathSync(join(source, ".kimi-code")));
    } else {
      expect(statSync(join(plant.operatorHome, target)).ino).toBe(statSync(login).ino);
    }
    expect(readFileSync(plant.skillPath, "utf8")).toContain(plant.skillMarker);
    for (const name of ["QWEN_RUNTIME_DIR", "FACTORY_HOME_OVERRIDE", "KIMI_CODE_HOME", "OPENHANDS_CONVERSATIONS_DIR", "PI_CODING_AGENT_DIR"]) {
      if (agent !== "kimi" || name !== "KIMI_CODE_HOME") expect(plant.env[name]).toBeUndefined();
    }
    if (agent === "aider") expect(readFileSync(join(plant.home, ".aider.conf.yml"), "utf8")).toContain(plant.skillPath);
  } finally { plant.cleanup(); rmSync(root, { recursive: true, force: true }); }
});

for (const [scenario, message, sessions] of [
  ["caller-first-leak", "exposed the operator-home code word", 1],
  ["caller-resume-leak", "exposed the operator-home code word", 2],
  ["caller-missing-skill", "private skill code word", 1],
  ["caller-skill-banner-only", "private skill code word", 1],
  ["caller-first-wrong-home", "different private_home", 1],
  ["caller-resume-different-home", "different private_home", 2],
  ["caller-resume-different-id", "changed the session id", 2],
  ["caller-final-removes-home", "removed the caller home or its private skill", 2],
  ["caller-crash", "exited 1", 1],
] as const) {
  test(`caller-home canary rejects ${scenario}`, async () => {
    const run = await runArm(scenario);
    expect(run.code).toBe(1);
    expect(run.errors).toContain(message);
    expect(run.runs).toHaveLength(sessions);
    if (scenario === "caller-crash") expect(run.errors).toContain("synthetic caller child failed");
  });
}

test("protocol judgment rejects incomplete or unsuccessful sessions", () => {
  const valid: SessionRun = { exitCode: 0, stdout: "", stderr: "", stopped: false, failure: null,
    sessionId: "fixture-session", assistantText: "", completed: true, ended: { reason: "shutdown", exitCode: 0 } };
  expect(canarySessionProtocolProblem(valid, "fixture")).toBeNull();
  for (const [patch, message] of [
    [{ failure: "deadline", rejection: "bad frame" }, "deadline (input rejected: bad frame)"],
    [{ exitCode: null }, "without an exit status"],
    [{ sessionId: undefined }, "no session_started"],
    [{ completed: false }, "without completing the turn"],
    [{ completed: false, rejection: "bad frame" }, "input rejected: bad frame"],
    [{ ended: undefined }, "without a session_ended"],
    [{ ended: { reason: "error", exitCode: 0 } }, "reason 'error'"],
    [{ ended: { reason: "shutdown", exitCode: 1 } }, "exit_code '1'"],
  ] as [Partial<SessionRun>, string][]) {
    expect(canarySessionProtocolProblem({ ...valid, ...patch }, "fixture")).toContain(message);
  }
});

test.each(["cursor", "qwen", "openhands", "cline"] as const)("%s caller-only canary runs without a disposable hermetic prerequisite", async (agent) => {
  const root = scratch(); const state = join(root, "state.jsonl");
  const command = spyOn(sessionCanary, "command").mockReturnValue([process.execPath, FAKE]);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await runCallerHarnessHomeCanary({ agent, autonomy: "read-only", passthroughEnv: [],
      timeoutMs: 2_000, killGraceMs: 200 }, { parent: root,
      environment: { FAKE_CODEMUX_SCENARIO: "clean", FAKE_CODEMUX_STATE: state } });
    expect(code).toBe(0);
    const runs = readFileSync(state, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.hermetic === false && typeof run.harnessHome === "string")).toBe(true);
    expect(existsSync(runs[0].harnessHome)).toBe(false);
  } finally { log.mockRestore(); command.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("cline plants its caller skill under .cline and operator rules under .agents, with no login link", () => {
  const root = scratch();
  const plant = plantHarnessHomeCanary("cline", join(root, "source"), {
    CLINE_DIR: "/fixture/ambient-cline", CLINE_DATA_DIR: "/fixture/ambient-data",
    CLINE_PROVIDER_SETTINGS_PATH: "/fixture/providers.json", CODEMUX_CLINE_PROVIDER_MODEL: "fixture-model",
  }, root);
  try {
    expect(plant.skillPath).toBe(join(plant.home, ".cline", "skills", "private-canary", "SKILL.md"));
    expect(readFileSync(join(plant.operatorHome, ".agents", "AGENTS.md"), "utf8")).toContain(plant.operatorMarker);
    for (const name of ["CLINE_DIR", "CLINE_DATA_DIR", "CLINE_PROVIDER_SETTINGS_PATH"]) expect(plant.env[name]).toBeUndefined();
    // The provider override is cline's credential; it rides the environment.
    expect(plant.env.CODEMUX_CLINE_PROVIDER_MODEL).toBe("fixture-model");
    expect(readdirSync(plant.operatorHome)).toEqual([".agents"]);
  } finally { plant.cleanup(); rmSync(root, { recursive: true, force: true }); }
});
