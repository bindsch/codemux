import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSandboxedWithStdin } from "../src/cli-runtime.js";

describe("CLI runtime keep-env exemptions", () => {
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
});
