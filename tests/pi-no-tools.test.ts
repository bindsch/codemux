import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAdapter } from "../src/adapters/pi.js";

// Pi's `--tools none` mapping is implemented but not claimed: the
// capability probe needs an installed pi, and the release machine has none
// (docs/HERMETIC.md). `--hermetic` has no mechanism: the global
// ~/.pi/SYSTEM.md system-prompt override has no switch.

describe("tools none: pi", () => {
  const adapter = new PiAdapter();
  const noTools = { agent: "pi" as const, prompt: "p", tools: "none" as const };
  const head = ["pi", "--print", "--no-session", "--no-approve"];

  test("pi refuses --hermetic and --tools none until a probe runs", () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-pi-refuse-"));
    try {
      mkdirSync(join(cwd, ".git"));
      expect(adapter.capabilities().supportsHermetic ?? false).toBe(false);
      expect(adapter.capabilities().supportsToolSelection ?? false).toBe(false);
      expect(() => adapter.validateRunRequest({ ...noTools, cwd }))
        .toThrow("cannot remove its built-in tools");
      expect(() => adapter.validateRunRequest({
        agent: "pi",
        prompt: "p",
        cwd,
        hermetic: true,
      })).toThrow("no verified hermetic mode");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("every autonomy level carries --no-tools and no --tools allowlist", () => {
    expect(adapter.buildRunCommand({ ...noTools, autonomy: "read-only" }))
      .toEqual([...head, "--no-extensions", "--no-tools"]);
    expect(adapter.buildRunCommand({ ...noTools, autonomy: "low" }))
      .toEqual([...head, "--no-extensions", "--no-tools"]);
    expect(adapter.buildRunCommand({ ...noTools, autonomy: "medium" }))
      .toEqual([...head, "--no-tools"]);
    expect(adapter.buildRunCommand({ ...noTools, autonomy: "high" }))
      .toEqual([...head, "--no-tools"]);
    expect(adapter.buildRunCommand(noTools)).toEqual([...head, "--no-tools"]);
  });

  test("model and effort flags still ride along under --tools none", () => {
    expect(adapter.buildRunCommand({
      ...noTools,
      model: "anthropic/claude-opus-5",
      effort: "high",
    })).toEqual([
      ...head,
      "--model",
      "anthropic/claude-opus-5",
      "--no-tools",
      "--thinking",
      "high",
    ]);
  });

  test("plain runs keep the autonomy allowlists", () => {
    expect(adapter.buildRunCommand({ agent: "pi", prompt: "p" })).toEqual(head);
    expect(adapter.buildRunCommand({ agent: "pi", prompt: "p", autonomy: "read-only" }))
      .toEqual([...head, "--no-extensions", "--tools", "read,grep,find,ls"]);
    expect(adapter.buildRunCommand({
      agent: "pi",
      prompt: "p",
      tools: "default",
      autonomy: "low",
    })).toEqual([...head, "--no-extensions", "--tools", "read,grep,find,ls,edit,write"]);
  });
});
