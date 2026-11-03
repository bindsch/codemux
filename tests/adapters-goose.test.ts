import { describe, test, expect } from "bun:test";
import { GooseAdapter } from "../src/adapters/goose.js";
import type { RunRequest } from "../src/types.js";

describe("GooseAdapter", () => {
  const adapter = new GooseAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("goose");
    expect(adapter.binaryName).toBe("goose");
  });

  test("capabilities are correct", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsInteractive).toBe(true);
    expect(caps.supportsModel).toBe(true);
    expect(caps.supportsAutonomy).toBe(true);
    expect(caps.autonomyLevels).toEqual(["read-only", "low", "medium", "high"]);
    expect(caps.supportsEffort).toBe(false);
    expect(caps.effortLevels).toEqual([]);
  });

  test("buildRunCommand", () => {
    const request: RunRequest = { agent: "goose", prompt: "test prompt" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["goose", "run", "-t", "test prompt"]);
  });

  test("buildRunCommand with autonomy", () => {
    expect(adapter.buildRunCommand({ agent: "goose", prompt: "t", autonomy: "read-only" }))
      .toEqual(["goose", "run", "-t", "t"]);
    expect(adapter.buildRunCommand({ agent: "goose", prompt: "t", autonomy: "low" }))
      .toEqual(["goose", "run", "-t", "t"]);
    expect(adapter.buildRunCommand({ agent: "goose", prompt: "t", autonomy: "medium" }))
      .toEqual(["goose", "run", "-t", "t"]);
    expect(adapter.buildRunCommand({ agent: "goose", prompt: "t", autonomy: "high" }))
      .toEqual(["goose", "run", "-t", "t"]);
  });

  test("buildTuiCommand", () => {
    expect(adapter.buildTuiCommand()).toEqual(["goose"]);
    expect(adapter.buildTuiCommand(undefined, "high")).toEqual(["goose"]);
  });

  test("getRunEnv and getTuiEnv set goose mode from autonomy", () => {
    expect(adapter.getRunEnv({ agent: "goose", prompt: "t" })).toEqual({ GOOSE_MODE: "chat" });
    expect(adapter.getRunEnv({ agent: "goose", prompt: "t", autonomy: "medium" }))
      .toEqual({ GOOSE_MODE: "smart_approve" });
    expect(adapter.getTuiEnv(undefined, undefined)).toEqual({ GOOSE_MODE: "chat" });
    expect(adapter.getTuiEnv(undefined, "high")).toEqual({ GOOSE_MODE: "auto" });
    expect(adapter.getRunEnv({ agent: "goose", prompt: "t", model: "provider/model" }))
      .toEqual({ GOOSE_MODE: "chat", GOOSE_MODEL: "provider/model" });
  });

  test("mapAutonomy returns goose mode env", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual([]);
    expect(adapter.mapAutonomy("low")).toEqual([]);
    expect(adapter.mapAutonomy("medium")).toEqual([]);
    expect(adapter.mapAutonomy("high")).toEqual([]);
  });
});
