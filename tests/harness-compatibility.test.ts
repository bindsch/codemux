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
  compareVersions,
  evaluateHarnessVersion,
  extractHarnessVersion,
  HARNESS_CONTRACTS,
  type HarnessContract,
  probeHarnessVersion,
} from "../src/harness-compatibility.js";

const opencode = HARNESS_CONTRACTS.opencode!;
const claude = HARNESS_CONTRACTS.claude!;

describe("version comparison", () => {
  test("orders by numeric component, not lexically", () => {
    // The case that hid the OpenCode drift: 1.18.18 sorts before 1.18.9 as text.
    expect(compareVersions("1.18.18", "1.18.9")).toBeGreaterThan(0);
    expect(compareVersions("0.86.2", "0.86.10")).toBeLessThan(0);
    expect(compareVersions("2.1.220", "2.1.220")).toBe(0);
  });

  test("treats missing trailing components as zero", () => {
    expect(compareVersions("1.18", "1.18.0")).toBe(0);
    expect(compareVersions("1.18", "1.18.1")).toBeLessThan(0);
  });

  test("orders calendar builds by date prefix", () => {
    expect(compareVersions("2026.08.11", "2026.07.23")).toBeGreaterThan(0);
  });
});

describe("version extraction", () => {
  const cases: [keyof typeof HARNESS_CONTRACTS, string, string][] = [
    ["opencode", "1.18.18", "1.18.18"],
    ["claude", "2.1.223 (Claude Code)", "2.1.223"],
    ["codex", "codex-cli 0.147.0", "0.147.0"],
    ["aider", "aider 0.86.2", "0.86.2"],
    ["cursor", "2026.08.11-e8db854", "2026.08.11"],
    // What `copilot --binary-version` prints. The contract uses it rather than `--version`
    // because `--version` starts the packaged application and needs a writable extraction cache,
    // which fails under a restricted filesystem and silently disables the gate.
    ["copilot", "Copilot binary version: 1.0.85", "1.0.85"],
  ];

  for (const [agent, output, expected] of cases) {
    test(`parses ${agent} output`, () => {
      const contract = HARNESS_CONTRACTS[agent] as HarnessContract;
      expect(extractHarnessVersion(contract, output)).toBe(expected);
    });
  }

  test("returns null when the output does not carry a version", () => {
    expect(extractHarnessVersion(opencode, "command not found")).toBeNull();
  });
});

describe("three-tier verdicts", () => {
  test("an audited version runs silently", () => {
    const verdict = evaluateHarnessVersion("claude", claude, "2.1.223");
    expect(verdict.kind).toBe("supported");
    expect(verdict.message).toBeNull();
  });

  test("a version below the floor is refused", () => {
    const verdict = evaluateHarnessVersion("claude", claude, "2.1.100");
    expect(verdict.kind).toBe("refuse");
    expect(verdict.message).toContain("older than");
  });

  test("a newer version warns instead of blocking", () => {
    // The usability rule: upstream ships patches that change nothing, and
    // refusing them all would make Codemux unusable.
    const verdict = evaluateHarnessVersion("claude", claude, "2.1.999");
    expect(verdict.kind).toBe("unaudited");
    expect(verdict.message).toContain("newer than");
  });
});

describe("OpenCode 1.18.18 permission break", () => {
  test("refuses low autonomy unsandboxed", () => {
    const verdict = evaluateHarnessVersion("opencode", opencode, "1.18.18", "low", false);
    expect(verdict.kind).toBe("refuse");
    expect(verdict.message).toContain("low and medium");
    expect(verdict.message).toContain("--sandbox");
  });

  test("refuses medium autonomy unsandboxed", () => {
    expect(
      evaluateHarnessVersion("opencode", opencode, "1.18.18", "medium", false).kind
    ).toBe("refuse");
  });

  test("allows low and medium when sandboxed, because scode supplies the boundary", () => {
    expect(
      evaluateHarnessVersion("opencode", opencode, "1.18.18", "low", true).kind
    ).not.toBe("refuse");
    expect(
      evaluateHarnessVersion("opencode", opencode, "1.18.18", "medium", true).kind
    ).not.toBe("refuse");
  });

  test("leaves read-only and high alone", () => {
    // read-only already requires scode; high is auto-approve by design. A break
    // scoped to low and medium must not block either of them.
    for (const level of ["read-only", "high"] as const) {
      expect(
        evaluateHarnessVersion("opencode", opencode, "1.18.18", level, false).kind
      ).not.toBe("refuse");
    }
  });

  test("does not apply below the version that introduced it", () => {
    expect(
      evaluateHarnessVersion("opencode", opencode, "1.18.10", "low", false).kind
    ).toBe("supported");
  });

  test("still applies to releases after the break", () => {
    expect(
      evaluateHarnessVersion("opencode", opencode, "1.19.0", "low", false).kind
    ).toBe("refuse");
  });
});

