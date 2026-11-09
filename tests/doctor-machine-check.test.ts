/**
 * The machine health check's harness rows (audit report D, D3): the
 * version-contract states, the feature and scode floors, trust, and the
 * exit code per row kind. Every run is in process against a swapped PATH
 * and a fixture HOME, with a controlled environment, so nothing here
 * depends on what the host has installed or exported.
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorTimeoutMs, validateAgentFilter } from "../src/doctor-machine-check.js";
import { UsageRefusalError } from "../src/validation.js";
import { VERSION_VERDICT_PROBE_TIMEOUT_MS, probeVersionVerdict } from "../src/harness-health.js";
import { fakeScodeHelp, fakeUsagemux, fixtureHome, readPathMarker, runDoctor } from "./helpers/doctor.js";
import { createFakeBinaryEnv } from "./helpers/cli.js";

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The binaries every green-path row needs: a scode that answers --version,
// --help (--keep-env), and one sandboxed command; a usagemux that answers
// --version and a per-client snapshot; a claude inside every contract.
const greenBinaries = (claudeReading: string): Record<string, string> => ({
  scode: fakeScodeHelp(),
  usagemux: fakeUsagemux(),
  claude: `if [ "$1" = "--version" ]; then printf '${claudeReading}\\n'; exit 0; fi`,
});

const claudeMirror = (expiresAt: number): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token", expiresAt } });

describe("validateAgentFilter", () => {
  test("--only keeps adapter order; --skip subtracts; commas split", () => {
    expect(validateAgentFilter(["codex,claude"])).toEqual(["codex", "claude"]);
    expect(validateAgentFilter(undefined, ["agy"])).not.toContain("agy");
    expect(validateAgentFilter()).toHaveLength(16);
  });

  test("an unknown name is a usage refusal listing the agents", () => {
    expect(() => validateAgentFilter(["nope"])).toThrow(/Unknown agent 'nope'/);
  });

  test("--only and --skip naming the same agent is a refusal", () => {
    expect(() => validateAgentFilter(["claude"], ["claude"])).toThrow(
      /--only and --skip both name claude/
    );
  });
});

describe("probeVersionVerdict", () => {
  test("trust runs before the no-contract return (round 331)", async () => {
    // An agent without a version contract still gets its binary checked:
    // doctor must not print "no contract" for a binary the launch path
    // refuses to run — here a group-writable one.
    const dir = mkdtempSync(join(tmpdir(), "codemux-doctor-trust-"));
    scratchDirs.push(dir);
    const qwen = join(dir, "qwen");
    writeFileSync(qwen, "#!/bin/sh\nexit 0\n");
    chmodSync(qwen, 0o775);
    const workdir = mkdtempSync(join(tmpdir(), "codemux-doctor-cwd-"));
    scratchDirs.push(workdir);
    expect((await probeVersionVerdict("qwen", "qwen", { binary: qwen, workdir })).kind).toBe("untrusted");
    chmodSync(qwen, 0o755);
    expect((await probeVersionVerdict("qwen", "qwen", { binary: qwen, workdir })).kind).toBe("no-contract");
  });
});

describe("doctor harness rows", () => {
  test("one row per harness, the environment block, and the summary", async () => {
    const fake = createFakeBinaryEnv(greenBinaries("2.1.300 (Claude Code)"));
    try {
      const result = await runDoctor(["--only", "claude"], {
        path: fake.env.PATH!,
        home: fixtureHome({ ".claude/.credentials.json": claudeMirror(Date.now() + 3_600_000) }),
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(
        "| Agent | Installed | Version | Contract | Floors | Login | Usage | Sandbox | State | Remedy |"
      );
      expect(result.output).toContain("| claude | yes | 2.1.300 | ok (2.1.300) |");
      expect(result.output).toContain("logged-in (~/.claude/.credentials.json)");
      expect(result.output).toContain("Environment:");
      // The green scode row: current, and its --help documents --keep-env.
      expect(result.output).toMatch(/scode: ok: scode 0\.6\.0 \(>= 0\.2\.0\); --keep-env supported/);
      expect(result.output).toContain("Summary: 1 ok, 0 warn, 0 broken, 0 not installed");
    } finally {
      fake.cleanup();
    }
  });

  test("a harness with no binary is informational and exits 0", async () => {
    const fake = createFakeBinaryEnv({ scode: fakeScodeHelp(), usagemux: fakeUsagemux() });
    try {
      const result = await runDoctor(["--only", "kimi"], {
        path: fake.env.PATH!,
        home: fixtureHome(),
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("| kimi | no |");
      expect(result.output).toContain("| NOT-INSTALLED |");
      expect(result.output).toContain("`codemux list --json` names the expected binary");
    } finally {
      fake.cleanup();
    }
  });

  test.each([
    ["2.1.100 (Claude Code)", "VERSION-BELOW-MIN", 1],
    ["9.9.9 (Claude Code)", "VERSION-ABOVE-CEILING", 0],
    ["not-a-version", "VERSION-UNREADABLE", 0],
  ])("a probe reading %s is %s and exits %i", async (reading, state, exit) => {
    const fake = createFakeBinaryEnv(greenBinaries(reading));
    try {
      const result = await runDoctor(["--only", "claude"], {
        path: fake.env.PATH!,
        home: fixtureHome({ ".claude/.credentials.json": claudeMirror(Date.now() + 3_600_000) }),
      });
      expect(result.exitCode).toBe(exit);
      expect(result.output).toContain(`| ${state} |`);
    } finally {
      fake.cleanup();
    }
  });

  test("--strict turns the above-ceiling warning into exit 1", async () => {
    const fake = createFakeBinaryEnv(greenBinaries("9.9.9 (Claude Code)"));
    try {
      const result = await runDoctor(["--only", "claude", "--strict"], {
        path: fake.env.PATH!,
        home: fixtureHome({ ".claude/.credentials.json": claudeMirror(Date.now() + 3_600_000) }),
      });
      expect(result.exitCode).toBe(1);
    } finally {
      fake.cleanup();
    }
  });

  test("a version below a feature floor is broken and the remedy names the feature", async () => {
    // 2.1.250 clears the run contract (min 2.1.220) and misses every
    // claude floor (2.1.280): exactly the row doctor used to call "ok".
    const fake = createFakeBinaryEnv(greenBinaries("2.1.250 (Claude Code)"));
    try {
      const result = await runDoctor(["--only", "claude"], {
        path: fake.env.PATH!,
        home: fixtureHome({ ".claude/.credentials.json": claudeMirror(Date.now() + 3_600_000) }),
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("| FEATURE-FLOOR |");
      expect(result.output).toContain("sessions: refused (needs 2.1.280, installed 2.1.250)");
      expect(result.output).toContain("to >= 2.1.280");
    } finally {
      fake.cleanup();
    }
  });

  test("missing scode is a broken environment and every sandboxed row names it", async () => {
    const fake = createFakeBinaryEnv({
      usagemux: fakeUsagemux(),
      claude: `if [ "$1" = "--version" ]; then printf '2.1.300 (Claude Code)\\n'; exit 0; fi`,
    });
    try {
      const result = await runDoctor(["--only", "claude"], {
        path: fake.env.PATH!,
        home: fixtureHome({ ".claude/.credentials.json": claudeMirror(Date.now() + 3_600_000) }),
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("scode: SANDBOX-MISSING");
      expect(result.output).toContain("| SANDBOX-MISSING |");
      expect(result.output).toContain("brew install bindsch/tap/scode");
    } finally {
      fake.cleanup();
    }
  });

  test("the agy scode floor marks agy and exits 1 while the environment stays ok", async () => {
    // Audit D2: scode 0.3.4 clears the global floor (0.2.0) and misses
    // agy's (0.6.0), so only the agy row refuses.
    const fake = createFakeBinaryEnv(
      {
        scode: fakeScodeHelp(),
        usagemux: fakeUsagemux(),
        claude: `if [ "$1" = "--version" ]; then printf '2.1.300 (Claude Code)\\n'; exit 0; fi`,
        agy: `if [ "$1" = "--version" ]; then printf '1.4.12\\n'; exit 0; fi`,
      },
      "0.3.4"
    );
    try {
      const result = await runDoctor(["--only", "claude,agy"], {
        path: fake.env.PATH!,
        home: fixtureHome({
          ".claude/.credentials.json": claudeMirror(Date.now() + 3_600_000),
          ".gemini/antigravity-cli/antigravity-oauth-token": "present",
        }),
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("scode 0.3.4 below the agy floor 0.6.0");
      expect(result.output).toContain("| SANDBOX-TOO-OLD |");
      expect(result.output).toContain("brew upgrade bindsch/tap/scode to >= 0.6.0");
      expect(result.output).toMatch(/scode: ok: scode 0\.3\.4/);
    } finally {
      fake.cleanup();
    }
  });

  test("a break scode mitigates is a warning that names the mitigation", async () => {
    // opencode 1.18.18: above the break boundary, on every feature floor,
    // and mitigated by the sandbox (audit D15).
    const fake = createFakeBinaryEnv({
      scode: fakeScodeHelp(),
      usagemux: fakeUsagemux(),
      opencode: `if [ "$1" = "--version" ]; then printf '1.19.5\\n'; exit 0; fi`,
    });
    try {
      const home = fixtureHome({ ".local/share/opencode/auth.json": '{"github":{}}' });
      const result = await runDoctor(["--only", "opencode"], { path: fake.env.PATH!, home });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("| KNOWN-BREAK |");
      expect(result.output).toContain("mitigated by the sandbox");
      expect(result.output).toContain("Summary: 0 ok, 1 warn, 0 broken, 0 not installed");
    } finally {
      fake.cleanup();
    }
  });

  test("a half-set provider override is OVERRIDE-INVALID with the variable in the remedy", async () => {
    const fake = createFakeBinaryEnv({
      scode: fakeScodeHelp(),
      usagemux: fakeUsagemux(),
      qwen: `if [ "$1" = "--version" ]; then printf '0.6.2\\n'; exit 0; fi`,
    });
    try {
      const result = await runDoctor(["--only", "qwen"], {
        path: fake.env.PATH!,
        home: fixtureHome(),
        env: { CODEMUX_QWEN_PROVIDER_BASE_URL: "https://example.invalid" },
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("| OVERRIDE-INVALID |");
      expect(result.output).toContain("CODEMUX_QWEN_PROVIDER_*");
    } finally {
      fake.cleanup();
    }
  });

  test("the default probe bound covers the slowest installed harness", () => {
    // openhands' version command measured about 6 s (Python startup); the
    // bound must read it and still bound a hung binary. Pins the constant
    // the --timeout default and the doc comment both rely on.
    expect(VERSION_VERDICT_PROBE_TIMEOUT_MS).toBe(10_000);
  });

  test("the version probe is bounded by --timeout and every agent still prints", async () => {
    const fake = createFakeBinaryEnv({
      scode: fakeScodeHelp(),
      usagemux: fakeUsagemux(),
      claude: `if [ "$1" = "--version" ]; then sleep 5; fi`,
    });
    try {
      const result = await runDoctor(["--only", "claude", "--timeout", "1"], {
        path: fake.env.PATH!,
        home: fixtureHome({ ".claude/.credentials.json": claudeMirror(Date.now() + 3_600_000) }),
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("unreadable (timed out)");
      expect(result.output).toContain("| VERSION-UNREADABLE |");
    } finally {
      fake.cleanup();
    }
  }, 15_000);

  test("a probe whose output is not UTF-8 is unreadable, not fatal", async () => {
    const fake = createFakeBinaryEnv({
      scode: fakeScodeHelp(),
      usagemux: fakeUsagemux(),
      // Octal escapes: dash (Ubuntu's /bin/sh) prints \\xff literally,
      // which is valid UTF-8 and would test a different premise there.
      claude: `if [ "$1" = "--version" ]; then printf '\\377\\376 not utf-8\\n'; exit 0; fi`,
      opencode: `if [ "$1" = "--version" ]; then printf '1.18.18\\n'; exit 0; fi`,
    });
    try {
      const result = await runDoctor(["--only", "claude,opencode"], {
        path: fake.env.PATH!,
        home: fixtureHome(),
      });
      expect(result.output).toContain("claude");
      expect(result.output).toContain("opencode");
      expect(result.output).toContain("| VERSION-UNREADABLE |");
    } finally {
      fake.cleanup();
    }
  });

  test("a world-writable binary is untrusted and never executed", async () => {
    const fake = createFakeBinaryEnv({
      scode: fakeScodeHelp(),
      usagemux: fakeUsagemux(),
      claude: `if [ "$1" = "--version" ]; then printf '2.1.300 (Claude Code)\\n'; touch "$(dirname "$0")/probe.ran"; exit 0; fi`,
    });
    try {
      chmodSync(join(fake.env.PATH!.split(":")[0]!, "claude"), 0o777);
      const result = await runDoctor(["--only", "claude"], {
        path: fake.env.PATH!,
        home: fixtureHome(),
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("| UNTRUSTED |");
      expect(result.output).toContain("chmod go-w");
      expect(readPathMarker(fake.env, "probe.ran")).toBe("");
    } finally {
      fake.cleanup();
    }
  });

  test("a binary inside the working directory is untrusted and never executed", async () => {
    // The planted node_modules/.bin shape: doctor runs from the repo, so a
    // PATH entry under it must not run unsandboxed under a diagnostic.
    const dir = mkdtempSync(join(process.cwd(), "scratch", "doctor-in-cwd-"));
    scratchDirs.push(dir);
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true, mode: 0o755 });
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '2.1.300 (Claude Code)\\n'; touch "${join(bin, "planted.ran")}"; exit 0; fi\n`,
      { mode: 0o755 }
    );
    const fake = createFakeBinaryEnv({ scode: fakeScodeHelp(), usagemux: fakeUsagemux() });
    try {
      const result = await runDoctor(["--only", "claude"], {
        path: [bin, ...fake.env.PATH!.split(":")].join(":"),
        home: fixtureHome(),
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("| UNTRUSTED |");
      expect(result.output).toContain("must not be inside the execution working directory");
      expect(existsSync(join(bin, "planted.ran"))).toBe(false);
    } finally {
      fake.cleanup();
    }
  });

  test("a binary that vanishes between discovery and its probe reads unreadable", async () => {
    // Round 11, edges 8: the availability fan-out runs before the probes,
    // so a binary removed in between used to print "no contract" for an
    // agent whose contract codemux knows. The stub nulls exactly zai's
    // probe-time lookup (zai shares the claude binary).
    const fake = createFakeBinaryEnv(greenBinaries("2.1.300 (Claude Code)"));
    const realWhich = Bun.which;
    let claudeLookups = 0;
    const which = spyOn(Bun, "which").mockImplementation((name, options) => {
      if (name === "claude" && ++claudeLookups === 4) return null;
      return realWhich(name, options);
    });
    try {
      const result = await runDoctor(["--only", "claude,zai"], {
        path: fake.env.PATH!,
        home: fixtureHome({ ".claude/.credentials.json": claudeMirror(Date.now() + 3_600_000) }),
      });
      expect(result.output).toContain("ok (2.1.300)");
      expect(result.output).toContain("unreadable (binary not found)");
    } finally {
      which.mockRestore();
      fake.cleanup();
    }
  });
});

describe("doctor flag validation", () => {
  const base = () => {
    const fake = createFakeBinaryEnv({ scode: fakeScodeHelp() });
    return fake;
  };

  test.each([
    [["--only", "nope"], /Unknown agent 'nope'/],
    [["--only", ","], /an entry is empty/],
    [["--skip", "claude,"], /an entry is empty/],
    [["--skip", "nope"], /Unknown agent 'nope'/],
    [["--only", "claude", "--skip", "claude"], /both name claude/],
    [["--spend-cap", "-1"], /--spend-cap must be a whole number/],
    [["--timeout", "0"], /--timeout must be a number of seconds/],
    [["--timeout", "abc"], /--timeout must be a number of seconds/],
    // Round 104: the flag must land on whole milliseconds a probe accepts
    // (1 to 60000), so a fourth decimal or a value over 60 seconds is a
    // usage refusal at the boundary, not a run that reads every harness
    // back as unreadable.
    [["--timeout", "0.0001"], /--timeout must be a number of seconds/],
    [["--timeout", "1.0005"], /--timeout must be a number of seconds/],
    [["--timeout", "60.0001"], /--timeout must be a number of seconds/],
    [["--timeout", "100"], /--timeout must be a number of seconds/],
    [["--format", "yaml"], /--format must be 'text' or 'json'/],
  ])("%s is a usage refusal", async (args, pattern) => {
    const fake = base();
    try {
      const result = await runDoctor(args, { path: fake.env.PATH!, home: fixtureHome() });
      expect(result.exitCode).toBe(64);
      expect(result.errors).toMatch(pattern);
    } finally {
      fake.cleanup();
    }
  });

  test("a config error is exit 2 with the parser's first line", async () => {
    const fake = base();
    try {
      const result = await runDoctor([], {
        path: fake.env.PATH!,
        home: fixtureHome(),
        configError: new Error("invalid configuration\nsecond line"),
      });
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain("config: invalid: invalid configuration");
      expect(result.output).not.toContain("second line");
    } finally {
      fake.cleanup();
    }
  });
});

describe("doctorTimeoutMs (round 104)", () => {
  test.each([
    [0.001, 1],
    [1.5, 1500],
    [60, 60000],
  ])("%s seconds is exactly %i whole milliseconds", (seconds, ms) => {
    expect(doctorTimeoutMs(seconds)).toBe(ms);
  });

  test("every three-decimal value from 0.001 to 60 is accepted", () => {
    // 1.001 * 1000 is 1000.9999999999999 in binary floating point: an exact
    // integer test refused 731 of the 60000 valid values.
    expect(doctorTimeoutMs(1.001)).toBe(1001);
    for (let ms = 1; ms <= 60_000; ms += 1) {
      expect(doctorTimeoutMs(Number((ms / 1_000).toFixed(3)))).toBe(ms);
    }
  });

  test.each([0.0001, 0.0005, 1.0005, 1.0010001, 1.0000000001, 0.0010000001, 59.9999999999, 60.0001, 100, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "%s is a usage refusal naming the rule",
    (seconds) => {
      expect(() => doctorTimeoutMs(seconds)).toThrow(UsageRefusalError);
      expect(() => doctorTimeoutMs(seconds)).toThrow(/--timeout must be a number of seconds/);
    }
  );

  test("the whole milliseconds reach the version probe", async () => {
    // A fake claude that answers after 0.2 s stays green under 1.5 and 60
    // seconds; under 0.001 (1 ms) the same binary cannot answer in budget
    // and the row reports the timeout — the fractional flag reached the
    // probe as the exact millisecond count, not as a refusal or a default.
    // The delay is what makes 1 ms too short: a fake that answered at once
    // could exit before a 1 ms timer fired on a fast Linux runner, which
    // read back green (CI run 42681779732, ubuntu-latest).
    const fake = createFakeBinaryEnv({
      ...greenBinaries("2.1.300 (Claude Code)"),
      claude: `if [ "$1" = "--version" ]; then sleep 0.2; printf '2.1.300 (Claude Code)\\n'; exit 0; fi`,
    });
    try {
      const green = async (timeout: string): Promise<void> => {
        const result = await runDoctor(["--only", "claude", "--timeout", timeout], {
          path: fake.env.PATH!,
          home: fixtureHome({ ".claude/.credentials.json": claudeMirror(Date.now() + 3_600_000) }),
        });
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain("| claude | yes | 2.1.300 | ok (2.1.300) |");
        expect(result.output).not.toContain("timed out");
      };
      await green("1.5");
      await green("60");
      const oneMs = await runDoctor(["--only", "claude", "--timeout", "0.001"], {
        path: fake.env.PATH!,
        home: fixtureHome({ ".claude/.credentials.json": claudeMirror(Date.now() + 3_600_000) }),
      });
      // Accepted (no usage refusal) and the 1 ms budget is what the probe
      // ran with: the row times out, exit stays informational.
      expect(oneMs.exitCode).toBe(0);
      expect(oneMs.errors).not.toContain("--timeout");
      expect(oneMs.output).toContain("timed out");
    } finally {
      fake.cleanup();
    }
  });
});
