import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
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
  resolveScodeExecutable,
  resolveScodeExecutableForEnv,
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

  // Shared stub for the --keep-env capability tests: --version passes the
  // compatibility gate, --help answers whatever the installed scode would
  // (the flag documented or not), and the command itself executes with the
  // scode argv recorded, so the tests can prove what the sandbox saw.
  function keepEnvStub(
    help: string
  ): { path: string; envPath: string; workdir: string; argvFile: string } {
    const dir = mkdtempSync(join(tmpdir(), "codemux-keepenv-"));
    const binaryDir = join(dir, "bin");
    const workdir = join(dir, "work");
    mkdirSync(binaryDir, { recursive: true });
    mkdirSync(workdir, { recursive: true });
    const argvFile = join(dir, "scode-argv.txt");
    const scode = join(binaryDir, "scode");
    writeFileSync(
      scode,
      `#!/bin/sh\nif [ "$1" = --version ]; then echo 'scode 0.2.0'; exit 0; fi\nif [ "$1" = --help ]; then ${help}; fi\nprintf '%s\\n' "$@" > '${argvFile}'\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`
    );
    chmodSync(scode, 0o755);
    return {
      path: binaryDir,
      envPath: `${binaryDir}:${process.env.PATH ?? ""}`,
      workdir,
      argvFile,
    };
  }

  async function withKeepEnvStub<T>(
    help: string,
    fn: (stub: {
      path: string;
      envPath: string;
      workdir: string;
      argvFile: string;
    }) => Promise<T>
  ): Promise<T> {
    const stub = keepEnvStub(help);
    const originalPath = process.env.PATH;
    process.env.PATH = `${stub.path}:${originalPath ?? ""}`;
    try {
      return await fn(stub);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(join(stub.path, ".."), { recursive: true, force: true });
    }
  }

  test("a required --keep-env exemption renders on a scode that documents it", async () => {
    await withKeepEnvStub(
      "echo 'Usage: scode [options] command'; echo '  --keep-env NAME[,NAME...]  keep named variables under --scrub-env'; exit 0",
      async (stub) => {
        const result = await runSandboxedWithStdin(
          [process.execPath, "-e", "process.stdout.write('ok')"],
          null,
          stub.workdir,
          { PATH: stub.envPath },
          "read-only",
          {
            trust: "standard",
            scrubEnv: true,
            keepEnv: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
            keepEnvRequired: true,
          },
          2_000
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("ok");
        const argv = readFileSync(stub.argvFile, "utf8").split("\n");
        expect(argv).toContain("--scrub-env");
        expect(argv).toContain("--keep-env");
        expect(argv).toContain("ANTHROPIC_AUTH_TOKEN,ANTHROPIC_BASE_URL");
      }
    );
  });

  test("a required exemption refuses on a scode without the flag, before any spawn", async () => {
    await withKeepEnvStub(
      "echo 'Usage: scode [options] command'; exit 0",
      async (stub) => {
        await expect(runSandboxedWithStdin(
          [process.execPath, "-e", "process.exit(0)"],
          null,
          stub.workdir,
          { PATH: stub.envPath },
          "read-only",
          {
            trust: "standard",
            scrubEnv: true,
            keepEnv: ["ANTHROPIC_AUTH_TOKEN"],
            keepEnvRequired: true,
          },
          2_000
        )).rejects.toThrow("has no --keep-env");
        // The probe is the only scode run, and it never reached the
        // command: the run was refused, not executed stripped.
        expect(existsSync(stub.argvFile)).toBe(false);
      }
    );
  });

  test("a required exemption refuses when the probe itself fails", async () => {
    await withKeepEnvStub(
      "echo '--keep-env'; exit 3",
      async (stub) => {
        await expect(runSandboxedWithStdin(
          [process.execPath, "-e", "process.exit(0)"],
          null,
          stub.workdir,
          { PATH: stub.envPath },
          "read-only",
          {
            trust: "standard",
            scrubEnv: true,
            keepEnv: ["ANTHROPIC_AUTH_TOKEN"],
            keepEnvRequired: true,
          },
          2_000
        )).rejects.toThrow("refusing to guess");
      }
    );
  });

  test("a transient probe failure is not cached — the next launch probes again (al3)", async () => {
    // The probe's --help fails once (the shape of a timeout or a signal
    // under load) and answers properly from the second run on. The first
    // launch refuses on the doubt, exactly as before; caching that
    // "unprobeable" would have refused every later override launch for
    // the rest of the process, so only a definite answer is cached and
    // the second launch probes again — this time the exemption renders.
    const dir = mkdtempSync(join(tmpdir(), "codemux-keepenv-retry-"));
    const binaryDir = join(dir, "bin");
    const workdir = join(dir, "work");
    mkdirSync(binaryDir, { recursive: true });
    mkdirSync(workdir);
    const argvFile = join(dir, "scode-argv.txt");
    const countFile = join(dir, "help-count");
    const scode = join(binaryDir, "scode");
    writeFileSync(
      scode,
      `#!/bin/sh\nif [ "$1" = --version ]; then echo 'scode 0.2.0'; exit 0; fi\nif [ "$1" = --help ]; then n=$(cat '${countFile}' 2>/dev/null || echo 0); n=$((n+1)); printf '%s' "$n" > '${countFile}'; if [ "$n" -ge 2 ]; then echo 'Usage: scode [options] command'; echo '  --keep-env NAME[,NAME...]  keep named variables under --scrub-env'; exit 0; fi; exit 3; fi\nprintf '%s\\n' "$@" > '${argvFile}'\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`
    );
    chmodSync(scode, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binaryDir}:${originalPath ?? ""}`;
    try {
      const options = {
        trust: "standard" as const,
        scrubEnv: true,
        keepEnv: ["ANTHROPIC_AUTH_TOKEN"],
        keepEnvRequired: true,
      };
      await expect(runSandboxedWithStdin(
        [process.execPath, "-e", "process.exit(0)"],
        null,
        workdir,
        { PATH: process.env.PATH },
        "read-only",
        options,
        2_000
      )).rejects.toThrow("refusing to guess");
      const result = await runSandboxedWithStdin(
        [process.execPath, "-e", "process.stdout.write('ok')"],
        null,
        workdir,
        { PATH: process.env.PATH },
        "read-only",
        options,
        2_000
      );
      expect(result.exitCode).toBe(0);
      const argv = readFileSync(argvFile, "utf8").split("\n");
      expect(argv).toContain("--keep-env");
      expect(argv).toContain("ANTHROPIC_AUTH_TOKEN");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the keep-env cache keys on the probe's PATH and working directory, so one environment cannot poison another (al24)", async () => {
    // The edges minor: the cache was keyed on the resolved executable
    // path alone, but the probe runs with the caller's environment and
    // working directory — an environment-sensitive wrapper at one path
    // can answer --help differently per lookup. The stub below documents
    // --keep-env unless its view (PATH or working directory) carries the
    // marker, and every launch resolves the SAME stub path; a cache keyed
    // on the path alone let the first launch's answer decide the later
    // ones. The key now names the PATH the probe ran with and the
    // directory it ran in.
    const dir = mkdtempSync(join(tmpdir(), "codemux-keepenv-key-"));
    const bin = join(dir, "bin");
    const workdirOn = join(dir, "work-on");
    const workdirOff = join(dir, "work-keepenv-off");
    mkdirSync(bin, { recursive: true });
    mkdirSync(workdirOn);
    mkdirSync(workdirOff);
    const argvFile = join(dir, "scode-argv.txt");
    const scode = join(bin, "scode");
    writeFileSync(
      scode,
      `#!/bin/sh\nif [ "$1" = --version ]; then echo 'scode 0.2.0'; exit 0; fi\nif [ "$1" = --help ]; then\n  case "$PATH:$(pwd)" in\n    *keepenv-off*) echo 'Usage: scode [options] command'; exit 0;;\n    *) echo 'Usage: scode [options] command'; echo '  --keep-env NAME[,NAME...]  keep named variables under --scrub-env'; exit 0;;\n  esac\nfi\nprintf '%s\\n' "$@" > '${argvFile}'\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`
    );
    chmodSync(scode, 0o755);
    const pathOn = bin;
    const pathOff = `${bin}:${join(dir, "keepenv-off")}`;
    const options = {
      trust: "standard" as const,
      scrubEnv: true,
      keepEnv: ["ANTHROPIC_AUTH_TOKEN"],
      keepEnvRequired: true,
    };
    try {
      // First launch, supporting environment: the exemption renders, and
      // its answer is cached under THIS environment's key.
      const rendered = await runSandboxedWithStdin(
        [process.execPath, "-e", "process.stdout.write('ok')"],
        null,
        workdirOn,
        { PATH: pathOn },
        "read-only",
        options,
        2_000
      );
      expect(rendered.exitCode).toBe(0);
      expect(readFileSync(argvFile, "utf8").split("\n")).toContain("--keep-env");

      // Same executable path, a PATH that resolves it just the same but
      // makes the wrapper answer without the flag: the stale answer must
      // not serve here — the probe runs again under this environment.
      await expect(runSandboxedWithStdin(
        [process.execPath, "-e", "process.exit(0)"],
        null,
        workdirOn,
        { PATH: pathOff },
        "read-only",
        options,
        2_000
      )).rejects.toThrow("has no --keep-env");

      // Same PATH as the first launch, a working directory the wrapper
      // answers differently for: the directory keys the probe too.
      await expect(runSandboxedWithStdin(
        [process.execPath, "-e", "process.exit(0)"],
        null,
        workdirOff,
        { PATH: pathOn },
        "read-only",
        options,
        2_000
      )).rejects.toThrow("has no --keep-env");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the keep-env cache keys on the whole probe environment, so a wrapper dispatching on an ignored variable cannot poison another answer (al25)", async () => {
    // The edges major: the al24 key named the probe's PATH and working
    // directory, but the probe runs with the ENTIRE launch environment —
    // buildSandboxEnv of extraEnv — and a wrapper can dispatch its --help
    // answer on any variable it sees. Same resolved executable, same PATH,
    // same directory: only CODEMUX_PROBE_VIEW differs, a variable the
    // al24 key ignored. A PATH-keyed cache let the first environment's
    // "supported" decide the second's launch — rendering --keep-env to a
    // scode that never documented it. The key is a digest of the whole
    // probe environment now, so the second launch re-probes under its
    // own environment and refuses.
    const dir = mkdtempSync(join(tmpdir(), "codemux-keepenv-envkey-"));
    const bin = join(dir, "bin");
    const workdir = join(dir, "work");
    mkdirSync(bin, { recursive: true });
    mkdirSync(workdir);
    const argvFile = join(dir, "scode-argv.txt");
    const scode = join(bin, "scode");
    writeFileSync(
      scode,
      `#!/bin/sh\nif [ "$1" = --version ]; then echo 'scode 0.2.0'; exit 0; fi\nif [ "$1" = --help ]; then\n  if [ "$CODEMUX_PROBE_VIEW" = "off" ]; then echo 'Usage: scode [options] command'; exit 0; fi\n  echo 'Usage: scode [options] command'; echo '  --keep-env NAME[,NAME...]  keep named variables under --scrub-env'; exit 0\nfi\nprintf '%s\\n' "$@" > '${argvFile}'\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`
    );
    chmodSync(scode, 0o755);
    const options = {
      trust: "standard" as const,
      scrubEnv: true,
      keepEnv: ["ANTHROPIC_AUTH_TOKEN"],
      keepEnvRequired: true,
    };
    try {
      // First launch, the supporting environment: the exemption renders,
      // and its answer is cached under THIS environment's digest.
      const rendered = await runSandboxedWithStdin(
        [process.execPath, "-e", "process.stdout.write('ok')"],
        null,
        workdir,
        { PATH: bin },
        "read-only",
        options,
        2_000
      );
      expect(rendered.exitCode).toBe(0);
      expect(readFileSync(argvFile, "utf8").split("\n")).toContain("--keep-env");

      // Same executable, same PATH, same directory — one variable the
      // probe also runs with changed its value, and the wrapper answers
      // without the flag under it: the stale answer must not serve here.
      await expect(runSandboxedWithStdin(
        [process.execPath, "-e", "process.exit(0)"],
        null,
        workdir,
        { PATH: bin, CODEMUX_PROBE_VIEW: "off" },
        "read-only",
        options,
        2_000
      )).rejects.toThrow("has no --keep-env");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the run resolves scode through the launch environment's PATH, never the ambient one (al14)", async () => {
    // The blocker's run-side seam: the runner, the session spawn, and the
    // session start preflight must decide on the ONE scode the launch
    // will use, resolved through the launch environment's PATH. Before
    // al14 every spawn site read the ambient process.env.PATH, so a
    // scode reachable only through the launch environment answered "scode
    // is not installed" while the trusted-command resolution beside it,
    // which always read extraEnv.PATH, would have found the command: two
    // lookups, one launch, disagreement.
    const dir = mkdtempSync(join(tmpdir(), "codemux-scode-envpath-"));
    const binaryDir = join(dir, "bin");
    const workdir = join(dir, "work");
    mkdirSync(binaryDir, { recursive: true });
    mkdirSync(workdir);
    const argvFile = join(dir, "scode-argv.txt");
    const scode = join(binaryDir, "scode");
    writeFileSync(
      scode,
      `#!/bin/sh\nif [ "$1" = --version ]; then echo 'scode 0.2.0'; exit 0; fi\nprintf '%s\\n' "$@" > '${argvFile}'\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`
    );
    chmodSync(scode, 0o755);
    const originalPath = process.env.PATH;
    // The ambient PATH stripped to the system directories, which hold no
    // scode; the launch environment below carries binaryDir, so the two
    // lookups disagree unless the runner reads the launch one.
    process.env.PATH = "/usr/bin:/bin";
    try {
      // The ambient resolver alone finds nothing — the launch
      // environment's view is the one that can.
      expect(resolveScodeExecutable(workdir)).toBeNull();
      // The resolver canonicalizes (macOS tmp dirs live under a /private
      // symlink), so compare real paths.
      expect(realpathSync(resolveScodeExecutableForEnv({ PATH: `${binaryDir}:/usr/bin:/bin` }, workdir) as string)).toBe(
        realpathSync(scode)
      );
      const result = await runSandboxedWithStdin(
        ["/bin/echo", "resolved"],
        null,
        workdir,
        { PATH: `${binaryDir}:/usr/bin:/bin`, HOME: dir },
        "read-only",
        { trust: "standard" },
        5_000
      );
      // The launch ran the fake scode (its argv record) and the command
      // it shifted to (the output), where the old ambient lookup threw
      // "scode is not installed" before anything spawned.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("resolved\n");
      expect(readFileSync(argvFile, "utf8")).toContain("resolved");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-required exemption is dropped, not rendered, on a scode without the flag", async () => {
    await withKeepEnvStub(
      "echo 'Usage: scode [options] command'; exit 0",
      async (stub) => {
        const result = await runSandboxedWithStdin(
          [process.execPath, "-e", "process.stdout.write('ok')"],
          null,
          stub.workdir,
          { PATH: stub.envPath },
          "read-only",
          {
            trust: "standard",
            scrubEnv: true,
            keepEnv: ["GOOSE_MODE"],
          },
          2_000
        );
        expect(result.exitCode).toBe(0);
        // The scrub stays; the exemption a scode without the flag would
        // reject as unknown is gone, so the run keeps its pre-0.6.0
        // behavior exactly.
        const argv = readFileSync(stub.argvFile, "utf8").split("\n");
        expect(argv).toContain("--scrub-env");
        expect(argv).not.toContain("--keep-env");
      }
    );
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
