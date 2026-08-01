import { describe, test, expect } from "bun:test";
import {
  buildScodeCommand,
  buildSandboxEnv,
  mapAutonomyToScodeFsMode,
  mapAutonomyToScodeTrust,
} from "../src/sandbox.js";

describe("sandbox utilities", () => {
  test("buildScodeCommand builds base command", () => {
    expect(buildScodeCommand(["codex", "exec", "-"])).toEqual([
      "scode",
      "--trust",
      "standard",
      "--ro",
      "--",
      "codex",
      "exec",
      "-",
    ]);
  });

  test("buildScodeCommand adds cwd and read-only fs mode", () => {
    expect(buildScodeCommand(["codex", "exec"], "/tmp/work", "read-only")).toEqual([
      "scode",
      "-C",
      "/tmp/work",
      "--trust",
      "standard",
      "--ro",
      "--",
      "codex",
      "exec",
    ]);
  });

  test("buildScodeCommand uses rw mode for non-read-only autonomy", () => {
    const cmd = buildScodeCommand(["codex", "exec"], "/tmp/work", "high");
    expect(cmd).toEqual([
      "scode",
      "-C",
      "/tmp/work",
      "--trust",
      "standard",
      "--rw",
      "--",
      "codex",
      "exec",
    ]);
    expect(cmd).toContain("--rw");
    expect(cmd).not.toContain("--ro");
  });

  test("buildScodeCommand applies explicit sandbox overrides", () => {
    expect(
      buildScodeCommand(
        ["codex", "exec"],
        "/tmp/work",
        "medium",
        { trust: "trusted", noNet: true, scrubEnv: true }
      )
    ).toEqual([
      "scode",
      "-C",
      "/tmp/work",
      "--trust",
      "trusted",
      "--rw",
      "--no-net",
      "--scrub-env",
      "--",
      "codex",
      "exec",
    ]);
  });

  test("untrusted trust cannot be weakened by non-read-only autonomy", () => {
    const cmd = buildScodeCommand(
      ["codex", "exec"],
      "/tmp/work",
      "high",
      { trust: "untrusted" }
    );
    expect(cmd).toContain("--ro");
    expect(cmd).not.toContain("--rw");
  });

  test("mapAutonomyToScodeFsMode maps normalized levels", () => {
    expect(mapAutonomyToScodeFsMode("read-only")).toBe("ro");
    expect(mapAutonomyToScodeFsMode("low")).toBe("rw");
    expect(mapAutonomyToScodeFsMode("medium")).toBe("rw");
    expect(mapAutonomyToScodeFsMode("high")).toBe("rw");
  });

  test("mapAutonomyToScodeTrust keeps hosted agents network-capable", () => {
    expect(mapAutonomyToScodeTrust("read-only")).toBe("standard");
    expect(mapAutonomyToScodeTrust("low")).toBe("standard");
    expect(mapAutonomyToScodeTrust("medium")).toBe("standard");
    expect(mapAutonomyToScodeTrust("high")).toBe("standard");
  });

  test("buildSandboxEnv does not inject browser sandbox overrides", () => {
    const env = buildSandboxEnv({
      TEST_FLAG: "ok",
      SCODE_CONFIG: "/repo/weakened.yaml",
      scode_trust: "trusted",
    });
    expect(env.TEST_FLAG).toBe("ok");
    expect(env.SCODE_CONFIG).toBeUndefined();
    expect(env.scode_trust).toBeUndefined();
    expect(env.ORACLE_CHROME_NO_SANDBOX).toBeUndefined();
    expect(env.PLAYWRIGHT_MCP_NO_SANDBOX).toBeUndefined();
  });

  test("buildSandboxEnv never inherits the parent implicitly", () => {
    const marker = "CODEMUX_TEST_PARENT_SECRET";
    process.env[marker] = "must-not-leak";
    try {
      expect(buildSandboxEnv()[marker]).toBeUndefined();
    } finally {
      delete process.env[marker];
    }
  });
});
