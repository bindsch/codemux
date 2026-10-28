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
import { probeEnvironment } from "../src/environment.js";
import { assertHarnessSupported } from "../src/cli-runtime.js";
import {
  ALLOW_UNTESTED_ENV,
  assertSupportedHarnessVersion,
  HARNESS_CONTRACTS,
  probeHarnessVersion,
} from "../src/harness-compatibility.js";
import "./harness-compatibility-verdicts.js";
import "./harness-compatibility-policy.js";


describe("the gate itself", () => {
  const fakeHarness = (
    versionOutput: string,
    beforeVersion = ""
  ): { path: string; cleanup: () => void } => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-harness-"));
    const path = join(dir, "opencode");
    writeFileSync(path, `#!/bin/sh\n${beforeVersion}\nprintf '%s\\n' '${versionOutput}'\n`);
    chmodSync(path, 0o755);
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };

  const captureWarnings = async (run: () => Promise<unknown>): Promise<string[]> => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
    try {
      await run();
    } finally {
      console.warn = original;
    }
    return warnings;
  };

  test("an audited version passes without warning", async () => {
    const fake = fakeHarness("1.18.11");
    try {
      const warnings = await captureWarnings(() =>
        assertSupportedHarnessVersion({
          agent: "opencode", binary: fake.path, binaryName: "opencode", workdir: "/tmp",
          probeEnvironment: probeEnvironment({}), override: false, autonomy: "low",
        })
      );
      expect(warnings).toEqual([]);
    } finally {
      fake.cleanup();
    }
  });

  test.each(["0.31.1", "2.3.2"])(
    "returns an unknown version when the binary replaces itself while reporting %s",
    async (reportedVersion) => {
      const fake = fakeHarness(
        reportedVersion,
        '/bin/cp "$0" "$0.new"\n/bin/mv "$0.new" "$0"'
      );
      try {
        const warnings = await captureWarnings(async () => {
          const version = await assertSupportedHarnessVersion({
            agent: "kimi", binary: fake.path, binaryName: "kimi", workdir: "/tmp",
            probeEnvironment: probeEnvironment({}), override: false, autonomy: "high",
          });
          expect(version).toBeNull();
        });
        expect(warnings.join("\n")).toContain("binary changed");
      } finally {
        fake.cleanup();
      }
    }
  );

  // These three pass the repository as the working directory: the redirect
  // fake lives under the OS temp root, which on Linux is /tmp itself, and a
  // working directory that is its ancestor makes the trust check refuse the
  // fake for the wrong reason.
  test("an active redirect warns and still refuses a below-floor binary", async () => {
    // The fallback half of the redirect rule: the value names no binary
    // codemux can validate (/opt/oc/1.0.0 does not exist), so the verdict
    // cannot be read from it. Say the version is unconfirmed and keep gating
    // the PATH-resolved binary -- here below the floor, so the run refuses
    // unless the operator overrides. The resolved half is the next two
    // tests: there the redirect itself answers the gate.
    const fake = fakeHarness("1.0.0");
    const env = {
      PATH: join(fake.path, ".."),
      OPENCODE_BIN_PATH: "/opt/oc/1.0.0",
    };
    const call = () =>
      assertHarnessSupported(
        "opencode", "opencode", process.cwd(), env, "low", false, ["OPENCODE_BIN_PATH"]
      );
    // The documented override may already be on in the caller's
    // environment; this test needs it off for its refusal half, and it must
    // not strip the caller's value on the way out (round10: running the
    // suite with the override exported failed here once and deleted it).
    const savedOverride = process.env[ALLOW_UNTESTED_ENV];
    delete process.env[ALLOW_UNTESTED_ENV];
    try {
      const warnings = await captureWarnings(async () => {
        await expect(call()).rejects.toThrow("older than");
      });
      expect(warnings.join("\n")).toContain("cannot confirm the version");
      process.env[ALLOW_UNTESTED_ENV] = "1";
      try {
        const overridden = await captureWarnings(call);
        expect(overridden.join("\n")).toContain(ALLOW_UNTESTED_ENV);
      } finally {
        if (savedOverride === undefined) {
          delete process.env[ALLOW_UNTESTED_ENV];
        } else {
          process.env[ALLOW_UNTESTED_ENV] = savedOverride;
        }
      }
    } finally {
      fake.cleanup();
    }
  });

  test("a redirect codemux can resolve answers the gate, not the PATH binary", async () => {
    // The finding: with OPENCODE_BIN_PATH passed through, the verdict still
    // came from the unrelated PATH-resolved executable, so a supported PATH
    // binary approved a redirected binary below the floor without the
    // compatibility override. The gate resolves the redirect to a trusted
    // executable -- the same validation the PATH binary gets, which is what
    // makes probing it outside the sandbox acceptable -- and reads the
    // verdict from THAT binary, so a below-floor redirect refuses here even
    // though the launcher on PATH is supported.
    const pathFake = fakeHarness("1.18.11");
    const redirectFake = fakeHarness("1.0.0");
    const env = {
      PATH: join(pathFake.path, ".."),
      OPENCODE_BIN_PATH: redirectFake.path,
    };
    const call = () =>
      assertHarnessSupported(
        "opencode", "opencode", process.cwd(), env, "low", false, ["OPENCODE_BIN_PATH"]
      );
    const savedOverride = process.env[ALLOW_UNTESTED_ENV];
    delete process.env[ALLOW_UNTESTED_ENV];
    try {
      const warnings = await captureWarnings(async () => {
        await expect(call()).rejects.toThrow("older than");
      });
      // The redirect answered, so there is nothing to disclaim: the probe
      // measured the binary the launch runs.
      expect(warnings.join("\n")).not.toContain("cannot confirm the version");
      process.env[ALLOW_UNTESTED_ENV] = "1";
      try {
        const overridden = await captureWarnings(call);
        expect(overridden.join("\n")).toContain(ALLOW_UNTESTED_ENV);
      } finally {
        if (savedOverride === undefined) {
          delete process.env[ALLOW_UNTESTED_ENV];
        } else {
          process.env[ALLOW_UNTESTED_ENV] = savedOverride;
        }
      }
    } finally {
      pathFake.cleanup();
      redirectFake.cleanup();
    }
  });

  test("a supported redirect runs behind an old PATH binary, with no warning", async () => {
    // The converse the finding named: an old PATH binary used to block a
    // supported redirect. The verdict comes from the redirect (1.18.11,
    // inside the audited band at this autonomy), the PATH launcher's 1.0.0
    // never runs and is not measured, and nothing is warned -- the run is
    // as confirmed as any other in the band.
    const pathFake = fakeHarness("1.0.0");
    const redirectFake = fakeHarness("1.18.11");
    const env = {
      PATH: join(pathFake.path, ".."),
      OPENCODE_BIN_PATH: redirectFake.path,
    };
    try {
      const warnings = await captureWarnings(() =>
        assertHarnessSupported(
          "opencode", "opencode", process.cwd(), env, "low", false, ["OPENCODE_BIN_PATH"]
        )
      );
      expect(warnings).toEqual([]);
    } finally {
      pathFake.cleanup();
      redirectFake.cleanup();
    }
  });

  test("a newer version warns but still runs", async () => {
    // Above maxAudited (1.18.18), and at `high` so the recorded break does not
    // apply: the only thing left to report is that it is unaudited.
    const fake = fakeHarness("1.18.19");
    try {
      const warnings = await captureWarnings(() =>
        assertSupportedHarnessVersion({
          agent: "opencode", binary: fake.path, binaryName: "opencode", workdir: "/tmp",
          probeEnvironment: probeEnvironment({}), override: false, autonomy: "high",
        })
      );
      expect(warnings.join("\n")).toContain("newer than");
    } finally {
      fake.cleanup();
    }
  });

  test("a known break refuses", async () => {
    const fake = fakeHarness("1.18.18");
    try {
      await expect(
        assertSupportedHarnessVersion({
          agent: "opencode", binary: fake.path, binaryName: "opencode", workdir: "/tmp",
          probeEnvironment: probeEnvironment({}), override: false, autonomy: "low",
        })
      ).rejects.toThrow("cannot enforce low and medium autonomy");
    } finally {
      fake.cleanup();
    }
  });

  test("the override downgrades a refusal to a warning", async () => {
    const fake = fakeHarness("1.18.18");
    try {
      const warnings = await captureWarnings(() =>
        assertSupportedHarnessVersion({
          agent: "opencode",
          binary: fake.path,
          binaryName: "opencode",
          workdir: "/tmp",
          probeEnvironment: probeEnvironment({}),
          override: true,
          autonomy: "low",
        })
      );
      expect(warnings.join("\n")).toContain(ALLOW_UNTESTED_ENV);
    } finally {
      fake.cleanup();
    }
  });

  test("an unreadable version warns rather than blocking a wrapper script", async () => {
    const fake = fakeHarness("not a version");
    try {
      const warnings = await captureWarnings(() =>
        assertSupportedHarnessVersion({
          agent: "opencode", binary: fake.path, binaryName: "opencode", workdir: "/tmp",
          probeEnvironment: probeEnvironment({}), override: false, autonomy: "high",
        })
      );
      expect(warnings.join("\n")).toContain("could not determine");
    } finally {
      fake.cleanup();
    }
  });

  test("copilot refuses a version it cannot read; only the override downgrades it", async () => {
    // The finding: copilot 1.0.0 through 1.0.2 predate `--binary-version`,
    // so the probe reads nothing from them -- and a null version took the
    // unconditional warn-and-continue path, letting releases below the
    // declared 1.0.77 floor run without the documented override. The
    // contract pins null to mean below-floor now (unknownVersion), the tier
    // table's below-min rule with the same escape hatch as every refusal;
    // the default for the rest of the table is still warn, per the test
    // above -- wrappers and shims are real for harnesses whose probe a
    // supported release cannot fail to answer.
    const fake = fakeHarness("");
    const call = (override: boolean) =>
      assertSupportedHarnessVersion({
        agent: "copilot", binary: fake.path, binaryName: "copilot", workdir: "/tmp",
        probeEnvironment: probeEnvironment({}), override, autonomy: "low",
      });
    try {
      await expect(call(false)).rejects.toThrow("could not determine the copilot version");
      await expect(call(false)).rejects.toThrow("1.0.77");
      const warnings = await captureWarnings(() => call(true));
      expect(warnings.join("\n")).toContain(ALLOW_UNTESTED_ENV);
    } finally {
      fake.cleanup();
    }
  });

  test("an unreadable version refuses whenever a session floor is in force", async () => {
    // Review live9: the session path's floor (minimumOverride) used to
    // take effect only when the probe READ a version -- a wrapper script
    // whose --version prints nothing parseable slid past the floor with a
    // warning. For `run` the warning stays (the opencode test above);
    // a session holds a resumable process open behind a floor the design
    // calls the pre-hardening boundary, so an unreadable version there is
    // a refused floor, with the operator's override as the only way past.
    const fake = fakeHarness("not a version");
    const call = (override: boolean, minimumOverride?: string) =>
      assertSupportedHarnessVersion({
        agent: "claude", binary: fake.path, binaryName: "claude", workdir: "/tmp",
        probeEnvironment: probeEnvironment({}), override, autonomy: "high",
        minimumOverride,
      });
    try {
      await expect(call(false, "2.1.280")).rejects.toThrow(
        "could not determine the claude version"
      );
      await expect(call(false, "2.1.280")).rejects.toThrow("2.1.280");
      // Without a floor (the `run` path), the same unreadable version
      // only warns: the refusal belongs to the session contract.
      const runPath = await captureWarnings(() => call(false));
      expect(runPath.join("\n")).toContain("could not determine");
      const warnings = await captureWarnings(() => call(true, "2.1.280"));
      expect(warnings.join("\n")).toContain(ALLOW_UNTESTED_ENV);
    } finally {
      fake.cleanup();
    }
  });

  test("an agent with no contract is left alone", async () => {
    const fake = fakeHarness("whatever");
    try {
      const warnings = await captureWarnings(() =>
        assertSupportedHarnessVersion({
          agent: "goose", binary: fake.path, binaryName: "goose", workdir: "/tmp",
          probeEnvironment: probeEnvironment({}), override: false, autonomy: "low",
        })
      );
      expect(warnings).toEqual([]);
    } finally {
      fake.cleanup();
    }
  });

  test("cursor's version probe keys on the entry name, not the executable's basename", async () => {
    // The finding: the gate hands the probe the canonical executable path,
    // and the standard Homebrew `cursor` symlink resolves into the
    // Cursor.app bundle as `code`. Selecting version arguments by that
    // path's basename sent bare `--version`, which reports the desktop
    // app's semver -- no calendar match -- so the gate read null and
    // warned past the floor instead of gating the agent build at all. The
    // fake answers `agent --version` with a calendar build and bare
    // `--version` with the desktop semver, exactly the split the real
    // pair has.
    const dir = mkdtempSync(join(tmpdir(), "codemux-cursor-entry-"));
    const path = join(dir, "code");
    writeFileSync(
      path,
      [
        "#!/bin/sh",
        'if [ "$1" = "agent" ] && [ "$2" = "--version" ]; then',
        "  printf '%s\\n' '2026.08.11-e8db854'",
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  printf '%s\\n' '3.23.12'",
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n")
    );
    chmodSync(path, 0o755);
    try {
      // The desktop entry: entry name `cursor`, executable basename `code`.
      const desktop = await probeHarnessVersion(
        path,
        HARNESS_CONTRACTS.cursor!,
        "/tmp",
        probeEnvironment({}),
        "cursor"
      );
      expect(desktop).toBe("2026.08.11");
      // The standalone entries probe bare `--version`, which on this fake
      // reports the desktop semver the calendar pattern rejects.
      const standalone = await probeHarnessVersion(
        path,
        HARNESS_CONTRACTS.cursor!,
        "/tmp",
        probeEnvironment({}),
        "agent"
      );
      expect(standalone).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the desktop entry's gate refuses an untrusted cursor before probing it", async () => {
    // The round-3 redesign: `cursor agent` runs only under the
    // CODEMUX_CURSOR_ENTRY opt-in, and then only through the launch path's
    // own ordering -- the `cursor` binary passes the trusted-executable
    // check resolved against the run's working directory BEFORE the gate
    // probes `cursor agent --version`. A repository-local cursor (a direnv
    // PATH_add, say) is therefore refused without ever executing, which is
    // what makes probing the installer-capable wrapper acceptable at all.
    // The fake marks every execution; the refusal must leave no marker.
    const repoDir = mkdtempSync(join(tmpdir(), "codemux-cursor-gate-"));
    const binary = join(repoDir, "bin", "cursor");
    const marker = join(repoDir, "ran");
    try {
      mkdirSync(join(repoDir, "bin"), { recursive: true });
      // User-owned and not group- or world-writable: only the run's --cwd
      // (this repository) makes it untrusted.
      writeFileSync(binary, `#!/bin/sh\necho ran >> '${marker}'\nexit 0\n`);
      chmodSync(binary, 0o755);
      await expect(
        assertHarnessSupported(
          "cursor",
          "cursor",
          repoDir,
          { PATH: join(repoDir, "bin") },
          "low",
          true,
          ["CODEMUX_CURSOR_ENTRY"]
        )
      ).rejects.toThrow("must not be inside the execution working directory");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("the desktop entry's gate probes cursor agent --version only after the trust check", async () => {
    // The same gate with a cursor that passes the trust check (outside the
    // run's working directory, user-owned): the probe runs, and it sends
    // `agent --version` -- the subcommand form -- through the wrapper. The
    // fake records its argv and answers a calendar build inside the audited
    // band, so the gate resolves silently.
    const base = mkdtempSync(join(tmpdir(), "codemux-cursor-gate-ok-"));
    const binDir = join(base, "bin");
    const workdir = join(base, "work");
    const cursor = join(binDir, "cursor");
    const marker = join(base, "argv");
    try {
      mkdirSync(binDir);
      mkdirSync(workdir);
      writeFileSync(
        cursor,
        [
          "#!/bin/sh",
          `echo "$@" >> '${marker}'`,
          'if [ "$1" = "agent" ] && [ "$2" = "--version" ]; then',
          "  printf '%s\\n' '2026.08.11-e8db854'",
          "fi",
          "exit 0",
          "",
        ].join("\n")
      );
      chmodSync(cursor, 0o755);
      await assertHarnessSupported(
        "cursor",
        "cursor",
        workdir,
        { PATH: binDir },
        "low",
        true,
        ["CODEMUX_CURSOR_ENTRY"]
      );
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf8")).toBe("agent --version\n");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
