import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
      // Refused: the 2026-09-17 check passed, but no flag closes aider's
      // own config layers, and a live 2026-10-04 probe leaked through
      // `.aider.conf.yml` (docs/isolation.md names the channels).
      supportsHermetic: false,
      supportsProviderOverride: true,
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
    expect(adapter.buildRunCommand({
      agent: "aider",
      prompt: "fix the tests",
      model: "openai/gpt-5.4",
      autonomy: "read-only",
      effort: "high",
    })).toEqual([
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
      "openai/gpt-5.4",
      "--dry-run",
      "--reasoning-effort",
      "high",
      "--message=fix the tests",
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

  test("keeps leading-dash prompts inside the message option", () => {
    expect(adapter.buildRunCommand({
      agent: "aider",
      prompt: "--dangerous-looking-prompt",
    })).toContain("--message=--dangerous-looking-prompt");
  });

  test("declines headless prompts and retains the argv size guard", () => {
    expect(adapter.getStdinInput({ agent: "aider", prompt: "test" }))
      .toStartWith("n\nn\n");
    // Round 153: the shared validator owns the argv rules through
    // promptInArgv — aider's stdin carries the canned declines while the
    // prompt itself rides `--message=` argv — so a NUL in the prompt is a
    // usage refusal (the marker the CLI maps to exit 64), not the
    // spawn-time "invalid command" it used to become.
    let refusal: unknown;
    try {
      adapter.validateRunRequest({ agent: "aider", prompt: "x\0y" });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(UsageRefusalError);
    expect((refusal as Error).message).toContain("NUL");
    expect(() => adapter.validateRunRequest({
      agent: "aider",
      prompt: "x".repeat(40_000),
    })).toThrow("passes prompts in argv");
  });
});
