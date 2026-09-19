import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
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

  test("rejects a relative --sandbox-account path outright", () => {
    expect(() => parseSandboxPolicyOverrides({
      sandbox: true,
      sandboxAccount: "relative/account.jsonl",
    })).toThrow("absolute path");
    expect(() => parseSandboxPolicyOverrides({
      sandbox: false,
      sandboxAccount: "relative/account.jsonl",
    })).toThrow("absolute path");
    // An explicitly empty value is not an absolute path either; the guard
    // tests for undefined, not truthiness, so "" cannot slip through.
    expect(() => parseSandboxPolicyOverrides({
      sandbox: true,
      sandboxAccount: "",
    })).toThrow("absolute path");
  });

  test("rejects account ids outside scode's accepted set", () => {
    // scode drops any id carrying characters outside [A-Za-z0-9._:-] to
    // null; refusing here beats discovering unjoinable records later.
    expect(() => parseSandboxPolicyOverrides({
      sandbox: true,
      sandboxAccount: "/tmp/account.jsonl",
      sandboxAccountId: "crew/job-42",
    })).toThrow("silently break correlation");
    expect(() => parseSandboxPolicyOverrides({
      sandbox: true,
      sandboxAccount: "/tmp/account.jsonl",
      sandboxAccountId: "",
    })).toThrow("1-128 characters");
  });

  test("rejects an account id without a sink", () => {
    expect(() => parseSandboxPolicyOverrides({
      sandbox: true,
      sandboxAccountId: "crew-job-42",
    })).toThrow("without --sandbox-account");
  });

  test("refuses accounting when the capability probe itself fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-runtime-probe-fails-"));
    const binaryDir = join(dir, "bin");
    const workdir = join(dir, "work");
    mkdirSync(binaryDir);
    mkdirSync(workdir);
    const scode = join(binaryDir, "scode");
    // The marker in a failing --help proves nothing; the probe must run
    // cleanly before its output counts.
    writeFileSync(
      scode,
      "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'scode 0.4.0'; exit 0; fi\nif [ \"$1\" = --help ]; then echo 'SCODE_ACCOUNT_FILE'; exit 3; fi\nwhile [ \"$1\" != -- ]; do shift; done\nshift\nexec \"$@\"\n"
    );
    chmodSync(scode, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binaryDir}:${originalPath ?? ""}`;
    try {
      await expect(runSandboxed(
        [process.execPath, "-e", "process.exit(0)"],
        workdir,
        { PATH: process.env.PATH },
        false,
        "read-only",
        { trust: "standard", accountFile: join(workdir, "account.jsonl") }
      )).rejects.toThrow("refusing to guess");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("warns when the sink lives inside the sandbox working directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-runtime-sink-inside-"));
    const binaryDir = join(dir, "bin");
    const workdir = join(dir, "work");
    mkdirSync(binaryDir);
    mkdirSync(workdir);
    const scode = join(binaryDir, "scode");
    // An accounting-capable stub, so the run itself succeeds and only the
    // warning is under test.
    writeFileSync(
      scode,
      "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'scode 0.4.0'; exit 0; fi\nif [ \"$1\" = --help ]; then echo 'Usage: scode [options] command'; echo '  SCODE_ACCOUNT_FILE  per-run scratch accounting sink'; exit 0; fi\nwhile [ \"$1\" != -- ]; do shift; done\nshift\nexec \"$@\"\n"
    );
    chmodSync(scode, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binaryDir}:${originalPath ?? ""}`;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => warnings.push(String(message));
    try {
      expect(await runSandboxed(
        [process.execPath, "-e", "process.exit(0)"],
        workdir,
        { PATH: process.env.PATH },
        false,
        "read-only",
        { trust: "standard", accountFile: join(workdir, "account.jsonl") }
      )).toBe(0);
    } finally {
      console.warn = originalWarn;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
    expect(warnings.join("\n")).toContain("inside the sandbox working directory");
    expect(warnings.join("\n")).toContain("confidentiality, not integrity");
  });

  // Shared accounting-capable scode stub: --version and the accounting
  // --help probe succeed, and the run itself executes the command. The
  // runner captures console.warn so the sink tests can assert on it.
  function accountingStub() {
    const dir = mkdtempSync(join(tmpdir(), "codemux-runtime-sink-"));
    const binaryDir = join(dir, "bin");
    const workdir = join(dir, "work");
    mkdirSync(binaryDir);
    mkdirSync(workdir);
    const scode = join(binaryDir, "scode");
    writeFileSync(
      scode,
      "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'scode 0.4.0'; exit 0; fi\nif [ \"$1\" = --help ]; then echo 'Usage: scode [options] command'; echo '  SCODE_ACCOUNT_FILE  per-run scratch accounting sink'; exit 0; fi\nwhile [ \"$1\" != -- ]; do shift; done\nshift\nexec \"$@\"\n"
    );
    chmodSync(scode, 0o755);
    const originalPath = process.env.PATH;
    const sandboxPath = `${binaryDir}:${originalPath ?? ""}`;
    process.env.PATH = sandboxPath;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => warnings.push(String(message));
    const run = (sink: string) =>
      runSandboxed(
        [process.execPath, "-e", "process.exit(0)"],
        workdir,
        { PATH: sandboxPath },
        false,
        "read-only",
        { trust: "standard", accountFile: sink }
      );
    const restore = () => {
      console.warn = originalWarn;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    };
    return { dir, workdir, warnings, run, restore };
  }

  test("warns for a sink spelled through a symlinked directory with missing parents", async () => {
    // macOS spells /var/folders through a /private symlink, so a purely
    // lexical comparison misses sinks that are physically inside the
    // workdir. The alias link here stands in for it, and the missing
    // results/job-42 levels force the ancestor walk -- scode creates the
    // sink only at exit, so nothing below workdir exists yet.
    const stub = accountingStub();
    symlinkSync(stub.dir, join(stub.dir, "alias"));
    const sink = join(stub.dir, "alias", "work", "results", "job-42", "account.jsonl");
    try {
      expect(await stub.run(sink)).toBe(0);
    } finally {
      stub.restore();
    }
    expect(stub.warnings.join("\n")).toContain("inside the sandbox working directory");
  });

  test("does not warn for a genuinely outside sink spelled through the same alias", async () => {
    const stub = accountingStub();
    symlinkSync(stub.dir, join(stub.dir, "alias"));
    mkdirSync(join(stub.dir, "outside"));
    const sink = join(stub.dir, "alias", "outside", "account.jsonl");
    try {
      expect(await stub.run(sink)).toBe(0);
    } finally {
      stub.restore();
    }
    expect(stub.warnings.join("\n")).not.toContain("inside the sandbox working directory");
  });

  test("warns for a sink that sits in the workdir but symlinks outside", async () => {
    // The lexical path is inside, and that is what counts: the sandboxed
    // command can replace such a symlink with a regular file during the
    // run, which would leave the sink writable from the sandbox.
    const stub = accountingStub();
    const sink = join(stub.workdir, "acct-link.jsonl");
    symlinkSync(join(stub.dir, "elsewhere.jsonl"), sink);
    try {
      expect(await stub.run(sink)).toBe(0);
    } finally {
      stub.restore();
    }
    expect(stub.warnings.join("\n")).toContain("inside the sandbox working directory");
  });

  test("warns for a sink whose name merely begins with dots", async () => {
    // "..acct.jsonl" is a real file inside the workdir, not traversal; only
    // a complete ".." path segment escapes. The old prefix check classified
    // it as outside and skipped the warning.
    const stub = accountingStub();
    try {
      expect(await stub.run(join(stub.workdir, "..acct.jsonl"))).toBe(0);
    } finally {
      stub.restore();
    }
    expect(stub.warnings.join("\n")).toContain("inside the sandbox working directory");
  });

  test("rejects accounting requests when the installed scode lacks the feature", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-runtime-no-accounting-"));
    const binaryDir = join(dir, "bin");
    const workdir = join(dir, "work");
    mkdirSync(binaryDir);
    mkdirSync(workdir);
    const scode = join(binaryDir, "scode");
    writeFileSync(
      scode,
      "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'scode 0.4.0'; exit 0; fi\nif [ \"$1\" = --help ]; then echo 'Usage: scode [options] command'; exit 0; fi\nwhile [ \"$1\" != -- ]; do shift; done\nshift\nexec \"$@\"\n"
    );
    chmodSync(scode, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binaryDir}:${originalPath ?? ""}`;
    try {
      // Without accounting options there is no probe: the stub runs the command.
      expect(await runSandboxed(
        [process.execPath, "-e", "process.exit(0)"],
        workdir,
        { PATH: process.env.PATH },
        false,
        "read-only"
      )).toBe(0);
      await expect(runSandboxed(
        [process.execPath, "-e", "process.exit(0)"],
        workdir,
        { PATH: process.env.PATH },
        false,
        "read-only",
        { trust: "standard", accountFile: join(workdir, "account.jsonl") }
      )).rejects.toThrow("no scratch accounting");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
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
