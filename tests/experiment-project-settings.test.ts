import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import { validateProjectSettingsRequest } from "../src/claude-project-settings.js";
import { UsageRefusalError } from "../src/validation.js";
import type { RunRequest } from "../src/types.js";

describe("--experiment-project-settings", () => {
  // A fixture whose ancestors carry none of the refused memory names, so
  // these tests exercise the flag rules, not the ancestor walk.
  let clean = "";
  beforeAll(() => {
    clean = mkdtempSync(join(tmpdir(), "codemux-pps-clean-"));
  });
  afterAll(() => rmSync(clean, { recursive: true, force: true }));
  const valid = () =>
    ({ agent: "claude" as const, hermetic: true, autonomy: "low" as const, sandbox: true, cwd: clean });

  for (const [agent, adapter] of [["claude", new ClaudeAdapter()], ["zai", new ZaiAdapter()]] as const) {
    const request: RunRequest = { agent, prompt: "p", hermetic: true, experimentProjectSettings: true };

    test(`${agent} loads project rules in place of safe mode and the user source`, () => {
      const cmd = adapter.buildRunCommand(request);
      expect(cmd).not.toContain("--safe-mode");
      expect(cmd[cmd.indexOf("--setting-sources") + 1]).toBe("project,local");
      expect(cmd).toContain("--strict-mcp-config");
      expect(cmd).toContain("--disable-slash-commands");
    });

    test(`${agent} hermetic runs without the flag keep safe mode and the user source`, () => {
      const cmd = adapter.buildRunCommand({ ...request, experimentProjectSettings: false });
      expect(cmd).toContain("--safe-mode");
      expect(cmd[cmd.indexOf("--setting-sources") + 1]).toBe("user");
      expect(cmd).not.toContain("--disable-slash-commands");
    });
  }

  test("accepts a hermetic, sandboxed, low-autonomy run on either agent", () => {
    expect(() => validateProjectSettingsRequest(valid())).not.toThrow();
    expect(() => validateProjectSettingsRequest({ ...valid(), agent: "zai" })).not.toThrow();
  });

  test("opencode accepts low and high; a run's high still binds deny rules", () => {
    // OpenCode's low is --agent build with a headless run that rejects
    // every ask, and its high is --agent build --auto, which approves
    // every ask — while a deny rule fails the call before the question
    // is ever emitted at either level. The build agent's defaults allow
    // every unlisted call ("*" allow, agent/agent.ts at 1.18.18), so at
    // low an unlisted command runs unless the project asks for it — see
    // OPENCODE_RUN_AUTONOMIES.
    expect(() => validateProjectSettingsRequest({ ...valid(), agent: "opencode" })).not.toThrow();
    expect(() =>
      validateProjectSettingsRequest({ ...valid(), agent: "opencode", autonomy: "high" })
    ).not.toThrow();
  });

  test.each([
    ["read-only autonomy", { autonomy: "read-only" }, "requires --auto low or high"],
    ["medium autonomy", { autonomy: "medium" }, "requires --auto low or high"],
    ["a session", { session: true }, "claude and zai only"],
    ["a passed-through config file", { passthroughEnv: ["OPENCODE_CONFIG"] }, "--pass-env OPENCODE_CONFIG"],
    ["a passed-through config directory", { passthroughEnv: ["OPENCODE_CONFIG_DIR"] }, "--pass-env OPENCODE_CONFIG_DIR"],
    ["a passed-through config content", { passthroughEnv: ["OPENCODE_CONFIG_CONTENT"] }, "--pass-env OPENCODE_CONFIG_CONTENT"],
    ["a passed-through permission ruleset", { passthroughEnv: ["OTHER", "OPENCODE_PERMISSION"] }, "--pass-env OPENCODE_PERMISSION"],
    ["a passed-through auth content", { passthroughEnv: ["OPENCODE_AUTH_CONTENT"] }, "--pass-env OPENCODE_AUTH_CONTENT"],
    ["no tools", { tools: "none" }, "--tools none"],
    ["an experiment server", { experimentMcp: "spec.json" }, "--experiment-mcp"],
    ["no hermetic", { hermetic: false }, "requires --hermetic"],
    ["no sandbox", { sandbox: false }, "requires the scode sandbox"],
  ])("opencode refuses %s", (_name, change, message) => {
    expect(() =>
      validateProjectSettingsRequest({ ...valid(), agent: "opencode", ...change })
    ).toThrow(message);
  });

  test.each([
    ["another agent", { agent: "codex" }, "claude, zai, and opencode agents only"],
    ["a non-hermetic run", { hermetic: false }, "requires --hermetic"],
    ["no sandbox", { sandbox: false }, "requires the scode sandbox"],
    ["medium autonomy", { autonomy: "medium" }, "requires --auto low"],
    ["high autonomy", { autonomy: "high" }, "requires --auto low"],
    ["no tools", { tools: "none" }, "--tools none"],
    ["an experiment server", { experimentMcp: "spec.json" }, "--experiment-mcp"],
    ["a passed-through config redirect", { passthroughEnv: ["CLAUDE_CONFIG_DIR"] }, "--pass-env CLAUDE_CONFIG_DIR"],
    ["a passed-through project dir name", { passthroughEnv: ["OTHER", "CLAUDE_CODE_PROJECT_DIR_NAME"] }, "--pass-env CLAUDE_CODE_PROJECT_DIR_NAME"],
  ])("refuses %s", (_name, change, message) => {
    expect(() => validateProjectSettingsRequest({ ...valid(), ...change })).toThrow(message);
  });

  test("a session accepts low and the codemux session high; a run does not take high", () => {
    // The session high is --permission-mode default plus codemux's own
    // grant list, never the bypass flag, so the project's deny rules
    // still bind and the level stays observable (claude-session.ts).
    expect(() =>
      validateProjectSettingsRequest({ ...valid(), session: true, autonomy: "high" })
    ).not.toThrow();
    expect(() =>
      validateProjectSettingsRequest({ ...valid(), session: true, autonomy: "low" })
    ).not.toThrow();
    // A run keeps the low-only rule: its high is the bypass flag.
    expect(() => validateProjectSettingsRequest({ ...valid(), autonomy: "high" })).toThrow(
      "requires --auto low"
    );
  });

  test.each([
    ["read-only", "read-only"],
    ["medium", "medium"],
  ])("a session refuses %s autonomy", (_name, autonomy) => {
    expect(() => validateProjectSettingsRequest({ ...valid(), session: true, autonomy })).toThrow(
      "requires --auto low or high for sessions"
    );
  });
});

