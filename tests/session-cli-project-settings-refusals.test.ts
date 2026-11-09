/**
 * CLI-level refusals for `codemux session --experiment-project-settings`
 * and `--permission-policy deny`: every check that runs before anything
 * spawns. Split from session-cli-project-settings.test.ts for the file-size
 * rule; the synthetic session flows stay there.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minimalPath, runCli } from "./helpers/cli.js";
import { PROJECT_SETTINGS_AGENTS } from "../src/claude-project-settings.js";

describe("CLI - project-settings session refusals", () => {
  test("the mode without --hermetic refuses with 64", async () => {
    const { stderr, exitCode } = await runCli(
      ["session", "-a", "claude", "--experiment-project-settings", "--auto", "low"],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--experiment-project-settings requires --hermetic");
  });

  test.each([
    ["droid", "low", `${PROJECT_SETTINGS_AGENTS.join(", ")} agents only`],
    // Codex sessions carry the mode at low and high; medium grants every
    // shell command and is refused before any binary lookup.
    ["codex", "medium", "requires --auto low or high for codex sessions"],
  ])("the mode on a %s session at %s refuses with 64", async (agent, auto, message) => {
    const { stderr, exitCode } = await runCli(
      ["session", "-a", agent, "--hermetic", "--experiment-project-settings", "--auto", auto],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain(message);
  });

  test("--final without --hermetic refuses with 64", async () => {
    const { stderr, exitCode } = await runCli(
      ["session", "-a", "claude", "--final"],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--final requires --hermetic");
  });

  test.each([
    ["read-only (the default)", ["--hermetic", "--experiment-project-settings"]],
    ["medium", ["--hermetic", "--experiment-project-settings", "--auto", "medium"]],
  ])("autonomy %s refuses with 64", async (_name, flags) => {
    const { stderr, exitCode } = await runCli(
      ["session", "-a", "claude", ...flags],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("requires --auto low or high for sessions");
  });

  test("a passed-through config redirect refuses with 64", async () => {
    const { stderr, exitCode } = await runCli(
      [
        "session", "-a", "claude", "--hermetic", "--experiment-project-settings",
        "--auto", "low", "--pass-env", "CLAUDE_CONFIG_DIR",
      ],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--pass-env CLAUDE_CONFIG_DIR");
  });

  test("an ancestor carrying project memory refuses with 64, naming the path", async () => {
    const root = mkdtempSync(join(tmpdir(), "codemux-pps-cli-"));
    try {
      const cwd = join(root, "parent", "fixture");
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(root, "CLAUDE.md"), "operator memory\n");
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--hermetic", "--experiment-project-settings",
          "--auto", "low", "--cwd", cwd,
        ],
        { PATH: minimalPath() }
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain(join(root, "CLAUDE.md"));
      expect(stderr).toContain("project memory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a bad --permission-policy value and goose's unavailable deny fail closed", async () => {
    const bogus = await runCli(
      ["session", "-a", "claude", "--permission-policy", "bogus", "--no-sandbox", "--auto", "high"],
      { PATH: minimalPath() }
    );
    expect(bogus.exitCode).toBe(64);
    expect(bogus.stderr).toContain("--permission-policy accepts 'default' or 'deny'");
    // Codex and aider carry deny since the parity passes, so the refusal
    // rides goose, whose session.permission-policy-deny is a declared
    // harness limitation (GOOSE_MODE bounds the turn at spawn; no ask
    // channel, src/parity/reasons-run-carriers.ts).
    const goose = await runCli(
      ["session", "-a", "goose", "--permission-policy", "deny", "--no-sandbox", "--auto", "high"],
      { PATH: minimalPath() }
    );
    expect(goose.exitCode).toBe(64);
    expect(goose.stderr).toContain("--permission-policy deny is unavailable for 'goose'");
  });
});
