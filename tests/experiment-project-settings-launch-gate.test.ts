import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiderAdapter } from "../src/adapters/aider.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import { PROJECT_SETTINGS_AGENTS } from "../src/claude-project-settings.js";
import { launchRunRequest } from "../src/launch.js";
import { UsageRefusalError } from "../src/validation.js";
import type { BaseAdapter } from "../src/adapters/base.js";
import type { RunRequest } from "../src/types.js";

// The programmatic launch paths (adapter.run and launchRunRequest) skip
// the CLI's early --experiment-project-settings check by design, so the
// gate the adapters run at prepareRun (validateProjectSettingsRunRequest)
// is the only one a library caller meets. Each test drives one of those
// entry points with a request the flag rules refuse and asserts a usage
// refusal that arrives before any spawn and before the private config
// directory exists (review round 2, contracts 2).
describe("--experiment-project-settings on the programmatic launch paths", () => {
  let root = "";
  let home = "";
  let bin = "";
  let cwd = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codemux-pps-launch-"));
    home = join(root, "home");
    cwd = join(root, "work");
    bin = join(root, "bin");
    mkdirSync(home);
    mkdirSync(cwd);
    mkdirSync(bin);
    // The fake harness binaries write a marker when they run, so a test
    // asserts the refusal preceded the spawn, not merely failed after it.
    for (const name of ["claude", "zai", "opencode", "codex", "aider"]) {
      writeFileSync(
        join(bin, name),
        `printf ran > "${join(root, "spawned")}"\nexit 7`,
        { mode: 0o700 }
      );
    }
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const environment = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    HOME: home,
    PATH: bin,
    ...extra,
  });

  // Autonomy "high" (or "medium" where named) matters: below it the
  // launcher's own no-sandbox autonomy refusal fires first, and this file
  // pins the project-settings gate, not that one.
  const request = (agent: RunRequest["agent"], extra: Partial<RunRequest> = {}): RunRequest => ({
    agent,
    prompt: "p",
    cwd,
    hermetic: true,
    autonomy: "high",
    experimentProjectSettings: true,
    ...extra,
  });

  // adapter.run launches directly (no sandbox); a refusal must reject the
  // promise without either harness binary ever running.
  const expectRefusal = async (
    launch: () => Promise<unknown>,
    message: string
  ): Promise<void> => {
    const error = await launch().then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(UsageRefusalError);
    expect((error as Error).message).toContain(message);
    expect(existsSync(join(root, "spawned"))).toBe(false);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  };

  test("claude adapter.run without the sandbox refuses before the spawn", () =>
    expectRefusal(
      () => new ClaudeAdapter(environment()).run(request("claude")),
      "requires the scode sandbox"
    ));

  test("zai adapter.run without the sandbox refuses before the spawn", () =>
    expectRefusal(
      () => new ZaiAdapter(environment({ ZAI_API_KEY: "sk-test-key" })).run(request("zai")),
      "requires the scode sandbox"
    ));

  test("opencode adapter.run without the sandbox refuses before the spawn", () =>
    expectRefusal(
      () => new OpencodeAdapter(environment()).run(request("opencode")),
      "requires the scode sandbox"
    ));

  test("opencode at medium autonomy refuses before the spawn", () =>
    expectRefusal(
      () =>
        sandboxedLaunch(
          new OpencodeAdapter(environment()),
          request("opencode", { autonomy: "medium", sandboxed: true })
        ),
      "requires --auto low or high"
    ));

  test("an unmapped agent is refused at validateRunRequest before prepareRun", () =>
    expectRefusal(
      () => new AiderAdapter(environment()).run(request("aider")),
      `applies to the ${PROJECT_SETTINGS_AGENTS.join(", ")} agents only`
    ));

  test("codex adapter.run without the sandbox refuses before the spawn", () =>
    expectRefusal(
      () => new CodexAdapter(environment()).run(request("codex")),
      "requires the scode sandbox"
    ));

  const sandboxedLaunch = (adapter: BaseAdapter, run: RunRequest): Promise<unknown> =>
    launchRunRequest(adapter, run, {
      sandbox: true,
      requestedAutonomy: run.autonomy ?? "read-only",
      // The one-directory rule every production caller follows
      // (run-command.ts passes the request's cwd as the launch cwd).
      cwd: run.cwd,
    });

  test("claude via launchRunRequest without hermetic mode refuses before the spawn", () =>
    expectRefusal(
      () =>
        sandboxedLaunch(
          new ClaudeAdapter(environment()),
          request("claude", { hermetic: false, sandboxed: true, autonomy: "low" })
        ),
      "requires --hermetic"
    ));

  test("claude via launchRunRequest at medium autonomy refuses before the spawn", () =>
    expectRefusal(
      () =>
        sandboxedLaunch(
          new ClaudeAdapter(environment()),
          request("claude", { sandboxed: true, autonomy: "medium" })
        ),
      "requires --auto low"
    ));

  test("a project-settings launch whose run cwd differs from the request's refuses (round 16, edges 2)", () => {
    // The project-settings gate validates request.cwd while the child
    // runs in the launch options' cwd, so two different directories
    // could validate a safe one and execute with another's project
    // hooks. The launcher refuses the mismatch exactly as it does for
    // experiment MCP and agy isolation.
    const other = join(root, "other");
    mkdirSync(other);
    return expectRefusal(
      () =>
        launchRunRequest(new ClaudeAdapter(environment()), request("claude", { sandboxed: true, autonomy: "low" }), {
          sandbox: true,
          requestedAutonomy: "low",
          cwd: other,
        }),
      "must run in the request's working directory"
    );
  });

  test("a project-settings launch with one cwd on both sides passes the cwd guard", async () => {
    // The symmetric case: the same directory, spelled identically on
    // both sides, is not a mismatch — the refusal the launch then meets
    // is the adapter's own sandbox requirement, not the cwd guard.
    const error = await launchRunRequest(new ClaudeAdapter(environment()), request("claude"), {
      sandbox: false,
      cwd,
      requestedAutonomy: "high",
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(UsageRefusalError);
    expect((error as Error).message).toContain("requires the scode sandbox");
    expect((error as Error).message).not.toContain("request's working directory");
    expect(existsSync(join(root, "spawned"))).toBe(false);
  });
});
