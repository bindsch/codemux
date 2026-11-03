/**
 * Unit tests for the claude session spawn: the autonomy flag mapping
 * (claudeSessionAutonomyFlags) and the argv builder
 * (buildClaudeSessionCommand). Split from the former
 * tests/session-claude.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_SESSION_FLOOR,
  buildClaudeSessionCommand,
  claudeSessionAutonomyFlags,
} from "../src/session/claude-session.js";
import { claudeAutonomyFlags, grantRule } from "../src/claude-autonomy.js";
import { claudeProviderPickerSettings } from "../src/claude-family.js";
import { HARNESS_CONTRACTS, compareVersions } from "../src/harness-compatibility.js";
import { FLOOR_ID } from "./helpers/session-claude.js";

describe("claudeSessionAutonomyFlags", () => {
  test("high is permission-mode default plus the grant list, never the bypass flag", () => {
    const flags = claudeSessionAutonomyFlags("high", "/tmp/launch");
    expect(flags).toEqual([
      "--permission-mode",
      "default",
      "--allowedTools",
      "Edit",
      "Write",
      "NotebookEdit",
      "Bash",
    ]);
    expect(flags.join(" ")).not.toContain("dangerously");
  });

  test("medium keeps shell and web tools under the ceiling callback", () => {
    expect(claudeSessionAutonomyFlags("medium", "/tmp/launch")).toEqual([
      "--permission-mode", "acceptEdits", "--allowedTools", grantRule("/tmp/launch"),
    ]);
    expect(claudeAutonomyFlags("medium", "/tmp/launch")).toContain("Bash");
  });

  test("low and read-only reuse the run mapping without its web grants", () => {
    for (const level of ["low", "read-only"] as const) {
      const flags = claudeSessionAutonomyFlags(level, "/tmp/launch");
      expect(flags).toEqual(claudeAutonomyFlags(level, "/tmp/launch", { web: "callback" }));
      // The ceiling answers each tool call; an allow or deny rule for the web tools would bypass it.
      expect(flags).not.toContain("WebSearch");
      expect(flags).not.toContain("--disallowedTools");
    }
    expect(claudeAutonomyFlags("read-only", "/tmp/launch")).toContain("WebFetch");
  });
});

describe("buildClaudeSessionCommand", () => {
  test("fresh spawn carries the carrier, verbose, replay, and the codemux session id", () => {
    const { argv, sessionId } = buildClaudeSessionCommand({
      agent: "claude",
      autonomy: "read-only",
      cwd: "/tmp/launch",
    });
    expect(argv[0]).toBe("claude");
    const joined = argv.join(" ");
    expect(joined).toContain("--permission-prompt-tool stdio");
    expect(joined).toContain("--verbose");
    expect(joined).toContain("--replay-user-messages");
    expect(joined).toContain("--include-partial-messages");
    expect(joined).not.toContain("--no-session-persistence");
    expect(argv).toContain("--session-id");
    expect(argv[argv.indexOf("--session-id") + 1]).toBe(sessionId);
    // UUID-shaped: the resume path validates that shape at the CLI.
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  test("the resume id precedes every autonomy-derived flag", () => {
    const { argv } = buildClaudeSessionCommand({
      agent: "claude",
      resumeId: FLOOR_ID,
      autonomy: "read-only",
      cwd: "/tmp/launch",
    });
    const resumeAt = argv.indexOf("--resume");
    const permissionModeAt = argv.indexOf("--permission-mode");
    expect(argv[resumeAt + 1]).toBe(FLOOR_ID);
    expect(argv).not.toContain("--session-id");
    expect(resumeAt).toBeLessThan(permissionModeAt);
  });

  test("a session created at high and resumed read-only emits exactly read-only's flags", () => {
    const high = buildClaudeSessionCommand({
      agent: "claude",
      resumeId: FLOOR_ID,
      autonomy: "high",
      cwd: "/tmp/launch",
    }).argv;
    const readOnly = buildClaudeSessionCommand({
      agent: "claude",
      resumeId: FLOOR_ID,
      autonomy: "read-only",
      cwd: "/tmp/launch",
    }).argv;
    expect(high).toContain("--allowedTools");
    // Everything after the fixed prefix is the autonomy block: on the
    // read-only resume it is exactly read-only's flags — no high grant
    // survives the resume, and no bypass flag ever appears.
    const tail = readOnly.slice(readOnly.indexOf("--strict-mcp-config") + 1);
    expect(tail).toEqual(claudeSessionAutonomyFlags("read-only", "/tmp/launch"));
    expect(tail.join(" ")).not.toContain("--allowedTools");
    expect(readOnly.join(" ")).not.toContain("dangerously");
  });

  test("the session floor sits above the run contract's minimum", () => {
    expect(
      compareVersions(CLAUDE_SESSION_FLOOR, HARNESS_CONTRACTS.claude!.min)
    ).toBeGreaterThan(0);
  });

  test("project settings replace the user source, with slash commands off and no safe mode", () => {
    // The --experiment-project-settings session mode: the project and
    // local setting sources in place of the user source, every skill off
    // (the run path's rule), and never --safe-mode — a session passes it
    // in no mode, and this mode above all exists to observe the project's
    // own rules, which safe mode would ignore.
    const { argv } = buildClaudeSessionCommand({
      agent: "claude",
      autonomy: "low",
      cwd: "/tmp/launch",
      projectSettings: true,
    });
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("project,local");
    expect(argv).toContain("--disable-slash-commands");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).not.toContain("--safe-mode");
  });

  test("a plain session keeps the user source and its skills", () => {
    const { argv } = buildClaudeSessionCommand({
      agent: "claude",
      autonomy: "low",
      cwd: "/tmp/launch",
    });
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("user");
    expect(argv).not.toContain("--disable-slash-commands");
    expect(argv).not.toContain("--safe-mode");
  });

  test("a caller-minted session id pins --session-id; a resume ignores it", () => {
    // The CLI mints the id before anything spawns so the private config
    // directory, the registry record, and --session-id name one id.
    const pinned = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const fresh = buildClaudeSessionCommand({
      agent: "claude",
      autonomy: "low",
      cwd: "/tmp/launch",
      sessionId: pinned,
    });
    expect(fresh.sessionId).toBe(pinned);
    expect(fresh.argv[fresh.argv.indexOf("--session-id") + 1]).toBe(pinned);
    const resumed = buildClaudeSessionCommand({
      agent: "claude",
      autonomy: "low",
      cwd: "/tmp/launch",
      resumeId: FLOOR_ID,
      sessionId: pinned,
    });
    expect(resumed.argv).not.toContain("--session-id");
    expect(resumed.argv[resumed.argv.indexOf("--resume") + 1]).toBe(FLOOR_ID);
  });

  test("the Playwright MCP rides the sandbox-scoped carrier in run's argv position", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-session-mcp-"));
    const binaryPath = join(dir, "playwright-mcp");
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binaryPath, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    try {
      // A real directory: the carrier's forbidden-root check resolves it.
      const { argv } = buildClaudeSessionCommand({
        agent: "claude",
        autonomy: "read-only",
        cwd: process.cwd(),
        model: "some-model",
        sandboxed: true,
        enablePlaywrightMcp: true,
      });
      const mcpAt = argv.indexOf("--mcp-config");
      expect(mcpAt).toBeGreaterThan(-1);
      // Run parity: after the --strict-mcp-config scoping, before the
      // model and the autonomy block.
      expect(mcpAt).toBeGreaterThan(argv.indexOf("--strict-mcp-config"));
      expect(mcpAt).toBeLessThan(argv.indexOf("--model"));
      expect(mcpAt).toBeLessThan(argv.indexOf("--permission-mode"));
      expect(
        JSON.parse(argv[mcpAt + 1] ?? "").mcpServers.playwright.command
      ).toBe(realpathSync(binaryPath));
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
    // Absent when the flag is off — the sandbox-scoped default.
    expect(
      buildClaudeSessionCommand({
        agent: "claude",
        autonomy: "read-only",
        cwd: "/tmp/launch",
        sandboxed: true,
      }).argv
    ).not.toContain("--mcp-config");
  });

  test("the providerSettings payload rides --settings right after the model it describes", () => {
    // The override's modelPicker mapping (claude-family.ts): the session
    // record carries the already-rendered payload, so the argv position —
    // after --model, before the autonomy block — is this builder's own
    // contract.
    const { argv } = buildClaudeSessionCommand({
      agent: "claude",
      autonomy: "read-only",
      cwd: "/tmp/launch",
      model: "clawvm-qwen32b-coder",
      providerSettings: claudeProviderPickerSettings("clawvm-qwen32b-coder"),
    });
    const settingsAt = argv.indexOf("--settings");
    const modelAt = argv.indexOf("--model");
    expect(modelAt).toBeGreaterThan(-1);
    expect(settingsAt).toBe(modelAt + 2);
    expect(settingsAt).toBeLessThan(argv.indexOf("--permission-mode"));
    expect(JSON.parse(argv[settingsAt + 1] ?? "")).toEqual({
      modelPicker: {
        options: [{ model: "clawvm-qwen32b-coder", behavesAs: "claude-sonnet-5" }],
      },
    });
    // Absent when the caller passed none — the plain session's shape.
    expect(
      buildClaudeSessionCommand({
        agent: "claude",
        autonomy: "read-only",
        cwd: "/tmp/launch",
        model: "some-model",
      }).argv
    ).not.toContain("--settings");
  });
});
