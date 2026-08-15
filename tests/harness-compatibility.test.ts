import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALLOW_UNTESTED_ENV,
  assertSupportedHarnessVersion,
  compareVersions,
  evaluateHarnessVersion,
  extractHarnessVersion,
  HARNESS_CONTRACTS,
  type HarnessContract,
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
        assertSupportedHarnessVersion("opencode", fake.path, "/tmp", {}, "low", false)
      );
      expect(warnings).toEqual([]);
    } finally {
      fake.cleanup();
    }
  });

  test("a newer version warns but still runs", async () => {
    // Above maxAudited (1.18.18), and at `high` so the recorded break does not
    // apply: the only thing left to report is that it is unaudited.
    const fake = fakeHarness("1.18.19");
    try {
      const warnings = await captureWarnings(() =>
        assertSupportedHarnessVersion("opencode", fake.path, "/tmp", {}, "high", false)
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
        assertSupportedHarnessVersion("opencode", fake.path, "/tmp", {}, "low", false)
      ).rejects.toThrow("cannot enforce low and medium autonomy");
    } finally {
      fake.cleanup();
    }
  });

  test("the override downgrades a refusal to a warning", async () => {
    const fake = fakeHarness("1.18.18");
    try {
      const warnings = await captureWarnings(() =>
        assertSupportedHarnessVersion(
          "opencode",
          fake.path,
          "/tmp",
          { [ALLOW_UNTESTED_ENV]: "1" },
          "low",
          false
        )
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
        assertSupportedHarnessVersion("opencode", fake.path, "/tmp", {}, "high", false)
      );
      expect(warnings.join("\n")).toContain("could not determine");
    } finally {
      fake.cleanup();
    }
  });

  test("an agent with no contract is left alone", async () => {
    const fake = fakeHarness("whatever");
    try {
      const warnings = await captureWarnings(() =>
        assertSupportedHarnessVersion("goose", fake.path, "/tmp", {}, "low", false)
      );
      expect(warnings).toEqual([]);
    } finally {
      fake.cleanup();
    }
  });
});