describe("--experiment-project-settings: ancestor project memory", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // A three-level tree: the fixture's parent and grandparent are the two
  // ancestors nearest the working directory the refusal must catch.
  function tree(): { grand: string; parent: string; cwd: string } {
    const grand = mkdtempSync(join(tmpdir(), "codemux-pps-ancestors-"));
    scratch.push(grand);
    const parent = join(grand, "parent");
    const cwd = join(parent, "fixture");
    mkdirSync(cwd, { recursive: true });
    return { grand, parent, cwd };
  }

  const names = ["CLAUDE.md", "CLAUDE.local.md", join(".claude", "CLAUDE.md"), join(".claude", "rules")];
  const kinds: [string, (at: string) => void][] = [
    ["a file", (at) => writeFileSync(at, "operator memory\n")],
    ["a directory", (at) => mkdirSync(at)],
    ["a dangling link", (at) => symlinkSync(join("nowhere", String(process.pid)), at)],
  ];
  // The nested names need their `.claude` parent before anything can be
  // planted inside it; the plain names already sit in an existing directory.
  const plant = (at: string, kind: string): void => {
    mkdirSync(dirname(at), { recursive: true });
    kinds.find(([label]) => label === kind)![1](at);
  };
  const attempt = (cwd: string): unknown => {
    try {
      validateProjectSettingsRequest({ agent: "claude", hermetic: true, autonomy: "low", sandbox: true, cwd });
    } catch (error) {
      return error;
    }
    return null;
  };

  const cases: [string, string, "parent" | "grandparent"][] = [];
  for (const name of names)
    for (const [kind] of kinds)
      for (const level of ["parent", "grandparent"] as const) cases.push([name, kind, level]);

  test.each(cases)("refuses %s as %s at the fixture's %s", (name, kind, level) => {
    const { grand, parent, cwd } = tree();
    const base = level === "parent" ? parent : grand;
    plant(join(base, name), kind);
    const error = attempt(cwd);
    expect(error).toBeInstanceOf(UsageRefusalError);
    // The message names the canonical offending path (the walk starts from
    // the realpath of the working directory).
    expect((error as Error).message).toContain(join(realpathSync(base), name));
  });

  test("accepts a fixture whose own directory carries every name", () => {
    const { cwd } = tree();
    writeFileSync(join(cwd, "CLAUDE.md"), "fixture memory\n");
    writeFileSync(join(cwd, "CLAUDE.local.md"), "fixture local\n");
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude", "CLAUDE.md"), "fixture project\n");
    mkdirSync(join(cwd, ".claude", "rules"));
    for (const agent of ["claude", "zai"] as const) {
      expect(() =>
        validateProjectSettingsRequest({ agent, hermetic: true, autonomy: "low", sandbox: true, cwd })
      ).not.toThrow();
    }
  });

  test("names the nearest offending ancestor", () => {
    const { grand, parent, cwd } = tree();
    writeFileSync(join(parent, "CLAUDE.md"), "near\n");
    mkdirSync(join(grand, ".claude", "rules"), { recursive: true });
    const error = attempt(cwd);
    expect(error).toBeInstanceOf(UsageRefusalError);
    expect((error as Error).message).toContain(join(realpathSync(parent), "CLAUDE.md"));
    expect((error as Error).message).not.toContain(join(realpathSync(grand), ".claude", "rules"));
  });
});

