// The adapter side of `--experiment-project-settings` on opencode: the
// environment and argv differences from a plain hermetic run at each
// accepted autonomy level, the fail-closed rules, the working-directory
// exemption from the executable-config refusal, and the shape of the
// fixture plugin and rule file under tests/fixtures/opencode-project-settings
// (the request-level rules and the ancestor refusal live in
// tests/experiment-project-settings.test.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import type { RunContext } from "../src/adapters/base.js";
import { assertNoOpenCodeProjectExecutionConfig } from "../src/project-safety.js";
import { UsageRefusalError } from "../src/validation.js";
import type { RunRequest } from "../src/types.js";

describe("opencode --experiment-project-settings", () => {
  const scratch: string[] = [];
  const prepared: RunContext[] = [];
  afterEach(() => {
    for (const context of prepared.splice(0)) context.opencodeHermeticHome?.finalize();
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const cleanCwd = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-opencode-pps-"));
    scratch.push(cwd);
    return cwd;
  };
  const opencodeAdapter = (): { adapter: OpencodeAdapter; home: string } => {
    const home = mkdtempSync(join(tmpdir(), "codemux-opencode-home-"));
    scratch.push(home);
    return { adapter: new OpencodeAdapter({}, home), home };
  };
  // sandboxed mirrors the sandboxed launch whose prepareRun this drives;
  // the prepareRun gate reads it from the request's own fields.
  const request = (cwd: string, autonomy: "low" | "high" = "low"): RunRequest => ({
    agent: "opencode",
    prompt: "p",
    hermetic: true,
    experimentProjectSettings: true,
    autonomy,
    sandboxed: true,
    cwd,
  });
  // The first element after the env(1) assignments; no assignment is ever
  // exactly the program name.
  const programAt = (cmd: string[]): number =>
    cmd.findIndex((part, index) => index > 0 && part === "opencode");
  const assignment = (cmd: string[], name: string): string | undefined =>
    cmd.find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  const unset = (cmd: string[]): string[] =>
    cmd.filter((_, index) => index > 0 && cmd[index - 1] === "-u").sort();

  test("keeps the private home, drops the project-config suppressor and --pure at low", () => {
    const { adapter, home: userHome } = opencodeAdapter();
    const cwd = cleanCwd();
    const req = request(cwd);
    const context = adapter.prepareRun(req);
    prepared.push(context);
    const cmd = adapter.buildRunCommand(req, context);
    const program = programAt(cmd);
    expect(program).toBeGreaterThan(1);
    // The hermetic isolation stays: private HOME and XDG world, real data
    // directory for the login, config and auth channels removed.
    const home = assignment(cmd, "HOME")!;
    expect(home.startsWith(join(userHome, ".local", "share", "opencode", ".codemux-hermetic", `run-${process.pid}-`))).toBe(true);
    expect(assignment(cmd, "XDG_CONFIG_HOME")).toBe(join(home, ".config"));
    expect(assignment(cmd, "XDG_DATA_HOME")).toBe(join(userHome, ".local", "share"));
    expect(unset(cmd)).toEqual([
      "OPENCODE_AUTH_CONTENT",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_CONFIG_DIR",
    ]);
    expect(assignment(cmd, "OPENCODE_DISABLE_CLAUDE_CODE")).toBe("1");
    expect(assignment(cmd, "OPENCODE_DISABLE_EXTERNAL_SKILLS")).toBe("1");
    // The project channel reopens — no suppressor assignment — and --pure
    // is gone so the project's plugins run. Low is --agent build with no
    // --auto: every permission ask is answered with reject.
    expect(assignment(cmd, "OPENCODE_DISABLE_PROJECT_CONFIG")).toBeUndefined();
    expect(cmd.slice(program)).toEqual(["opencode", "run", "--format", "json", "--agent", "build"]);
  });

  test("high maps to --agent build --auto with the same environment", () => {
    const { adapter } = opencodeAdapter();
    const cwd = cleanCwd();
    const req = request(cwd, "high");
    const context = adapter.prepareRun(req);
    prepared.push(context);
    const cmd = adapter.buildRunCommand(req, context);
    // High approves every ask (--auto) while deny rules still fail the ask
    // before it is ever asked, so the environment is low's unchanged.
    expect(assignment(cmd, "OPENCODE_DISABLE_PROJECT_CONFIG")).toBeUndefined();
    expect(cmd.slice(programAt(cmd))).toEqual([
      "opencode",
      "run",
      "--format",
      "json",
      "--agent",
      "build",
      "--auto",
    ]);
  });

  test("a plain hermetic run keeps the suppressor and --pure", () => {
    const { adapter } = opencodeAdapter();
    const cwd = cleanCwd();
    const req: RunRequest = { ...request(cwd), experimentProjectSettings: false };
    const context = adapter.prepareRun(req);
    prepared.push(context);
    const cmd = adapter.buildRunCommand(req, context);
    expect(assignment(cmd, "OPENCODE_DISABLE_PROJECT_CONFIG")).toBe("1");
    expect(cmd.slice(programAt(cmd))).toEqual(["opencode", "--pure", "run", "--format", "json", "--agent", "build"]);
  });

  test("the flag without --hermetic fails closed on both paths", () => {
    const { adapter } = opencodeAdapter();
    const cwd = cleanCwd();
    const req: RunRequest = { ...request(cwd), hermetic: false };
    expect(() => adapter.buildRunCommand(req)).toThrow("--experiment-project-settings requires --hermetic");
    expect(() => adapter.validateRunRequest(req)).toThrow("--experiment-project-settings requires --hermetic");
  });

  test("an ancestor carrying a project-config name refuses before launch", () => {
    const { adapter } = opencodeAdapter();
    const grand = mkdtempSync(join(tmpdir(), "codemux-opencode-anc-"));
    scratch.push(grand);
    const cwd = join(grand, "parent", "fixture");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(grand, "parent", "AGENTS.md"), "operator instructions\n");
    expect(() => adapter.validateRunRequest(request(cwd))).toThrow(UsageRefusalError);
    expect(() => adapter.buildRunCommand(request(cwd))).toThrow(UsageRefusalError);
  });

  test("the executable-config refusal exempts the working directory itself, for this flag only", () => {
    const { adapter } = opencodeAdapter();
    const cwd = cleanCwd();
    // The fixture's own rule file and plugin directory are the point of
    // the flag; without it the same directory refuses.
    writeFileSync(join(cwd, "opencode.json"), "{}\n");
    mkdirSync(join(cwd, ".opencode", "plugin"), { recursive: true });
    writeFileSync(join(cwd, ".opencode", "package.json"), "{}\n");
    expect(() => assertNoOpenCodeProjectExecutionConfig(cwd, true)).not.toThrow();
    expect(() => assertNoOpenCodeProjectExecutionConfig(cwd)).toThrow("opencode.json");
    expect(() => adapter.validateRunRequest(request(cwd))).not.toThrow();
  });

  test("the fixture plugin appends one JSON line per hook", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-opencode-fixture-"));
    scratch.push(dir);
    cpSync(join(import.meta.dir, "fixtures", "opencode-project-settings"), dir, { recursive: true });
    // Imported from the copy so the log lands in the copy, not the tree.
    const mod = (await import(
      pathToFileURL(join(dir, ".opencode", "plugin", "hook-log.ts")).href
    )) as { hookLog: (input: unknown) => Promise<Record<string, (input: never, output: never) => Promise<void>>> };
    expect(typeof mod.hookLog).toBe("function");
    const hooks = await mod.hookLog({ directory: dir });
    expect(Object.keys(hooks).sort()).toEqual(["tool.execute.after", "tool.execute.before"]);
    await hooks["tool.execute.before"]!(
      { tool: "bash", sessionID: "s1", callID: "c1" } as never,
      { args: { command: "ls" } } as never
    );
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "s1", callID: "c1", args: {} } as never,
      { title: "t", output: "o", metadata: {} } as never
    );
    const lines = readFileSync(join(dir, ".opencode", "plugin", "hook-log.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      hook: "tool.execute.before",
      tool: "bash",
      sessionID: "s1",
      callID: "c1",
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({
      hook: "tool.execute.after",
      tool: "bash",
      sessionID: "s1",
      callID: "c1",
    });
  });

  test("the fixture rule file carries the deny rules the study observes", () => {
    const config = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures", "opencode-project-settings", "opencode.json"), "utf8")
    );
    // bash patterns match the parsed command text (tool/shell.ts builds
    // them from each parsed command); edit patterns are worktree-relative
    // paths (tool/edit.ts, tool/write.ts), protecting the rule file and
    // the plugin directory from the edit and write tools.
    expect(config.permission.bash).toEqual({ "rm *": "deny" });
    expect(config.permission.edit).toEqual({ "opencode.json": "deny", ".opencode/**": "deny" });
  });
});
