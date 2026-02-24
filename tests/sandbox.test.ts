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
      "--rw",
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
      "untrusted",
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

  test("mapAutonomyToScodeFsMode maps normalized levels", () => {
    expect(mapAutonomyToScodeFsMode("read-only")).toBe("ro");
    expect(mapAutonomyToScodeFsMode("low")).toBe("rw");
    expect(mapAutonomyToScodeFsMode("medium")).toBe("rw");
    expect(mapAutonomyToScodeFsMode("high")).toBe("rw");
  });

  test("mapAutonomyToScodeTrust maps read-only to untrusted and others to standard", () => {
    expect(mapAutonomyToScodeTrust("read-only")).toBe("untrusted");
    expect(mapAutonomyToScodeTrust("low")).toBe("standard");
    expect(mapAutonomyToScodeTrust("medium")).toBe("standard");
    expect(mapAutonomyToScodeTrust("high")).toBe("standard");
  });

  test("buildSandboxEnv sets ORACLE_CHROME_NO_SANDBOX=1 when unset", () => {
    const previous = process.env.ORACLE_CHROME_NO_SANDBOX;
    const previousPlaywright = process.env.PLAYWRIGHT_MCP_NO_SANDBOX;
    delete process.env.ORACLE_CHROME_NO_SANDBOX;
    delete process.env.PLAYWRIGHT_MCP_NO_SANDBOX;

    const env = buildSandboxEnv({ TEST_FLAG: "ok" });

    if (previous === undefined) {
      delete process.env.ORACLE_CHROME_NO_SANDBOX;
    } else {
      process.env.ORACLE_CHROME_NO_SANDBOX = previous;
    }
    if (previousPlaywright === undefined) {
      delete process.env.PLAYWRIGHT_MCP_NO_SANDBOX;
    } else {
      process.env.PLAYWRIGHT_MCP_NO_SANDBOX = previousPlaywright;
    }

    expect(env.TEST_FLAG).toBe("ok");
    expect(env.ORACLE_CHROME_NO_SANDBOX).toBe("1");
    expect(env.PLAYWRIGHT_MCP_NO_SANDBOX).toBe("1");
  });

  test("buildSandboxEnv preserves pre-set ORACLE_CHROME_NO_SANDBOX", () => {
    const env = buildSandboxEnv({
      ORACLE_CHROME_NO_SANDBOX: "0",
      PLAYWRIGHT_MCP_NO_SANDBOX: "0",
    });
    expect(env.ORACLE_CHROME_NO_SANDBOX).toBe("0");
    expect(env.PLAYWRIGHT_MCP_NO_SANDBOX).toBe("0");
  });

  test("buildSandboxEnv keeps existing env while applying oracle default", () => {
    const env = buildSandboxEnv({ EXISTING: "yes" });
    expect(env.EXISTING).toBe("yes");
    expect(env.ORACLE_CHROME_NO_SANDBOX).toBeDefined();
  });
});
