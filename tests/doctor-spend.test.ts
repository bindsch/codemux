/**
 * The machine check's paid stage (audit report D, section 3, stage 4) and
 * its JSON spelling: --spend never runs without the flag, spends at most
 * --spend-cap requests, skips every harness the free stages refused,
 * carries the machine-check label, and reports the outcome per row. The
 * `codemux` it probes is a fake that records its argv, so no test here
 * spends a request.
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { machineCheckLabelValue, spendProbe } from "../src/doctor-spend.js";
import { loginFingerprint } from "../src/harness-health.js";
import { fakeScodeHelp, fakeUsagemux, fixtureHome, readPathMarker, runDoctor } from "./helpers/doctor.js";
import { createFakeBinaryEnv } from "./helpers/cli.js";

const homes: string[] = [];
const realCommand = spendProbe.command;
afterAll(() => {
  spendProbe.command = realCommand;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** Points the probe at the fake codemux on this fake PATH (the real command
 * is this checkout's own entry point, which would spend). */
const probeThrough = (env: Record<string, string>): void => {
  const fake = Bun.which("codemux", { PATH: env.PATH ?? "" });
  if (fake === null) throw new Error("the fake PATH carries no codemux");
  spendProbe.command = () => [fake];
};

const MINUTE = 60_000;
const claudeGreen = `if [ "$1" = "--version" ]; then printf '2.1.300 (Claude Code)\\n'; exit 0; fi`;
const claudeHome = { ".claude/.credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token", expiresAt: Date.now() + 30 * MINUTE } }) };

/** A fake codemux: it records every `check` argv beside itself and either
 * answers OK or fails with one stderr line, per `fail`. */
const fakeCodemux = (fail = false): string =>
  [
    `if [ "$1" = "check" ]; then printf '%s\\n' "$*" >> "$(dirname "$0")/codemux-calls.log"`,
    fail ? `printf 'Error: the harness refused the request\\nsecond line\\n' >&2; exit 64` : `exit 0`,
    `fi`,
    `exit 1`,
  ].join("\n");

