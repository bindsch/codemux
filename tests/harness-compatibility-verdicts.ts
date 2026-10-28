import { describe, expect, test } from "bun:test";
import {
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

describe("session floors and the audited band", () => {
  const codex = HARNESS_CONTRACTS.codex!;

  test("a session at exactly its floor is supported, never unaudited", () => {
    // Review live10: both harnesses whose floors sit above their run
    // contracts' maxAudited (claude 2.1.280 over 2.1.223, codex 0.159.3
    // over 0.147.0) warned "unaudited" on every session launch — the
    // floor IS the audited build (the release the session wire was
    // recorded on), so the audited ceiling rises with it.
    for (const [agent, contract, floor] of [
      ["claude", claude, "2.1.280"],
      ["codex", codex, "0.159.3"],
    ] as const) {
      const verdict = evaluateHarnessVersion(agent, contract, floor, "high", false, floor);
      expect(verdict.kind).toBe("supported");
      expect(verdict.message).toBeNull();
    }
  });

  test("above the floor still warns, naming the floor as the audited ceiling", () => {
    const verdict = evaluateHarnessVersion(
      "claude",
      claude,
      "2.1.290",
      "high",
      false,
      "2.1.280"
    );
    expect(verdict.kind).toBe("unaudited");
    expect(verdict.message).toContain("newer than the 2.1.280");
    // Below the floor is still a refusal whatever the run contract's
    // maxAudited says — the floor, not the contract, is the session's
    // boundary (2.1.240 sits above 2.1.223 but under the 2.1.280 floor).
    expect(
      evaluateHarnessVersion("claude", claude, "2.1.240", "high", false, "2.1.280").kind
    ).toBe("refuse");
  });

  test("an override below the contract's min lowers nothing", () => {
    // The floor is a raise, never a lower: a bogus 2.1.100 override must
    // not admit the 2.1.150 the run contract refuses, nor shrink the
    // audited band.
    expect(
      evaluateHarnessVersion("claude", claude, "2.1.150", "high", false, "2.1.100").kind
    ).toBe("refuse");
    expect(
      evaluateHarnessVersion("claude", claude, "2.1.223", "high", false, "2.1.100").kind
    ).toBe("supported");
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
