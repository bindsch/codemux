import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENHANDS_NO_SETTINGS_MARKER, OpenHandsAdapter, openHandsRanNoTask } from "../src/adapters/openhands.js";

const adapter = new OpenHandsAdapter();

describe("OpenHandsAdapter", () => {
  test("never emits --llm-approve at any level", () => {
    // It confirms only what an LLM predicts is high-risk. That is a different
    // mechanism from graded human approval, not a weaker form of it, so Codemux
    // does not present it as one of its levels.
    for (const level of ["read-only", "low", "medium", "high"] as const) {
      expect(adapter.mapAutonomy(level)).not.toContain("--llm-approve");
      expect(adapter.buildTuiCommand(undefined, level)).not.toContain("--llm-approve");
      expect(adapter.buildRunCommand({ agent: "openhands", prompt: "x", autonomy: level }))
        .not.toContain("--llm-approve");
    }
  });

  test("headless runs carry no approval flag, because --headless auto-approves", () => {
    for (const level of ["read-only", "low", "medium", "high"] as const) {
      const cmd = adapter.buildRunCommand({
        agent: "openhands",
        prompt: "x",
        autonomy: level,
      });
      expect(cmd).toContain("--headless");
      expect(cmd).not.toContain("--always-approve");
    }
  });

  test("interactive sessions map only high onto --always-approve", () => {
    expect(adapter.buildTuiCommand(undefined, "high")).toContain("--always-approve");
    for (const level of ["read-only", "low", "medium"] as const) {
      // Default always-ask; the levels are separated by the scode policy.
      expect(adapter.buildTuiCommand(undefined, level)).toEqual(["openhands"]);
    }
  });

  test("model selection goes through the environment override", () => {
    const withModel = adapter.buildRunCommand({
      agent: "openhands",
      prompt: "x",
      model: "anthropic/claude-sonnet-5",
    });
    expect(withModel).toContain("--override-with-envs");
    expect(adapter.getRunEnv({ agent: "openhands", prompt: "x", model: "m" })).toEqual({
      LLM_MODEL: "m",
    });
    // Without a model the environment stays ignored, which is the CLI default.
    const withoutModel = adapter.buildRunCommand({ agent: "openhands", prompt: "x" });
    expect(withoutModel).not.toContain("--override-with-envs");
    expect(adapter.getRunEnv({ agent: "openhands", prompt: "x" })).toEqual({});
  });

  test("passes the task as argv and advertises no effort control", () => {
    expect(adapter.getStdinInput({ agent: "openhands", prompt: "x" })).toBeNull();
    const cmd = adapter.buildRunCommand({ agent: "openhands", prompt: "hello" });
    expect(cmd.slice(-2)).toEqual(["--task", "hello"]);
    expect(adapter.capabilities().supportsEffort).toBe(false);
  });

  test("a settings-missing exit 0 is a failed run, not a reply (live matrix 2026-11-07)", () => {
    const request = { agent: "openhands" as const, prompt: "Reply with OK" };
    const stdout = [
      "OpenHands CLI terminal UI may not work correctly in this environment",
      `\u001b[38;2;255;107;107m${OPENHANDS_NO_SETTINGS_MARKER}\u001b[0m`,
      "Please run: openhands to configure your settings before using --headless.",
      "Goodbye!",
      "",
    ].join("\n");
    const processed = adapter.processRunResult(
      { stdout, stderr: "", exitCode: 0, success: true },
      request
    );
    expect(processed.success).toBe(false);
    expect(processed.exitCode).toBe(1);
    expect(processed.stderr).toContain("headless mode requires existing settings");
    // A nonzero exit keeps its own code; a real reply passes untouched.
    expect(adapter.processRunResult({ stdout, stderr: "", exitCode: 2, success: false }, request).exitCode).toBe(2);
    const ok = { stdout: "OK\n", stderr: "", exitCode: 0, success: true };
    expect(adapter.processRunResult(ok, request)).toEqual({ ...ok, reply: "" });
    // A reply that quotes the phrase, or carries the marker without the
    // instruction and farewell lines, is a reply (review round 334).
    for (const quoted of [
      `The CLI said "${OPENHANDS_NO_SETTINGS_MARKER}" once.\nGoodbye!\n`,
      `${OPENHANDS_NO_SETTINGS_MARKER}\nOK\n`,
      `${OPENHANDS_NO_SETTINGS_MARKER}\nPlease run: openhands to configure your settings before using --headless.\nOK\n`,
    ]) {
      expect(openHandsRanNoTask(quoted)).toBe(false);
      const reply = { stdout: quoted, stderr: "", exitCode: 0, success: true };
      expect(adapter.processRunResult(reply, request)).toEqual({ ...reply, reply: "" });
    }
    expect(openHandsRanNoTask(stdout)).toBe(true);
  });

  test("requires the scode boundary below high", () => {
    for (const level of ["read-only", "low", "medium"] as const) {
      expect(adapter.requiresSandboxForAutonomy(level)).toBe(true);
    }
    expect(adapter.requiresSandboxForAutonomy("high")).toBe(false);
  });
});

