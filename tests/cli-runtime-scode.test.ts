import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCompatibleScode,
  getScodeCompatibilityStatus,
  isScodeAvailable,
  resolveScodeExecutable,
  resolveScodeExecutableForEnv,
  runSandboxed,
  runSandboxedWithStdin,
  SCODE_MINIMUM_VERSION,
} from "../src/cli-runtime.js";

describe("CLI runtime scode resolution and gating", () => {
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

  test("a scode prerelease of the floor is below the floor (review 341, item 3)", async () => {
    // parseVersion stripped prerelease suffixes, so "0.6.0-rc1" parsed as
    // [0,6,0] and passed a floor set at exactly its numeric core (agy's
    // SCODE_FLOORS entry "0.6.0"). The floor comparison runs on the
    // extracted token — suffix included — under the rule harness versions
    // already follow: a prerelease orders below its own release.
    const dir = mkdtempSync(join(tmpdir(), "codemux-runtime-rc-scode-"));
    const binaryDir = join(dir, "bin");
    const workdir = join(dir, "work");
    mkdirSync(binaryDir);
    mkdirSync(workdir);
    const writeScode = (version: string): string => {
      const path = join(binaryDir, `scode-${version}`);
      writeFileSync(
        path,
        `#!/bin/sh\nif [ "$1" = --version ]; then echo 'scode ${version}'; exit 0; fi\nexit 99\n`
      );
      chmodSync(path, 0o755);
      return path;
    };
    const env = { PATH: `${binaryDir}:${process.env.PATH ?? ""}` };
    try {
      await expect(
        assertCompatibleScode(writeScode("0.6.0-rc1"), workdir, env, "0.6.0")
      ).rejects.toThrow("scode 0.6.0-rc1 is too old; 0.6.0 or newer is required");
      // Controls: the release itself passes its own floor, and a
      // prerelease above the floor passes — only a prerelease of the
      // minimum is below the minimum.
      await expect(
        assertCompatibleScode(writeScode("0.6.0"), workdir, env, "0.6.0")
      ).resolves.toBe("0.6.0");
      await expect(
        assertCompatibleScode(writeScode("0.7.0-beta"), workdir, env, "0.6.0")
      ).resolves.toBe("0.7.0-beta");
      // A glued suffix is no version at all: the token's closing boundary
      // refuses it instead of reading its numeric core (review round 344).
      await expect(
        assertCompatibleScode(writeScode("1.2.3dev"), workdir, env, "0.6.0")
      ).rejects.toThrow("could not parse scode version");
    } finally {
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
