import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GooseAdapter } from "../src/adapters/goose.js";

// Goose's `--tools none` is claimed: verified live at 1.50.1 on 2026-09-17
// through the provider override — under `--no-profile` neither capability
// probe could produce its secret while plain runs produced both
// (docs/HERMETIC.md). `--hermetic` stays refused: the live control probe
// leaked the planted code word, and the config-file system-prompt override
// `GOOSE_SYSTEM_PROMPT_FILE_PATH` has no switch.

describe("tools none: goose", () => {
  const adapter = new GooseAdapter();
  const noTools = { agent: "goose" as const, prompt: "p", tools: "none" as const };
  const head = ["goose", "run"];

  test("goose refuses --hermetic; --tools none is claimed (verified live)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-goose-refuse-"));
    try {
      mkdirSync(join(cwd, ".git"));
      expect(adapter.capabilities().supportsHermetic ?? false).toBe(false);
      expect(adapter.capabilities().supportsToolSelection ?? false).toBe(true);
      expect(() => adapter.validateRunRequest({ ...noTools, cwd }))
        .not.toThrow();
      expect(() => adapter.validateRunRequest({
        agent: "goose",
        prompt: "p",
        cwd,
        hermetic: true,
      })).toThrow("no verified hermetic mode");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("every run carries --no-profile before the prompt", () => {
    expect(adapter.buildRunCommand(noTools)).toEqual([...head, "--no-profile", "-t", "p"]);
    for (const autonomy of ["read-only", "low", "medium", "high"] as const) {
      expect(adapter.buildRunCommand({ ...noTools, autonomy }))
        .toEqual([...head, "--no-profile", "-t", "p"]);
    }
  });

  test("the mode and model env are unchanged under --tools none", () => {
    expect(adapter.getRunEnv({ ...noTools, autonomy: "high", model: "claude-sonnet-5" }))
      .toEqual({ GOOSE_MODE: "auto", GOOSE_MODEL: "claude-sonnet-5" });
    expect(adapter.getRunEnv(noTools)).toEqual({ GOOSE_MODE: "chat" });
  });

  test("plain runs keep the bare command", () => {
    expect(adapter.buildRunCommand({ agent: "goose", prompt: "p" }))
      .toEqual([...head, "-t", "p"]);
    expect(adapter.buildRunCommand({
      agent: "goose",
      prompt: "p",
      tools: "default",
      autonomy: "high",
    })).toEqual([...head, "-t", "p"]);
  });
});