describe("--experiment-project-settings: OpenCode ancestor project config", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tree(): { grand: string; parent: string; cwd: string } {
    const grand = mkdtempSync(join(tmpdir(), "codemux-pps-opencode-"));
    scratch.push(grand);
    const parent = join(grand, "parent");
    const cwd = join(parent, "fixture");
    mkdirSync(cwd, { recursive: true });
    return { grand, parent, cwd };
  }

  // The names OpenCode's project walks look for above the working
  // directory: the config walk's opencode.jsonc/opencode.json and .opencode
  // (config/paths.ts) and the instruction walk's AGENTS.md, CLAUDE.md, and
  // CONTEXT.md (session/instruction.ts).
  const names = ["opencode.json", "opencode.jsonc", ".opencode", "AGENTS.md", "CLAUDE.md", "CONTEXT.md"];
  const kinds: [string, (at: string) => void][] = [
    ["a file", (at) => writeFileSync(at, "operator config\n")],
    ["a directory", (at) => mkdirSync(at)],
    ["a dangling link", (at) => symlinkSync(join("nowhere", String(process.pid)), at)],
  ];
  const plant = (at: string, kind: string): void => {
    kinds.find(([label]) => label === kind)![1](at);
  };
  const attempt = (cwd: string): unknown => {
    try {
      validateProjectSettingsRequest({ agent: "opencode", hermetic: true, autonomy: "low", sandbox: true, cwd });
    } catch (error) {
      return error;
    }
    return null;
  };

  const cases: [string, string, "parent" | "grandparent"][] = [];
  for (const name of names)
    for (const [kind] of kinds)
      for (const level of ["parent", "grandparent"] as const) cases.push([name, kind, level]);

  test.each(cases)("refuses %s as %s at the fixture's %s", (name, kind, level) => {
    const { grand, parent, cwd } = tree();
    const base = level === "parent" ? parent : grand;
    plant(join(base, name), kind);
    const error = attempt(cwd);
    expect(error).toBeInstanceOf(UsageRefusalError);
    // The message names the canonical offending path.
    expect((error as Error).message).toContain(join(realpathSync(base), name));
  });

  test("accepts a fixture whose own directory carries every name", () => {
    const { cwd } = tree();
    writeFileSync(join(cwd, "opencode.json"), "{}\n");
    writeFileSync(join(cwd, "opencode.jsonc"), "{}\n");
    mkdirSync(join(cwd, ".opencode", "plugin"), { recursive: true });
    writeFileSync(join(cwd, "AGENTS.md"), "fixture instructions\n");
    writeFileSync(join(cwd, "CLAUDE.md"), "fixture claude\n");
    writeFileSync(join(cwd, "CONTEXT.md"), "fixture context\n");
    expect(() =>
      validateProjectSettingsRequest({ agent: "opencode", hermetic: true, autonomy: "high", sandbox: true, cwd })
    ).not.toThrow();
  });

  test("names the nearest offending ancestor", () => {
    const { grand, parent, cwd } = tree();
    writeFileSync(join(parent, "AGENTS.md"), "near\n");
    mkdirSync(join(grand, ".opencode"));
    const error = attempt(cwd);
    expect(error).toBeInstanceOf(UsageRefusalError);
    expect((error as Error).message).toContain(join(realpathSync(parent), "AGENTS.md"));
    expect((error as Error).message).not.toContain(join(realpathSync(grand), ".opencode"));
  });
});