describe("OpenHandsAdapter run parity", () => {
  const OVERRIDE = {
    HOME: "/tmp/openhands-parity-home",
    CODEMUX_OPENHANDS_PROVIDER_BASE_URL: "https://gw.example/v1",
    CODEMUX_OPENHANDS_PROVIDER_API_KEY: "k",
    CODEMUX_OPENHANDS_PROVIDER_MODEL: "gpt-x",
  } as const;

  test("the parity capabilities: hermetic, result json, provider override; effort stays refused", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsHermetic).toBe(true);
    expect(caps.supportsResultJson).toBe(true);
    expect(caps.supportsProviderOverride).toBe(true);
    expect(caps.supportsEffort).toBe(false);
    expect(caps.supportsToolSelection ?? false).toBe(false);
  });

  test("a hermetic run refuses to launch without the provider override", () => {
    const work = mkdtempSync(join(tmpdir(), "openhands-parity-"));
    try {
      expect(() =>
        adapter.validateRunRequest({ agent: "openhands", prompt: "t", hermetic: true, cwd: work })
      ).toThrow(/requires the provider override/);
      expect(() =>
        adapter.prepareRun({ agent: "openhands", prompt: "t", hermetic: true, cwd: work })
      ).toThrow(/requires the provider override/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a hermetic run with the override gets a private HOME and the env flag", () => {
    const home = mkdtempSync(join(tmpdir(), "openhands-parity-"));
    const work = mkdtempSync(join(tmpdir(), "openhands-work-"));
    try {
      const privateAdapter = new OpenHandsAdapter({ ...OVERRIDE, HOME: home });
      const context = privateAdapter.prepareRun({ agent: "openhands", prompt: "t", hermetic: true, cwd: work });
      const cmd = privateAdapter.buildRunCommand(
        { agent: "openhands", prompt: "t", hermetic: true, cwd: work },
        context
      );
      expect(cmd[0]).toBe("env");
      expect(cmd[1]!.startsWith(`HOME=${join(home, ".openhands", ".codemux-hermetic", "run-")}`)).toBe(true);
      // The private home relocates the persistence and conversations dirs
      // so nothing of the operator's state reaches the run.
      expect(cmd[2]!.startsWith(`OPENHANDS_PERSISTENCE_DIR=${join(home, ".openhands", ".codemux-hermetic", "run-")}`)).toBe(true);
      expect(cmd[3]!.startsWith(`OPENHANDS_CONVERSATIONS_DIR=${join(home, ".openhands", ".codemux-hermetic", "run-")}`)).toBe(true);
      // prepareRun wrote the prompt's task file, so the launch carries
      // --file (openhands has no stdin transport), never --task argv.
      expect(cmd.slice(4, 7)).toEqual(["openhands", "--headless", "--override-with-envs"]);
      expect(cmd[7]).toBe("--json");
      expect(cmd[8]).toBe("--file");
      expect(cmd[9]!.startsWith(join(home, ".openhands", ".codemux", `task-${process.pid}-`))).toBe(true);
      privateAdapter.cleanupRunSync(context);
      const preview = privateAdapter.buildRunCommand({ agent: "openhands", prompt: "t", hermetic: true, cwd: work });
      expect(preview[1]).toBe(`HOME=${join(home, ".openhands", ".codemux-hermetic", "unprepared")}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a hermetic run requires an explicit clean --cwd", () => {
    const home = mkdtempSync(join(tmpdir(), "openhands-parity-"));
    const work = mkdtempSync(join(tmpdir(), "openhands-work-"));
    try {
      const privateAdapter = new OpenHandsAdapter({ ...OVERRIDE, HOME: home });
      expect(() =>
        privateAdapter.validateRunRequest({ agent: "openhands", prompt: "t", hermetic: true })
      ).toThrow(/requires an explicit --cwd/);
      writeFileSync(join(work, ".openhands"), "{}");
      expect(() =>
        privateAdapter.validateRunRequest({ agent: "openhands", prompt: "t", hermetic: true, cwd: work })
      ).toThrow(/clean working directory/);
      rmSync(join(work, ".openhands"), { recursive: true, force: true });
      expect(() =>
        privateAdapter.validateRunRequest({ agent: "openhands", prompt: "t", hermetic: true, cwd: work })
      ).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("the override routes litellm's openai/ prefix and refuses a missing model", () => {
    const privateAdapter = new OpenHandsAdapter(OVERRIDE);
    expect(privateAdapter.getRunEnv({ agent: "openhands", prompt: "t", model: "gpt-y" })).toEqual({
      LLM_BASE_URL: "https://gw.example/v1",
      LLM_API_KEY: "k",
      LLM_MODEL: "openai/gpt-y",
    });
    expect(privateAdapter.getRunEnv({ agent: "openhands", prompt: "t" })).toEqual({
      LLM_BASE_URL: "https://gw.example/v1",
      LLM_API_KEY: "k",
      LLM_MODEL: "openai/gpt-x",
    });
    const prefixed = privateAdapter.getRunEnv({
      agent: "openhands",
      prompt: "t",
      model: "openai/gpt-y",
    });
    expect(prefixed.LLM_MODEL).toBe("openai/gpt-y");
    const { CODEMUX_OPENHANDS_PROVIDER_MODEL: _m, ...bare } = OVERRIDE;
    const modelless = new OpenHandsAdapter(bare);
    expect(() => modelless.validateRunRequest({ agent: "openhands", prompt: "t" })).toThrow(
      /needs a model/
    );
  });

  test("--result-json rides --json with the env flag the task needs", () => {
    const cmd = adapter.buildRunCommand({
      agent: "openhands",
      prompt: "hello",
      resultJson: true,
      model: "m",
    });
    expect(cmd).toEqual(["openhands", "--headless", "--override-with-envs", "--json", "--task", "hello"]);
    const out = adapter.processRunResult(
      {
        stdout: JSON.stringify({ kind: "MessageEvent", source: "agent", llm_message: { content: "done" } }),
        stderr: "",
        exitCode: 0,
        success: true,
      },
      { agent: "openhands", prompt: "t", resultJson: true }
    );
    expect(out.success).toBe(true);
    expect(JSON.parse(out.stdout).codemux.agent).toBe("openhands");
  });
});
