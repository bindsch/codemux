import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIDER_EMPTY_CONFIG_PATH,
  AIDER_MODEL_METADATA_PATH,
  AIDER_MODEL_SETTINGS_PATH,
  AiderAdapter,
  aiderPromptIsCommand,
} from "../src/adapters/aider.js";
import { UsageRefusalError } from "../src/validation.js";

describe("AiderAdapter", () => {
  const adapter = new AiderAdapter();

  test("describes its supported capabilities", () => {
    expect(adapter.id).toBe("aider");
    expect(adapter.binaryName).toBe("aider");
    expect(adapter.capabilities()).toEqual({
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      // Hermetic since the parity round: a private HOME plus the
      // clean-working-directory rule close the config layers the pinned
      // flags never could (docs/isolation.md names the channels).
      supportsHermetic: true,
      supportsProviderOverride: true,
      supportsToolSelection: true,
    });
  });

  test("refuses a prompt aider would run as a slash command (review D10, security)", () => {
    // Aider's preproc_user_input dispatches a message whose first
    // non-whitespace character is `/` (a slash command) or `!` (the
    // /run alias, which executes the shell immediately, ungated by
    // --dry-run) BEFORE any model turn, so relaying one through a
    // read-only run is code execution the autonomy never authorized.
    // The rule refuses — never escapes — and the session driver's twin
    // (before the ack) carries the same predicate.
    expect(aiderPromptIsCommand("/run whoami")).toBe(true);
    expect(aiderPromptIsCommand("!touch pwned")).toBe(true);
    // Leading whitespace does not hide the dispatch: aider skips it too.
    expect(aiderPromptIsCommand("  /add file")).toBe(true);
    expect(aiderPromptIsCommand("\n!curl http://127.0.0.1:9")).toBe(true);
    // A slash later in the text, or an author label ahead of it, is
    // plain prompt text — only the first non-whitespace character
    // dispatches.
    expect(aiderPromptIsCommand("what is /etc/hosts for?")).toBe(false);
    expect(aiderPromptIsCommand("[ana] /run whoami")).toBe(false);

    const cwd = mkdtempSync(join(tmpdir(), "aider-slash-"));
    try {
      for (const prompt of ["/run whoami", "!touch pwned"]) {
        let refusal: unknown;
        try {
          adapter.validateRunRequest({ agent: "aider", prompt, cwd });
        } catch (error) {
          refusal = error;
        }
        // Usage, not a run failure: the marker the CLI maps to exit 64,
        // so a script can tell a request only the caller can fix from a
        // run that failed.
        expect(refusal).toBeInstanceOf(UsageRefusalError);
        expect((refusal as Error).message).toContain(
          "aider prompts must not start with '/' or '!'"
        );
        expect((refusal as Error).message).toContain("ungated by --dry-run");
      }
      // A plain prompt still validates clean.
      expect(() =>
        adapter.validateRunRequest({ agent: "aider", prompt: "fix the tests", cwd })
      ).not.toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("builds run commands without confusing model and message flags", () => {
    const command = adapter.buildRunCommand({
      agent: "aider",
      prompt: "fix the tests",
      model: "openai/gpt-5.4",
      autonomy: "read-only",
      effort: "high",
    });
    expect(command).toEqual([
      "aider",
      "--config",
      AIDER_EMPTY_CONFIG_PATH,
      "--env-file",
      devNull,
      "--model-settings-file",
      AIDER_MODEL_SETTINGS_PATH,
      "--model-metadata-file",
      AIDER_MODEL_METADATA_PATH,
      "--input-history-file",
      devNull,
      "--chat-history-file",
      devNull,
      "--no-gitignore",
      "--no-auto-commits",
      "--no-dirty-commits",
      "--no-analytics",
      "--no-suggest-shell-commands",
      "--no-check-update",
      "--no-show-release-notes",
      "--no-show-model-warnings",
      "--disable-playwright",
      "--no-stream",
      "--analytics-log",
      command[command.indexOf("--analytics-log") + 1]!,
      "--model",
      "openai/gpt-5.4",
      "--dry-run",
      "--reasoning-effort",
      "high",
      "--message-file",
      command[command.indexOf("--message-file") + 1]!,
    ]);
  });

  test("maps supervised and auto-confirm modes", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["--dry-run"]);
    expect(adapter.mapAutonomy("low")).toEqual([]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--yes-always"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--yes-always"]);
  });

  test("builds interactive commands and passes explicit none effort", () => {
    expect(adapter.buildTuiCommand("anthropic/claude-sonnet-4", "low", "none"))
      .toEqual([
        "aider",
        "--config",
        AIDER_EMPTY_CONFIG_PATH,
        "--env-file",
        devNull,
        "--model-settings-file",
        AIDER_MODEL_SETTINGS_PATH,
        "--model-metadata-file",
        AIDER_MODEL_METADATA_PATH,
        "--input-history-file",
        devNull,
        "--chat-history-file",
        devNull,
        "--no-gitignore",
        "--no-auto-commits",
        "--no-dirty-commits",
        "--no-analytics",
        "--no-suggest-shell-commands",
        "--no-check-update",
        "--no-show-release-notes",
        "--no-show-model-warnings",
        "--disable-playwright",
        "--model",
        "anthropic/claude-sonnet-4",
        "--reasoning-effort",
        "none",
      ]);
  });

  test("keeps leading-dash prompts out of argv", () => {
    const command = adapter.buildRunCommand({
      agent: "aider",
      prompt: "--dangerous-looking-prompt",
    });
    expect(command).toContain("--message-file");
    expect(command.join(" ")).not.toContain("dangerous-looking-prompt");
  });

  test("declines headless confirmations while prompt bytes use a private file", () => {
    expect(adapter.getStdinInput({ agent: "aider", prompt: "test" }))
      .toStartWith("n\nn\n");
    expect(adapter.promptInArgv({ agent: "aider", prompt: "x\0y" })).toBe(false);
    expect(() => adapter.validateRunRequest({ agent: "aider", prompt: "x\0y" })).toThrow("NUL");
    expect(() => adapter.validateRunRequest({
      agent: "aider",
      prompt: "x".repeat(40_000),
    })).not.toThrow();
  });
});

