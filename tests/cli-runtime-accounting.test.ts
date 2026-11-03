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
import { runSandboxed } from "../src/cli-runtime.js";

describe("CLI runtime sandbox accounting sinks", () => {
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
});
