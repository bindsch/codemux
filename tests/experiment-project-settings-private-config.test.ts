import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import type { RunContext } from "../src/adapters/base.js";
import {
  claudeProjectKey,
  generatedGlobalState,
  openProjectSettingsSessionConfigDir,
  projectSettingsConfigRoot,
} from "../src/claude-project-config.js";
import type { RunRequest } from "../src/types.js";
import * as experimentMcpModule from "../src/experiment-mcp.js";
import * as projectSettingsModule from "../src/claude-project-settings.js";

// An access-token-only mirror, the shape a scrubbed `~/.claude/
// .credentials.json` holds: no refreshToken field at all.
const CLEAN_MIRROR = JSON.stringify({
  claudeAiOauth: { accessToken: "at", expiresAt: 4102444800000, scopes: [] },
  mcpOAuth: { example: { access_token: "mcp-at" } },
});
const DIRTY_MIRROR = JSON.stringify({
  claudeAiOauth: { accessToken: "at", refreshToken: "must-not-travel", expiresAt: 1 },
});

describe("--experiment-project-settings: private config directory", () => {
  const scratch: string[] = [];
  // Every context this describe prepares, disposed per launch -- the same
  // ownership rule the launcher follows, never a whole-adapter sweep.
  const prepared: { adapter: ClaudeAdapter | ZaiAdapter; context: RunContext }[] = [];
  const signalListeners = () =>
    process.listenerCount("SIGINT") + process.listenerCount("SIGTERM") + process.listenerCount("SIGHUP");
  const baseline = signalListeners();
  afterEach(() => {
    for (const { adapter, context } of prepared.splice(0)) adapter.cleanupRunSync(context);
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
    // No directory may leave a signal handler behind: a later synthetic
    // signal in another test would otherwise end the whole test process.
    expect(signalListeners()).toBe(baseline);
  });

  // A fake operator home with a `.claude` config root; `mirror` seeds the
  // default credential mirror the run copies from.
  function fakeHome(mirror?: string): string {
    const home = mkdtempSync(join(tmpdir(), "codemux-claude-home-"));
    scratch.push(home);
    mkdirSync(join(home, ".claude"), { recursive: true });
    if (mirror !== undefined) {
      writeFileSync(join(home, ".claude", ".credentials.json"), mirror, { mode: 0o600 });
    }
    return home;
  }

  function fakeCwd(): string {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-fixture-repo-"));
    scratch.push(cwd);
    return cwd;
  }

  // sandboxed and autonomy mirror what a sandboxed launch passes: the
  // prepareRun gate validates them from the request's own fields.
  const request = (agent: "claude" | "zai", cwd: string): RunRequest => ({
    agent,
    prompt: "p",
    hermetic: true,
    experimentProjectSettings: true,
    autonomy: "low",
    sandboxed: true,
    cwd,
  });

  const prepare = (adapter: ClaudeAdapter | ZaiAdapter, req: RunRequest): RunContext => {
    const context = adapter.prepareRun(req);
    prepared.push({ adapter, context });
    return context;
  };

  test("the directory holds only the generated .claude.json until the credential copy, with tight modes", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    const home = fakeHome(CLEAN_MIRROR);
    const cwd = fakeCwd();
    const adapter = new ClaudeAdapter({ HOME: home });
    const req = request("claude", cwd);
    const context = prepare(adapter, req);
    const dir = context.claudeProjectConfigDir!.dir;
    expect(dir.startsWith(join(home, ".claude", ".codemux-hermetic", `run-${process.pid}-`))).toBe(true);
    expect((statSync(dir).mode & 0o777)).toBe(0o700);
    // Before the launch seam: state only, no credentials.
    expect(readdirSync(dir).sort()).toEqual([".claude.json"]);
    adapter.getRunEnv(req, context);
    expect(readdirSync(dir).sort()).toEqual([".claude.json", ".credentials.json"]);
    expect((statSync(join(dir, ".claude.json")).mode & 0o777)).toBe(0o600);
    expect((statSync(join(dir, ".credentials.json")).mode & 0o777)).toBe(0o600);
  });

  test("the generated .claude.json marks onboarding complete and trusts the working directory", () => {
    const home = fakeHome();
    const cwd = fakeCwd();
    const adapter = new ClaudeAdapter({ HOME: home });
    const context = prepare(adapter, request("claude", cwd));
    const dir = context.claudeProjectConfigDir!.dir;
    const key = claudeProjectKey(cwd);
    expect(readFileSync(join(dir, ".claude.json"), "utf8")).toBe(`${generatedGlobalState(key)}\n`);
    expect(JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"))).toEqual({
      hasCompletedOnboarding: true,
      projects: { [key]: { hasTrustDialogAccepted: true } },
    });
  });

  test("claude copies only the mirror's claudeAiOauth; zai copies nothing", async () => {
    const home = fakeHome(CLEAN_MIRROR);
    const cwd = fakeCwd();
    const claude = new ClaudeAdapter({ HOME: home });
    const claudeContext = prepare(claude, request("claude", cwd));
    const claudeEnv = claude.getRunEnv(request("claude", cwd), claudeContext);
    expect(claudeEnv).toEqual({ CLAUDE_CONFIG_DIR: claudeContext.claudeProjectConfigDir!.dir });
    // The copy is built from the parsed claudeAiOauth alone (review round
    // 13): the co-stored mcpOAuth entry never reaches the private directory.
    const copy = readFileSync(
      join(claudeContext.claudeProjectConfigDir!.dir, ".credentials.json"),
      "utf8"
    );
    expect(JSON.parse(copy)).toEqual({
      claudeAiOauth: JSON.parse(CLEAN_MIRROR).claudeAiOauth,
    });
    expect(copy).not.toContain("mcpOAuth");
    expect(copy).not.toContain("mcp-at");

    const zai = new ZaiAdapter({ ZAI_API_KEY: "zai-key", HOME: home }, home);
    const zaiContext = prepare(zai, request("zai", cwd));
    const zaiEnv = zai.getRunEnv(request("zai", cwd), zaiContext);
    expect(zaiEnv).toEqual({ CLAUDE_CONFIG_DIR: zaiContext.claudeProjectConfigDir!.dir });
    expect(existsSync(join(zaiContext.claudeProjectConfigDir!.dir, ".credentials.json"))).toBe(false);
  });

  test("claude without a mirror launches with no credentials in the directory", () => {
    const home = fakeHome();
    const cwd = fakeCwd();
    const adapter = new ClaudeAdapter({ HOME: home });
    const context = prepare(adapter, request("claude", cwd));
    expect(() => adapter.getRunEnv(request("claude", cwd), context)).not.toThrow();
    expect(readdirSync(context.claudeProjectConfigDir!.dir)).toEqual([".claude.json"]);
  });

  test("a mirror that still holds a refresh token refuses the run", () => {
    const home = fakeHome(DIRTY_MIRROR);
    const cwd = fakeCwd();
    const adapter = new ClaudeAdapter({ HOME: home });
    const context = prepare(adapter, request("claude", cwd));
    expect(() => adapter.getRunEnv(request("claude", cwd), context)).toThrow(/refresh token/);
    expect(existsSync(join(context.claudeProjectConfigDir!.dir, ".credentials.json"))).toBe(false);
  });

  test("cleanup removes the directory; finalize alone is idempotent", async () => {
    const home = fakeHome(CLEAN_MIRROR);
    const cwd = fakeCwd();
    const adapter = new ClaudeAdapter({ HOME: home });
    const context = prepare(adapter, request("claude", cwd));
    const dir = context.claudeProjectConfigDir!.dir;
    adapter.getRunEnv(request("claude", cwd), context);
    expect(existsSync(dir)).toBe(true);
    context.claudeProjectConfigDir!.finalize();
    context.claudeProjectConfigDir!.finalize();
    expect(existsSync(dir)).toBe(false);
    // cleanupRun after a finalize is itself a no-op, not an error.
    await adapter.cleanupRun(context);
    expect(existsSync(dir)).toBe(false);
  });

  test("a bridge that fails to build cleans up the private directory (round 14, edges 12)", () => {
    const home = fakeHome(CLEAN_MIRROR);
    const cwd = fakeCwd();
    const spec = join(cwd, "spec.json");
    writeFileSync(spec, JSON.stringify({ name: "probe", command: "/bin/true", args: [], env: [], recording: cwd }));
    // The combination gate normally refuses --experiment-mcp under
    // project settings before prepareRun; the guard under test covers a
    // later prepare step throwing anyway (the launcher has no context to
    // clean up), so the gate stands down and the bridge refuses.
    const gate = spyOn(projectSettingsModule, "validateProjectSettingsRunRequest")
      .mockImplementation((_request: RunRequest) => {});
    const specRead = spyOn(experimentMcpModule, "readExperimentRunSpec").mockImplementation(() => {
      throw new Error("bridge step refused (probe)");
    });
    try {
      const adapter = new ClaudeAdapter({ HOME: home });
      expect(() =>
        adapter.prepareRun({ ...request("claude", cwd), experimentMcp: spec })
      ).toThrow("bridge step refused (probe)");
      // The private config directory the same prepareRun created is gone:
      // nothing strands it for the stale-directory sweep.
      const parent = join(projectSettingsConfigRoot({ HOME: home }), ".codemux-hermetic");
      expect(existsSync(parent) ? readdirSync(parent) : []).toEqual([]);
    } finally {
      gate.mockRestore();
      specRead.mockRestore();
    }
  });

  test("a finalize whose rmSync fails stays retryable and is retried at exit (round 14, edges 4)", () => {
    const home = fakeHome(CLEAN_MIRROR);
    const cwd = fakeCwd();
    const adapter = new ClaudeAdapter({ HOME: home });
    const context = prepare(adapter, request("claude", cwd));
    const dir = context.claudeProjectConfigDir!.dir;
    adapter.getRunEnv(request("claude", cwd), context);
    expect(existsSync(dir)).toBe(true);
    const realRmSync = rmSync;
    let failedOnce = false;
    const failing = spyOn(fs, "rmSync").mockImplementation(((
      path: string,
      options: Parameters<typeof rmSync>[1]
    ) => {
      if (!failedOnce && String(path) === dir) {
        failedOnce = true;
        throw new Error("rm: permission denied (probe)");
      }
      return realRmSync(path as never, options as never);
    }) as typeof rmSync);
    const errors: string[] = [];
    const realError = console.error;
    console.error = ((message: string) => errors.push(String(message))) as typeof console.error;
    try {
      context.claudeProjectConfigDir!.finalize();
      // The failed removal left the directory on disk and reported it.
      expect(existsSync(dir)).toBe(true);
      expect(errors.join("\n")).toContain("codemux: could not remove the private config directory");
      // The hook stayed registered, so the exit retry is a real second
      // attempt, not the no-op a marked finalize would be.
      context.claudeProjectConfigDir!.finalize();
      expect(existsSync(dir)).toBe(false);
    } finally {
      console.error = realError;
      failing.mockRestore();
    }
  });

  test("a parent swapped for a symlink refuses the run-path finalize (round 15, edges 2)", () => {
    const home = fakeHome();
    const cwd = fakeCwd();
    const adapter = new ClaudeAdapter({ HOME: home });
    const context = prepare(adapter, request("claude", cwd));
    const dir = context.claudeProjectConfigDir!.dir;
    expect(existsSync(dir)).toBe(true);
    // A sandboxed child with write access to the config root swaps the
    // parent for a symlink after the directory was made.
    const parent = join(projectSettingsConfigRoot({ HOME: home }), ".codemux-hermetic");
    const moved = `${parent}.moved`;
    fs.renameSync(parent, moved);
    fs.symlinkSync(moved, parent);
    const errors: string[] = [];
    const realError = console.error;
    console.error = ((message: string) => errors.push(String(message))) as typeof console.error;
    try {
      context.claudeProjectConfigDir!.finalize();
      // The failed check is reported like a failed removal, and the real
      // directory survives it: the removal never resolved the link.
      expect(errors.join("\n")).toContain("codemux: could not remove the private config directory");
      expect(errors.join("\n")).toContain("must be a directory owned by the current user");
      expect(existsSync(join(moved, basename(dir)))).toBe(true);
      // The finalize stayed retryable: with the parent restored, the
      // second attempt removes the directory for real.
      fs.rmSync(parent, { force: true });
      fs.renameSync(moved, parent);
      context.claudeProjectConfigDir!.finalize();
      expect(existsSync(dir)).toBe(false);
    } finally {
      console.error = realError;
    }
  });

  test("a parent swapped for a symlink refuses the session directory's removal (round 15, edges 2)", () => {
    const home = fakeHome();
    const cwd = fakeCwd();
    const sessionId = "12345678-1234-1234-1234-123456789012";
    const session = openProjectSettingsSessionConfigDir(sessionId, false, cwd, { HOME: home });
    const parent = join(projectSettingsConfigRoot({ HOME: home }), ".codemux-hermetic");
    const moved = `${parent}.moved`;
    fs.renameSync(parent, moved);
    fs.symlinkSync(moved, parent);
    try {
      // The removal refuses on the parent check instead of resolving the
      // link, and the real directory survives.
      expect(() => session.remove()).toThrow("must be a directory owned by the current user");
      expect(existsSync(join(moved, `session-${sessionId}`))).toBe(true);
    } finally {
      fs.rmSync(parent, { force: true });
      fs.renameSync(moved, parent);
    }
  });

  test("an unprepared launch fails closed at getRunEnv on either agent", () => {
    const home = fakeHome();
    const cwd = fakeCwd();
    for (const [agent, adapter] of [
      ["claude", new ClaudeAdapter({ HOME: home })],
      ["zai", new ZaiAdapter({ ZAI_API_KEY: "zai-key", HOME: home }, home)],
    ] as const) {
      expect(() => adapter.getRunEnv(request(agent, cwd), undefined)).toThrow("was not prepared before launch");
    }
  });

  test("the private directory overrides an ambient CLAUDE_CONFIG_DIR in the merged child environment", () => {
    const home = fakeHome(CLEAN_MIRROR);
    const cwd = fakeCwd();
    // An ambient redirect in the operator's environment: the adapter-provided
    // name wins the merge and survives sanitization.
    const adapter = new ClaudeAdapter({ HOME: home, CLAUDE_CONFIG_DIR: "/ambient/claude" });
    const context = prepare(adapter, request("claude", cwd));
    const merged = adapter.buildExecutionEnv(adapter.getRunEnv(request("claude", cwd), context));
    expect(merged.CLAUDE_CONFIG_DIR).toBe(context.claudeProjectConfigDir!.dir);
  });

  test("the parent sweep removes stale dead-owner directories and keeps recent ones", () => {
    const home = fakeHome();
    const cwd = fakeCwd();
    const parent = join(home, ".claude", ".codemux-hermetic");
    const old = join(parent, "run-999999999-old");
    const recent = join(parent, "run-999999998-recent");
    mkdirSync(old, { recursive: true });
    mkdirSync(recent, { recursive: true });
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(old, threeDaysAgo, threeDaysAgo);
    const adapter = new ClaudeAdapter({ HOME: home });
    prepare(adapter, request("claude", cwd));
    const left = readdirSync(parent).filter((entry) => entry.startsWith("run-9999"));
    expect(left).toEqual(["run-999999998-recent"]);
  });

  test("the operator's own global state and user settings are byte-identical after the run", () => {
    const home = fakeHome(CLEAN_MIRROR);
    const operatorState = join(home, ".claude.json");
    const operatorSettings = join(home, ".claude", "settings.json");
    writeFileSync(operatorState, '{"hasCompletedOnboarding":true,"projects":{"/operator/project":{}}}\n');
    writeFileSync(operatorSettings, '{"permissions":{"allow":["Bash(ls:*)"]}}\n');
    const stateBefore = readFileSync(operatorState);
    const settingsBefore = readFileSync(operatorSettings);
    const cwd = fakeCwd();
    const adapter = new ClaudeAdapter({ HOME: home });
    const context = prepare(adapter, request("claude", cwd));
    adapter.getRunEnv(request("claude", cwd), context);
    adapter.cleanupRunSync(context);
    expect(readFileSync(operatorState).equals(stateBefore)).toBe(true);
    expect(readFileSync(operatorSettings).equals(settingsBefore)).toBe(true);
  });

  test("a launch whose config root cannot hold the parent fails without leaving a directory", () => {
    const home = fakeHome();
    const adapter = new ClaudeAdapter({ HOME: home });
    // A file where the `.codemux-hermetic` parent belongs: no per-run
    // directory may be created or left signal-tracked behind the refusal.
    rmSync(join(home, ".claude"), { recursive: true, force: true });
    writeFileSync(join(home, ".claude"), "not a directory", { mode: 0o600 });
    let dir: string | undefined;
    expect(() => {
      const context = adapter.prepareRun(request("claude", fakeCwd()));
      dir = context.claudeProjectConfigDir?.dir;
    }).toThrow();
    expect(dir ? existsSync(dir) : false).toBe(false);
    expect(signalListeners()).toBe(baseline);
  });

  test("the config root is the operator's default .claude, or the launch refuses", () => {
    expect(projectSettingsConfigRoot({ HOME: "/fake/home" })).toBe(join("/fake/home", ".claude"));
    expect(() => projectSettingsConfigRoot({ HOME: "relative/home" })).toThrow("absolute HOME");
  });
});