describe("contract table", () => {
  test("every contract declares an ordered, parseable range", () => {
    for (const [agent, contract] of Object.entries(HARNESS_CONTRACTS)) {
      const c = contract as HarnessContract;
      expect(compareVersions(c.min, c.maxAudited), agent).toBeLessThanOrEqual(0);
      for (const breakage of c.breaks ?? []) {
        expect(breakage.affects.length, `${agent} break scope`).toBeGreaterThan(0);
        expect(breakage.note.length, `${agent} break note`).toBeGreaterThan(20);
      }
    }
  });
});

describe("the gate itself", () => {
  const fakeHarness = (versionOutput: string): { path: string; cleanup: () => void } => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-harness-"));
    const path = join(dir, "opencode");
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${versionOutput}'\n`);
    chmodSync(path, 0o755);
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };

  const captureWarnings = async (run: () => Promise<void>): Promise<string[]> => {
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

describe("the ledger and the version gate agree", () => {
  // Ledger name to agent id. An installed row whose name is missing here FAILS the test rather
  // than being skipped -- see below for why that direction matters.
  const AGENT_BY_LEDGER_NAME: Record<string, keyof typeof HARNESS_CONTRACTS> = {
    "Antigravity CLI": "agy",
    Aider: "aider",
    "Claude Code": "claude",
    "Cline CLI": "cline",
    "Codex CLI": "codex",
    Droid: "droid",
    "GitHub Copilot CLI": "copilot",
    "Cursor Agent": "cursor",
    Goose: "goose",
    "Gemini CLI": "gemini",
    "Kimi Code": "kimi",
    OpenHands: "openhands",
    OpenCode: "opencode",
    Pi: "pi",
    "Qwen Code": "qwen",
    "Z.AI": "zai",
  };

  function installedRows(ledger: string): string[] {
    return ledger
      .split("\n")
      .filter((line) => line.startsWith("|") && !line.includes("---"))
      .map((line) => line.split("|").map((cell) => cell.trim()))
      .filter((cells) => cells.length > 4)
      // The header row is skipped by its own name cell, never by matching the
      // installed column's wording -- the round29 finding: the old filter also
      // exempted /^Installed during/i there, which is what the header's third
      // column reads, so a data row worded "Installed during the re-audit" --
      // a claim that a machine exercised the harness -- would silently skip
      // the version-contract requirement this test exists to enforce.
      .filter((cells) => cells[1] !== "Harness")
      // The installed column holds a version, "same" (matches the audited
      // column), "not installed", or a phrase saying when it was installed.
      // Anything that is not an explicit "not installed" claims a machine
      // exercised it.
      .filter((cells) => {
        const installed = cells[3] ?? "";
        return installed !== "" && !/^not installed/i.test(installed);
      })
      .map((cells) => cells[1] ?? "");
  }

  test("every harness the ledger records as installed has a version contract", async () => {
    // `assertSupportedHarnessVersion` returns immediately when a harness has no contract -- not a
    // warning, a silent pass. Copilot sat in that state while the ledger recorded it as audited,
    // and copilot is the harness that renamed a flag between patch releases, so an unpinned
    // version there was the least safe default in the table.
    //
    // The first version of this test filtered out any ledger name it did not recognize, so three
    // of seven installed rows went unchecked and two map entries were dead. A guard that exempts
    // what it does not recognize is the defect it was written to prevent. An unknown name now
    // fails, which forces the map to be extended when a row is added.
    const ledger = await Bun.file(
      new URL("../docs/HARNESS-COMPATIBILITY.md", import.meta.url)
    ).text();
    const rows = installedRows(ledger);
    expect(rows.length).toBeGreaterThan(4);

    const unmapped = rows.filter((name) => AGENT_BY_LEDGER_NAME[name] === undefined);
    expect(unmapped).toEqual([]);

    const ungated = rows.filter((name) => {
      const agent = AGENT_BY_LEDGER_NAME[name];
      return agent !== undefined && HARNESS_CONTRACTS[agent] === undefined;
    });
    expect(ungated).toEqual([]);
  });

  test("the ledger rows this test reads are the ones it claims to read", async () => {
    // Pins the parse itself. If the table's shape changes, this fails rather than quietly
    // matching nothing and reporting success.
    const ledger = await Bun.file(
      new URL("../docs/HARNESS-COMPATIBILITY.md", import.meta.url)
    ).text();
    const rows = installedRows(ledger);
    expect(rows).toContain("GitHub Copilot CLI");
    expect(rows).toContain("Droid");
    expect(rows).toContain("Kimi Code");
    expect(rows).toContain("Cursor Agent"); // installed column reads "same", still installed
    expect(rows).not.toContain("Goose"); // "not installed"
  });

  test("a row whose installed column phrases its installation is still an installed row", () => {
    // The round29 finding, at the parse itself: installedRows exempted any
    // installed cell matching /^Installed during/i -- a pattern written for
    // the header row, whose third column reads "Installed during audit" --
    // so a ledger row worded like the header claimed installation while
    // silently skipping the version-contract check. The header is skipped
    // by its name cell now, and a phrased row counts like any other.
    const ledger = [
      "| Harness | Audited upstream | Installed during audit | Primary source | Important contract |",
      "|---------|------------------|------------------------|----------------|--------------------|",
      "| Droid | 0.186.0 | Installed during the round-29 re-audit | docs | stdin |",
      "| Goose | 1.45.0 | not installed | docs | modes |",
    ].join("\n");
    const rows = installedRows(ledger);
    expect(rows).toContain("Droid");
    expect(rows).not.toContain("Goose");
    expect(rows).not.toContain("Harness"); // the header, skipped by name
  });
});

describe("the version probe runs before any sandbox, so it scrubs its own environment", () => {
  test("a variable that redirects code loading cannot reach the probe", async () => {
    // Copilot imports COPILOT_CLI_DIST_DIR's index.js instead of its installed distribution, for
    // `--version` too. Inherited, it lets an environment variable choose which code runs and what
    // version the gate reads -- outside the sandbox, because the probe runs before one exists.
    // Reproduced against the real binary during review: the unscrubbed probe reported a fabricated
    // 0.0.1 from a fixture directory while copilot 1.0.85 was installed.
    const { probeEnvironment } = await import("../src/environment.js");
    const probe = probeEnvironment({
      PATH: "/usr/bin",
      HOME: "/tmp",
      LANG: "C",
      COPILOT_CLI_DIST_DIR: "/tmp/fixture",
      COPILOT_HOME: "/tmp/fixture",
      DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      LD_PRELOAD: "/tmp/evil.so",
      BASH_ENV: "/tmp/evil.sh",
      ANTHROPIC_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
    });
    // Nothing that can redirect code loading.
    expect(probe.COPILOT_CLI_DIST_DIR).toBeUndefined();
    expect(probe.COPILOT_HOME).toBeUndefined();
    expect(probe.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(probe.LD_PRELOAD).toBeUndefined();
    expect(probe.BASH_ENV).toBeUndefined();
    // And no credentials: the probe reads a version string, and an allowlist is what makes that
    // claim true. A denylist would have passed every one of these through, outside the sandbox.
    expect(probe.ANTHROPIC_API_KEY).toBeUndefined();
    expect(probe.GITHUB_TOKEN).toBeUndefined();
    // It still has to be able to find and run the binary and read its output.
    expect(Object.keys(probe).sort()).toEqual(["HOME", "LANG", "PATH"]);
  });

  test("neither a passed-through secret nor a selector reaches the probe", async () => {
    // Two regressions a round apart, pulling opposite ways. Dropping every passed-through name
    // made the gate measure the default binary while the launch ran an override. Keeping them all
    // handed credentials to the harness's version command, which runs before scode exists and has
    // network access even under --sandbox-no-net. The sets are different: a selector is a small
    // knowable list, a credential is anything.
    const { probeEnvironment } = await import("../src/environment.js");
    const raw = {
      PATH: "/usr/bin",
      OPENCODE_BIN_PATH: "/opt/oc/1.18.0",
      INTERNAL_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
    };
    const probe = probeEnvironment(raw, ["OPENCODE_BIN_PATH", "INTERNAL_TOKEN", "GITHUB_TOKEN"]);
    // Nothing the operator passed through reaches the probe, selector or secret. Carrying the
    // selector was tried and withdrawn: the probe runs before scode and only the PATH-resolved
    // launcher is validated, so honoring a redirect inside the probe environment executes an
    // unvalidated binary outside the sandbox. The gate answers the redirect one level up
    // instead -- it resolves the value to a trusted executable and probes that binary
    // directly -- so the probe environment never needs to carry it.
    expect(probe.OPENCODE_BIN_PATH).toBeUndefined();
    expect(probe.INTERNAL_TOKEN).toBeUndefined();
    expect(probe.GITHUB_TOKEN).toBeUndefined();
  });

  test("a redirect is named so the caller can refuse to speak for the launch", async () => {
    // OpenCode's launcher picks its binary from OPENCODE_BIN_PATH. The name is listed so
    // `assertHarnessSupported` can answer it: resolve the value to a trusted executable and
    // read the verdict from that binary, or -- when it cannot -- warn rather than measuring
    // the default binary and calling it confirmed.
    const { EXECUTABLE_REDIRECTS, activeRedirects } = await import("../src/environment.js");
    expect(EXECUTABLE_REDIRECTS.opencode).toContain("OPENCODE_BIN_PATH");

    // It is in play only for the harness that reads it, and only when actually set. A flat set
    // made `--pass-env OPENCODE_BIN_PATH` skip the version check for every agent, even with the
    // variable unset -- a universal bypass in place of a narrow "cannot confirm".
    const set = { OPENCODE_BIN_PATH: "/opt/oc" };
    expect(activeRedirects("opencode", set, ["OPENCODE_BIN_PATH"])).toEqual(["OPENCODE_BIN_PATH"]);
    expect(activeRedirects("claude", set, ["OPENCODE_BIN_PATH"])).toEqual([]);
    expect(activeRedirects("opencode", {}, ["OPENCODE_BIN_PATH"])).toEqual([]);

    // A set-but-empty value is not a redirect: OpenCode's launcher reads it as no override and
    // runs its default binary, which the probe can read. Counting it as one skipped the gate and
    // let a release below the floor run without the compatibility override.
    expect(activeRedirects("opencode", { OPENCODE_BIN_PATH: "" }, ["OPENCODE_BIN_PATH"]))
      .toEqual([]);
    expect(activeRedirects("opencode", { OPENCODE_BIN_PATH: " " }, ["OPENCODE_BIN_PATH"]))
      .toEqual(["OPENCODE_BIN_PATH"]);
    const runtime = await Bun.file(
      new URL("../src/cli-runtime.ts", import.meta.url)
    ).text();
    expect(runtime).toContain("activeRedirects(");
    expect(runtime).toContain("cannot confirm the version");
  });

  test("the probe environment is a subset of the launch environment", async () => {
    // The allow side matched the upper-cased name while the launch matches exactly, so lowercase
    // variants reached the probe and were stripped from the launch -- `https_proxy` among them,
    // which most HTTP clients honor, so the two execs could resolve the network differently.
    const { probeEnvironment, sanitizeEnvironment } = await import("../src/environment.js");
    const raw = {
      PATH: "/usr/bin",
      HOME: "/tmp",
      https_proxy: "http://lowercase",
      HTTPS_PROXY: "http://uppercase",
      home: "/lowercase",
    };
    const probe = probeEnvironment(raw);
    const launch = sanitizeEnvironment("copilot", raw);
    for (const name of Object.keys(probe)) {
      expect(launch, `${name} reaches the probe but not the launch`).toHaveProperty(name);
    }
    expect(probe.https_proxy).toBeUndefined();
    expect(probe.home).toBeUndefined();
  });

  test("the probe keeps the locale prefixes the launch keeps", async () => {
    // The round12 finding: the probe allowlist carried INERT_ENV alone while
    // sanitizeEnvironment also keeps every LC_* name (INERT_PREFIXES), so the
    // --version exec and the run could resolve their locales differently with
    // no rule either way. The prefix rule now matches, keeping the probe a
    // subset of the launch rather than a divergent twin.
    const { probeEnvironment, sanitizeEnvironment } = await import("../src/environment.js");
    const raw = { PATH: "/usr/bin", LANG: "C", LC_ALL: "C.UTF-8", LC_CTYPE: "UTF-8" };
    const probe = probeEnvironment(raw);
    expect(probe.LC_ALL).toBe("C.UTF-8");
    expect(probe.LC_CTYPE).toBe("UTF-8");
    const launch = sanitizeEnvironment("copilot", raw);
    for (const name of Object.keys(probe)) {
      expect(launch, `${name} reaches the probe but not the launch`).toHaveProperty(name);
    }
  });

  test("the probe uses the environment it is given and decides nothing", async () => {
    // The decoupling, asserted structurally. Every regression in this path came from the probe
    // deciding its own environment while the launch decided differently: a dropped
    // OPENCODE_BIN_PATH made the gate measure one executable while the launch ran another, and a
    // case-insensitive allowlist let `https_proxy` reach the probe but not the launch. The
    // decision now lives in `cli-runtime.assertHarnessSupported`, the only scope where the launch
    // environment is also visible, so the two cannot drift apart.
    const source = await Bun.file(
      new URL("../src/harness-compatibility.ts", import.meta.url)
    ).text();
    // A type-only import is the right dependency: it carries no runtime coupling and is what makes
    // the contract enforceable, since only `probeEnvironment` can produce the branded type. What
    // must not appear is a value import or a call -- this module must never build an environment.
    expect(source).toContain('import type { ProbeEnvironment } from "./environment.js"');
    expect(source).not.toMatch(/^import \{[^}]*\} from "\.\/environment\.js"/m);
    expect(source).not.toContain("probeEnvironment(");

    const runtime = await Bun.file(
      new URL("../src/cli-runtime.ts", import.meta.url)
    ).text();
    const resolver = runtime.slice(runtime.indexOf("export async function assertHarnessSupported"));
    expect(resolver).toContain("probeEnvironment(");
    // Both sources of names the launch keeps have to reach it.
    expect(resolver).toContain("explicitPassthrough");
    expect(resolver).toContain("Object.keys(extraEnv");
  });
});

describe("no version-fallback machinery exists", () => {
  test("the band below the primary flag warns rather than being covered by a fallback", async () => {
    // A fallback to copilot's bare `--version` was tried and withdrawn: it lets copilot
    // auto-update and report a cached newer version while the launch, which passes
    // --no-auto-update, runs the bundled older one -- the gate approving a version that never
    // runs. With --no-auto-update it may hit an unknown option on exactly the releases it serves.
    // An unreadable version goes to the gate's per-contract null rule instead -- warn by
    // default, refuse where the contract pins it (copilot does; every release it supports can
    // answer the probe) -- never to a second probe.
    // The machinery itself is gone: a contract cannot carry a fallback the interface has no
    // field for, and re-adding either name fails here.
    const source = await Bun.file(
      new URL("../src/harness-compatibility.ts", import.meta.url)
    ).text();
    expect(source).not.toContain("fallbackVersionArgs");
    expect(source).not.toContain("fallbackPattern");
  });
});
