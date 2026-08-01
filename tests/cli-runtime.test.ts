import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isScodeAvailable,
  getScodeCompatibilityStatus,
  SCODE_MINIMUM_VERSION,
  parseAutonomyOption,
  parseEffortOption,
  parsePassthroughEnvOption,
  parseSandboxPolicyOverrides,
  parseTimeoutOption,
  resolveAutonomyForAdapter,
  resolveEffortForAdapter,
  runSandboxed,
  runSandboxedWithStdin,
} from "../src/cli-runtime.js";
import type { AdapterCapabilities } from "../src/types.js";

const fullCapabilities: AdapterCapabilities = {
  supportsNonInteractive: true,
  supportsInteractive: true,
  supportsModel: true,
  supportsAutonomy: true,
  autonomyLevels: ["read-only", "low", "medium", "high"],
  supportsEffort: true,
  effortLevels: ["none", "low", "medium", "high"],
};

describe("CLI runtime helpers", () => {
  test("parses valid normalized options and explicit environment grants", () => {
    expect(parseAutonomyOption(undefined)).toBeUndefined();
    expect(parseAutonomyOption("low")).toBe("low");
    expect(parseEffortOption(undefined)).toBeUndefined();
    expect(parseEffortOption("none")).toBe("none");
    expect(parsePassthroughEnvOption()).toEqual([]);
    expect(parsePassthroughEnvOption("TOKEN_A, TOKEN_B,TOKEN_A"))
      .toEqual(["TOKEN_A", "TOKEN_B"]);
    expect(() => parsePassthroughEnvOption("NOT-VALID"))
      .toThrow("invalid environment variable name");
    expect(() => parsePassthroughEnvOption(""))
      .toThrow("--pass-env requires 1 to");
    expect(() => parsePassthroughEnvOption(
      Array.from({ length: 65 }, (_, index) => `TOKEN_${index}`).join(",")
    )).toThrow("--pass-env requires 1 to 64");
    expect(parseTimeoutOption("0.001")).toBe(1);
    expect(parseTimeoutOption("60")).toBe(60_000);
    expect(() => parseTimeoutOption("0")).toThrow("--timeout must be a number");
    expect(() => parseTimeoutOption("Infinity")).toThrow(
      "--timeout must be a number"
    );
    for (const value of ["-1", "not-a-number", "86400.1"]) {
      expect(() => parseTimeoutOption(value)).toThrow(
        "--timeout must be a number"
      );
    }
  });

  test("resolves supported levels and fails closed for unsupported semantics", () => {
    expect(resolveAutonomyForAdapter("claude", fullCapabilities, "medium"))
      .toBe("medium");
    expect(resolveEffortForAdapter("claude", fullCapabilities, "high"))
      .toBe("high");
    expect(resolveEffortForAdapter("gemini", {
      ...fullCapabilities,
      supportsEffort: false,
      effortLevels: [],
    }, "none")).toBeUndefined();
    expect(() => resolveEffortForAdapter("gemini", {
      ...fullCapabilities,
      supportsEffort: false,
      effortLevels: [],
    }, "high")).toThrow("does not support reasoning effort");
    expect(() => resolveAutonomyForAdapter("claude", {
      ...fullCapabilities,
      supportsAutonomy: false,
      autonomyLevels: [],
    }, "read-only")).toThrow("cannot enforce requested autonomy");
    expect(() => resolveAutonomyForAdapter("claude", {
      ...fullCapabilities,
      autonomyLevels: ["high"],
    }, "read-only")).toThrow("does not support autonomy level");
  });

  test("parses sandbox policy and reports flags without sandbox", () => {
    expect(parseSandboxPolicyOverrides({
      sandbox: true,
      sandboxTrust: "trusted",
      sandboxNoNet: true,
    })).toEqual({
      trust: "trusted",
      noNet: true,
      scrubEnv: false,
    });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => warnings.push(String(message));
    try {
      expect(parseSandboxPolicyOverrides({
        sandbox: false,
        sandboxNoNet: true,
      })).toBeUndefined();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.join("\n")).toContain("require --sandbox");
  });

  test("executes sandboxed captured and inherited-stdio commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-runtime-"));
    const binaryDir = join(dir, "bin");
    const workdir = join(dir, "work");
    mkdirSync(binaryDir);
    mkdirSync(workdir);
    const scode = join(binaryDir, "scode");
    writeFileSync(scode, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'scode 0.2.0'; exit 0; fi\nwhile [ \"$1\" != -- ]; do shift; done\nshift\nexec \"$@\"\n");
    chmodSync(scode, 0o755);
    const path = `${binaryDir}:${process.env.PATH ?? ""}`;
    const originalPath = process.env.PATH;
    process.env.PATH = path;
    try {
      expect(isScodeAvailable()).toBe(true);
      const captured = await runSandboxedWithStdin(
        [process.execPath, "-e", "process.stdout.write(await Bun.stdin.text())"],
        "payload",
        workdir,
        { PATH: path },
        "read-only",
        { trust: "standard" },
        2_000
      );
      expect(captured.exitCode).toBe(0);
      expect(captured.stdout).toBe("payload");

      expect(await runSandboxed(
        [process.execPath, "-e", "process.exit(0)"],
        workdir,
        { PATH: path },
        false,
        "read-only"
      )).toBe(0);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects outdated scode before sandbox execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-runtime-old-scode-"));
    const binaryDir = join(dir, "bin");
    const workdir = join(dir, "work");
    mkdirSync(binaryDir);
    mkdirSync(workdir);
    const scode = join(binaryDir, "scode");
    writeFileSync(
      scode,
      "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'scode 0.1.0'; exit 0; fi\nexit 99\n"
    );
    chmodSync(scode, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binaryDir}:${originalPath ?? ""}`;
    try {
      expect(SCODE_MINIMUM_VERSION).toBe("0.2.0");
      expect(await getScodeCompatibilityStatus(workdir)).toEqual({
        available: true,
        issue: "scode 0.1.0 is too old; 0.2.0 or newer is required",
      });
      await expect(runSandboxed(
        [process.execPath, "-e", "process.exit(0)"],
        workdir,
        { PATH: process.env.PATH },
        false,
        "read-only"
      )).rejects.toThrow("scode 0.1.0 is too old");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects repository-local scode executables and project policy files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-runtime-untrusted-"));
    const scode = join(dir, "scode");
    writeFileSync(scode, "#!/bin/sh\nexit 0\n");
    chmodSync(scode, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    try {
      const scodeStatus = await getScodeCompatibilityStatus(dir);
      expect(scodeStatus.available).toBe(true);
      expect(scodeStatus.issue).toContain("inside the execution working directory");
      await expect(runSandboxed(
        [process.execPath, "-e", "process.exit(0)"],
        dir,
        { PATH: process.env.PATH },
        false,
        "read-only"
      )).rejects.toThrow("inside the execution working directory");

      const workdir = join(dir, "work");
      mkdirSync(workdir);
      writeFileSync(join(workdir, ".scode.yaml"), "allowed:\n  - /tmp\n");
      await expect(runSandboxed(
        [process.execPath, "-e", "process.exit(0)"],
        workdir,
        { PATH: process.env.PATH },
        false,
        "read-only"
      )).rejects.toThrow(".scode.yaml");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
