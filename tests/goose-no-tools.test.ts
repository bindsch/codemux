import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GooseAdapter } from "../src/adapters/goose.js";

// Goose's `--tools none` is claimed: verified live at 1.50.1 on 2026-09-17
// through the provider override — under `--no-profile` neither capability
// probe could produce its secret while plain runs produced both
// (docs/isolation.md). `--hermetic` is implemented (the 2.0.0 parity pass,
// the XDG redirect of src/goose-hermetic.ts) and FAILS CLOSED without the
// provider override: the private home carries no config.yaml, and that
// file holds the operator's system prompt next to any keys, so no
// configuration can ride along (the adapter's own validateRunRequest).

describe("tools none: goose", () => {
  const adapter = new GooseAdapter();
  const noTools = { agent: "goose" as const, prompt: "p", tools: "none" as const };
  const head = ["goose", "run"];

  test("goose --hermetic is claimed but fails closed without the provider override; --tools none is claimed (verified live)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-goose-refuse-"));
    try {
      mkdirSync(join(cwd, ".git"));
      expect(adapter.capabilities().supportsHermetic ?? false).toBe(true);
      expect(adapter.capabilities().supportsToolSelection ?? false).toBe(true);
      expect(() => adapter.validateRunRequest({ ...noTools, cwd }))
        .not.toThrow();
      expect(() => adapter.validateRunRequest({
        agent: "goose",
        prompt: "p",
        cwd,
        hermetic: true,
      })).toThrow("goose --hermetic requires the provider override");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("every run carries --no-profile before the prompt", () => {
    expect(adapter.buildRunCommand(noTools)).toEqual([...head, "--no-profile", "-i", "-"]);
    // The prompt rides stdin (goose run -i -), never argv.
    expect(adapter.getStdinInput(noTools)).toBe("p");
    for (const autonomy of ["read-only", "low", "medium", "high"] as const) {
      expect(adapter.buildRunCommand({ ...noTools, autonomy }))
        .toEqual([...head, "--no-profile", "-i", "-"]);
    }
  });

  test("the mode and model env are unchanged under --tools none", () => {
    expect(adapter.getRunEnv({ ...noTools, autonomy: "high", model: "claude-sonnet-5" }))
      .toEqual({ GOOSE_MODE: "auto", GOOSE_MODEL: "claude-sonnet-5" });
    expect(adapter.getRunEnv(noTools)).toEqual({ GOOSE_MODE: "chat" });
  });

  test("plain runs keep the bare command", () => {
    expect(adapter.buildRunCommand({ agent: "goose", prompt: "p" }))
      .toEqual([...head, "-i", "-"]);
    expect(adapter.buildRunCommand({
      agent: "goose",
      prompt: "p",
      tools: "default",
      autonomy: "high",
    })).toEqual([...head, "-i", "-"]);
  });
});