describe("the spend stage", () => {
  test("without --spend no probe runs at all", async () => {
    const fake = createFakeBinaryEnv({
      scode: fakeScodeHelp(),
      usagemux: fakeUsagemux(),
      claude: claudeGreen,
      codemux: fakeCodemux(),
    });
    try {
      probeThrough(fake.env);
      const result = await runDoctor(["--only", "claude"], {
        path: fake.env.PATH!,
        home: fixtureHome(claudeHome, homes),
      });
      expect(result.exitCode).toBe(0);
      expect(readPathMarker(fake.env, "codemux-calls.log")).toBe("");
    } finally {
      fake.cleanup();
    }
  });

  test("--spend runs one read-only probe carrying the machine-check label", async () => {
    const fake = createFakeBinaryEnv({
      scode: fakeScodeHelp(),
      usagemux: fakeUsagemux(),
      claude: claudeGreen,
      codemux: fakeCodemux(),
    });
    try {
      probeThrough(fake.env);
      const result = await runDoctor(["--only", "claude", "--spend"], {
        path: fake.env.PATH!,
        home: fixtureHome(claudeHome, homes),
      });
      expect(result.exitCode).toBe(0);
      const calls = readPathMarker(fake.env, "codemux-calls.log");
      expect(calls.trim().split("\n")).toHaveLength(1);
      expect(calls).toContain("-a claude --auto read-only");
      expect(calls).toContain("--label machine-check=");
      // One value per run, to the millisecond (review round 52; round 307
      // kept the milliseconds, so two checks inside one second differ).
      expect(calls).toMatch(/--label machine-check=\d{4}-\d{2}-\d{2}T\d{6}\.\d{3}Z-\d+-\d+/);
      expect(calls).toContain("--timeout 120");
    } finally {
      fake.cleanup();
    }
  });

  test("two checks inside one millisecond get different machine-check labels (rounds 307, 310)", () => {
    // Two `doctor --spend` runs beginning in the same second used to mint
    // one shared second-resolution label, so the documented
    // `calls --label machine-check=<date> --sum` merged their spend into
    // one total. Milliseconds alone still collided inside one millisecond,
    // so the stamp carries the process id and a per-process counter.
    const stamps = spyOn(Date.prototype, "toISOString").mockReturnValue("2026-11-07T18:30:00.000Z");
    try {
      const first = machineCheckLabelValue();
      const second = machineCheckLabelValue();
      expect(first).toMatch(new RegExp(`^2026-11-07T183000\\.000Z-${process.pid}-\\d+$`));
      expect(second).toMatch(new RegExp(`^2026-11-07T183000\\.000Z-${process.pid}-\\d+$`));
      expect(second).not.toBe(first);
    } finally {
      stamps.mockRestore();
    }
  });

  test("a failed probe is PROBE-FAILED with the first stderr line and exit 1", async () => {
    const fake = createFakeBinaryEnv({
      scode: fakeScodeHelp(),
      usagemux: fakeUsagemux(),
      claude: claudeGreen,
      codemux: fakeCodemux(true),
    });
    try {
      probeThrough(fake.env);
      const result = await runDoctor(["--only", "claude", "--spend"], {
        path: fake.env.PATH!,
        home: fixtureHome(claudeHome, homes),
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("| PROBE-FAILED |");
      expect(result.output).toContain("Error: the harness refused the request");
      expect(result.output).not.toContain("second line");
      expect(result.output).toContain("rerun codemux check -a claude");
    } finally {
      fake.cleanup();
    }
  });

  test("--spend-cap 0 spends nothing; --spend-cap 1 probes one of two eligible", async () => {
    const base = {
      scode: fakeScodeHelp(),
      usagemux: fakeUsagemux(),
      claude: claudeGreen,
      codex: `if [ "$1" = "--version" ]; then printf 'codex-cli 0.165.0\\n'; exit 0; fi`,
    };
    const capped = createFakeBinaryEnv({ ...base, codemux: fakeCodemux() });
    const zero = createFakeBinaryEnv({ ...base, codemux: fakeCodemux() });
    try {
      probeThrough(zero.env);
      const home = {
        ...claudeHome,
        ".codex/auth.json": '{"auth_mode":"chatgpt","tokens":{"refresh_token":"present"}}',
      };
      const zeroResult = await runDoctor(["--only", "claude,codex", "--spend", "--spend-cap", "0"], {
        path: zero.env.PATH!,
        home: fixtureHome(home, homes),
      });
      expect(zeroResult.exitCode).toBe(0);
      expect(readPathMarker(zero.env, "codemux-calls.log")).toBe("");

      probeThrough(capped.env);
      const cappedResult = await runDoctor(["--only", "claude,codex", "--spend", "--spend-cap", "1"], {
        path: capped.env.PATH!,
        home: fixtureHome(home, homes),
      });
      expect(cappedResult.exitCode).toBe(0);
      expect(readPathMarker(capped.env, "codemux-calls.log").trim().split("\n")).toHaveLength(1);
    } finally {
      capped.cleanup();
      zero.cleanup();
    }
  });

  test("a harness the free stages refused is never probed", async () => {
    // The quota row refuses (below the ceiling): spending there buys a
    // refusal, so the probe never runs even under --spend-unreadable.
    const fake = createFakeBinaryEnv({
      scode: fakeScodeHelp(),
      usagemux: fakeUsagemux({ remainingPercent: 5, usedPercent: 95 }),
      claude: claudeGreen,
      codemux: fakeCodemux(),
    });
    try {
      probeThrough(fake.env);
      const result = await runDoctor(["--only", "claude", "--spend", "--spend-unreadable"], {
        path: fake.env.PATH!,
        home: fixtureHome(claudeHome, homes),
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("| QUOTA-LOW |");
      expect(readPathMarker(fake.env, "codemux-calls.log")).toBe("");
    } finally {
      fake.cleanup();
    }
  });

  test("an unreadable usage row is probed only under --spend-unreadable", async () => {
    const base = {
      scode: fakeScodeHelp(),
      usagemux: fakeUsagemux({ status: "unavailable", message: "sign in to the CLI" }),
      claude: claudeGreen,
      codemux: fakeCodemux(),
    };
    const plain = createFakeBinaryEnv({ ...base });
    const forced = createFakeBinaryEnv({ ...base });
    try {
      probeThrough(plain.env);
      const without = await runDoctor(["--only", "claude", "--spend"], {
        path: plain.env.PATH!,
        home: fixtureHome(claudeHome, homes),
      });
      expect(without.output).toContain("| QUOTA-UNREADABLE |");
      expect(readPathMarker(plain.env, "codemux-calls.log")).toBe("");

      probeThrough(forced.env);
      const withFlag = await runDoctor(["--only", "claude", "--spend", "--spend-unreadable"], {
        path: forced.env.PATH!,
        home: fixtureHome(claudeHome, homes),
      });
      expect(withFlag.exitCode).toBe(0);
      expect(readPathMarker(forced.env, "codemux-calls.log")).toContain("-a claude");
    } finally {
      plain.cleanup();
      forced.cleanup();
    }
  });
});

describe("the --format json spelling", () => {
  test("emits codemux-doctor-1 with the account as a fingerprint only", async () => {
    const fake = createFakeBinaryEnv({
      scode: fakeScodeHelp(),
      usagemux: fakeUsagemux({ account: "acct-1" }),
      claude: claudeGreen,
    });
    try {
      const home = fixtureHome(claudeHome, homes);
      const jsonRun = await runDoctor(["--only", "claude", "--format", "json"], {
        path: fake.env.PATH!,
        home,
      });
      expect(jsonRun.exitCode).toBe(0);
      const document = JSON.parse(jsonRun.output) as {
        schema: string;
        codemux: { version: string };
        environment: Record<string, { state: string; severity: string; detail: string; remedy: string | null }>;
        harnesses: Array<{
          id: string;
          state: string;
          severity: string;
          checks: Record<string, unknown>;
          remedy: string | null;
          detail: string[];
          spend: unknown;
          accountFingerprint: string | null;
          accountPresent: boolean;
        }>;
        summary: { ok: number; warn: number; broken: number; notInstalled: number };
        exitCode: number;
      };
      expect(document.schema).toBe("codemux-doctor-1");
      // Documented in docs/machine-check.md; dropped before review round 44.
      for (const entry of document.harnesses) expect(typeof (entry as { installed?: unknown }).installed).toBe("boolean");
      expect(Object.keys(document.environment).sort()).toEqual([
        "aliases",
        "codemux",
        "codexbar",
        "config",
        "keychain",
        "scode",
        "usagemux",
      ]);
      const row = document.harnesses.find((entry) => entry.id === "claude")!;
      expect(row.state).toBe("OK");
      expect(row.severity).toBe("ok");
      expect(Object.keys(row.checks).sort()).toEqual([
        "contract",
        "floors",
        "login",
        "override",
        "sandbox",
        "usage",
        "version",
      ]);
      // The account appears as a four-character fingerprint, and nowhere
      // else: the human spelling never carries even that.
      expect(row.accountPresent).toBe(true);
      expect(row.accountFingerprint).toBe(loginFingerprint("acct-1"));
      expect(jsonRun.output).not.toContain("acct-1");

      const human = await runDoctor(["--only", "claude"], { path: fake.env.PATH!, home });
      expect(human.output).not.toContain("acct-1");
      expect(human.output).not.toContain(loginFingerprint("acct-1"));
    } finally {
      fake.cleanup();
    }
  });
});

describe("an invalid configuration", () => {
  test("refuses the paid stage: no probe runs and the exit is 2 (review round 48)", async () => {
    const fake = createFakeBinaryEnv({ scode: fakeScodeHelp(), usagemux: fakeUsagemux(), claude: claudeGreen, codemux: fakeCodemux() });
    try {
      probeThrough(fake.env);
      const result = await runDoctor(["--only", "claude", "--spend"], {
        path: fake.env.PATH!,
        home: fixtureHome(claudeHome, homes),
        configError: new Error("quota must be a mapping"),
      });
      expect(result.exitCode).toBe(2);
      expect(readPathMarker(fake.env, "codemux-calls.log")).toBe("");
      expect(result.output).toContain("the paid stage did not run");
    } finally {
      fake.cleanup();
    }
  });
});

describe("an active override and an unreadable native usage row", () => {
  test("the row is OK, not a warning, and --spend probes it without --spend-unreadable (review round 51)", async () => {
    const fake = createFakeBinaryEnv({
      scode: fakeScodeHelp(),
      usagemux: fakeUsagemux({ status: "unavailable", message: "no account" }),
      claude: claudeGreen,
      codemux: fakeCodemux(),
    });
    try {
      probeThrough(fake.env);
      // No --strict: the environment's codexbar row is a warning here (the
      // fake usagemux answers unavailable), and that is not this row's.
      const result = await runDoctor(["--only", "claude", "--spend"], {
        path: fake.env.PATH!,
        home: fixtureHome(claudeHome, homes),
        env: {
          CODEMUX_CLAUDE_PROVIDER_BASE_URL: "https://provider.example/v1",
          CODEMUX_CLAUDE_PROVIDER_API_KEY: "test-key-do-not-print",
          CODEMUX_CLAUDE_PROVIDER_MODEL: "m",
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("| OK |");
      expect(readPathMarker(fake.env, "codemux-calls.log")).toContain("-a claude");
      expect(result.output).not.toContain("test-key-do-not-print");
    } finally {
      fake.cleanup();
    }
  });
});

describe("an active override and an exhausted native window", () => {
  test("--spend still probes the row: the override skips the native gate (review round 57)", async () => {
    const fake = createFakeBinaryEnv({
      scode: fakeScodeHelp(),
      usagemux: fakeUsagemux({ remainingPercent: 0, usedPercent: 100 }),
      claude: claudeGreen,
      codemux: fakeCodemux(),
    });
    try {
      probeThrough(fake.env);
      const result = await runDoctor(["--only", "claude", "--spend"], {
        path: fake.env.PATH!,
        home: fixtureHome(claudeHome, homes),
        env: {
          CODEMUX_CLAUDE_PROVIDER_BASE_URL: "https://provider.example/v1",
          CODEMUX_CLAUDE_PROVIDER_API_KEY: "test-key-do-not-print",
          CODEMUX_CLAUDE_PROVIDER_MODEL: "m",
        },
      });
      expect(result.output).toContain("| OK |");
      expect(readPathMarker(fake.env, "codemux-calls.log")).toContain("-a claude");
    } finally {
      fake.cleanup();
    }
  });
});