describe("AiderAdapter run parity", () => {
  test("a hermetic run routes aider through a private HOME with the map disabled", () => {
    const home = mkdtempSync(join(tmpdir(), "aider-parity-"));
    try {
      const adapter = new AiderAdapter({ HOME: home });
      const context = adapter.prepareRun({ agent: "aider", prompt: "p", hermetic: true, cwd: home });
      const cmd = adapter.buildRunCommand({ agent: "aider", prompt: "p", hermetic: true, cwd: home }, context);
      expect(cmd[0]).toBe("env");
      expect(cmd[1]!.startsWith(`HOME=${join(home, ".aider", ".codemux-hermetic", "run-")}`)).toBe(true);
      expect(cmd[2]).toBe("aider");
      expect(cmd).toContain("--map-tokens");
      expect(cmd[cmd.indexOf("--map-tokens") + 1]).toBe("0");
      // The per-run chat history file, not /dev/null: hermetic is where the
      // answer extraction reads it back.
      expect(cmd).toContain(context.aiderHistoryFile!.path);
      adapter.cleanupRunSync(context);
      expect(existsSync(context.aiderHistoryFile!.path)).toBe(false);
      expect(existsSync(context.aiderHermeticHome!.home)).toBe(false);
      // The static preview names no real directory.
      const preview = adapter.buildRunCommand({ agent: "aider", prompt: "p", hermetic: true, cwd: home });
      expect(preview[1]).toBe(`HOME=${join(home, ".aider", ".codemux-hermetic", "unprepared")}`);
      expect(preview).toContain(devNull);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a hermetic run requires an explicit clean --cwd across aider's four config names", () => {
    const home = mkdtempSync(join(tmpdir(), "aider-parity-"));
    const work = mkdtempSync(join(tmpdir(), "aider-work-"));
    const adapter = new AiderAdapter({ HOME: home });
    try {
      expect(() =>
        adapter.validateRunRequest({ agent: "aider", prompt: "p", hermetic: true })
      ).toThrow(/requires an explicit --cwd/);
      for (const name of [".aider.conf.yml", ".aider.model.settings.yml", ".aider.model.metadata.json", ".env"]) {
        writeFileSync(join(work, name), "x");
        // Every name is refused before launch. .aider.model.settings.yml is
        // double-guarded: the repository executable-configuration check
        // fires first, the clean-cwd walk covers it on hermetic runs that
        // pass that gate (the adapter-level names are the walk's input).
        expect(() =>
          adapter.validateRunRequest({ agent: "aider", prompt: "p", hermetic: true, cwd: work })
        ).toThrow(/refuses repository executable configuration|clean working directory/);
        rmSync(join(work, name));
      }
      expect(() =>
        adapter.validateRunRequest({ agent: "aider", prompt: "p", hermetic: true, cwd: work })
      ).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("--result-json stays refused: aider 0.86.2 has no JSON output mode", () => {
    expect(new AiderAdapter().capabilities().supportsResultJson ?? false).toBe(false);
  });
});
