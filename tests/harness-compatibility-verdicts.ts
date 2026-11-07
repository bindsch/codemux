import { describe, expect, test } from "bun:test";
import {
  compareVersions,
  describeHarnessBreakage,
  evaluateHarnessVersion,
  extractHarnessVersion,
  HARNESS_CONTRACTS,
  HarnessVersionError,
  parseVersionParts,
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

  test("a version with a part that is not plain digits is not a version (review round 133)", () => {
    // Number("") is 0, so "" and "1..2" used to compare as 0 and 1.0.2.
    for (const malformed of ["", "1..2", ".1", "1.", "1.x", "1e3", "0x10", " 1", "1 ", "+1", "-1", "1.2.-3"]) {
      expect(parseVersionParts(malformed)).toBeNull();
      expect(() => compareVersions(malformed, "1.0.0")).toThrow(HarnessVersionError);
      expect(() => compareVersions("1.0.0", malformed)).toThrow(HarnessVersionError);
    }
    expect(parseVersionParts("0")).toEqual([0]);
    expect(parseVersionParts("2.1.220")).toEqual([2, 1, 220]);
    expect(parseVersionParts("2026.08.11")).toEqual([2026, 8, 11]);
  });

  test("a part longer than a safe integer still compares exactly (review round 134)", () => {
    // 9007199254740993 and 9007199254740992 are one number as a float.
    expect(compareVersions("1.5.9007199254740993", "1.5.9007199254740992")).toBeGreaterThan(0);
    expect(compareVersions("1.5.9007199254740992", "1.5.9007199254740993")).toBeLessThan(0);
    expect(compareVersions("1.5.9007199254740993", "1.5.9007199254740993")).toBe(0);
    expect(compareVersions("1.5.99999999999999999999999999", "1.6")).toBeLessThan(0);
    expect(parseVersionParts("1.5.9007199254740993")).not.toBeNull();
  });

  test("a prerelease orders below its own release, and two prereleases by semver identifiers (round 259)", () => {
    // The probe patterns' numeric-prefix capture used to strip the suffix,
    // so `1.18.10-beta.1` passed the `1.18.10` minimum. Semver orders a
    // prerelease below its release; the comparison now carries that.
    expect(compareVersions("1.18.10-beta.1", "1.18.10")).toBeLessThan(0);
    expect(compareVersions("1.18.10", "1.18.10-beta.1")).toBeGreaterThan(0);
    expect(compareVersions("1.18.10-beta.1", "1.18.10")).not.toBe(0);
    // The numeric core still decides first: a prerelease of a HIGHER
    // release is above the lower release, and of a lower one below.
    expect(compareVersions("1.18.11-beta.1", "1.18.10")).toBeGreaterThan(0);
    expect(compareVersions("1.18.9-rc.1", "1.18.10")).toBeLessThan(0);
    // Identifier rules: numeric identifiers numerically (and exactly),
    // numeric below alphanumeric, alphanumeric lexically, fewer fields
    // below more (semver §11.4's own example order).
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha.beta", "1.0.0-beta")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta", "1.0.0-beta.2")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.11")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.11", "1.0.0-rc.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-2", "1.0.0-10")).toBeLessThan(0);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0-beta.1")).toBe(0);
    // A malformed suffix is still not a version, and the numeric core of a
    // prerelease still parses for the kimi major-version read.
    for (const malformed of ["1.0.0-", "1.0.0-beta.", "1.0.0-beta..1"]) {
      expect(parseVersionParts(malformed), malformed).toBeNull();
      expect(() => compareVersions(malformed, "1.0.0"), malformed).toThrow(HarnessVersionError);
    }
    expect(parseVersionParts("2.5.0-beta.1")).toEqual([2, 5, 0]);
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

  test("keeps a semver prerelease suffix in the extracted version, so the gate sees it (round 259)", () => {
    // The regression end to end: the probe output carries the prerelease,
    // extraction keeps it, and the floor refuses the prerelease of the
    // minimum. Before round 259 extraction answered `1.18.10` — the
    // minimum itself, passing as supported.
    const version = extractHarnessVersion(opencode, "1.18.10-beta.1");
    expect(version).toBe("1.18.10-beta.1");
    const verdict = evaluateHarnessVersion("opencode", opencode, version!, "low", false);
    expect(verdict.kind).toBe("refuse");
    expect(verdict.reason).toBe("below-minimum");
    // A prerelease of a release ABOVE the floor stays inside the audited
    // band, and one past the ceiling stays above it: the core decides
    // against the boundaries exactly as a release does.
    expect(evaluateHarnessVersion("opencode", opencode, "1.18.11-beta.1", "low", false).kind).not.toBe("refuse");
    expect(evaluateHarnessVersion("opencode", opencode, "1.19.6-rc.1", "low", true).reason).toBe("unaudited");
  });

  test("returns null when the output does not carry a version", () => {
    expect(extractHarnessVersion(opencode, "command not found")).toBeNull();
  });
});

describe("three-tier verdicts", () => {
  test("an audited version runs silently", () => {
    const verdict = evaluateHarnessVersion("claude", claude, "2.1.223");
    expect(verdict.kind).toBe("supported");
    expect(verdict.reason).toBe("supported");
    expect(verdict.message).toBeNull();
  });

  test("a version below the floor is refused", () => {
    const verdict = evaluateHarnessVersion("claude", claude, "2.1.100");
    expect(verdict.kind).toBe("refuse");
    expect(verdict.reason).toBe("below-minimum");
    expect(verdict.message).toContain("older than");
  });

  test("a newer version warns instead of blocking", () => {
    // The usability rule: upstream ships patches that change nothing, and
    // refusing them all would make Codemux unusable.
    const verdict = evaluateHarnessVersion("claude", claude, "2.1.999");
    expect(verdict.kind).toBe("unaudited");
    expect(verdict.reason).toBe("unaudited");
    expect(verdict.message).toContain("newer than");
  });
});

describe("verdict reasons separate the two refusals", () => {
  // Doctor once mapped every `refuse` to "below minimum", so opencode
  // 1.18.18 — above the minimum, refused by a scoped break — printed a
  // false label. The reason field is the fix; report surfaces read it,
  // never the message text.
  test("a breakage refusal is a breakage whatever the autonomy", () => {
    const withoutAutonomy = evaluateHarnessVersion("opencode", opencode, "1.18.18");
    expect(withoutAutonomy.kind).toBe("refuse");
    expect(withoutAutonomy.reason).toBe("breakage");
    expect(withoutAutonomy.breakage).toBeDefined();
    const scoped = evaluateHarnessVersion("opencode", opencode, "1.18.18", "low");
    expect(scoped.reason).toBe("breakage");
  });

  test("the breakage label names the levels and the mitigation", () => {
    const verdict = evaluateHarnessVersion("opencode", opencode, "1.18.18");
    const label = describeHarnessBreakage(verdict.breakage!);
    expect(label.startsWith("known break at low and medium autonomy from 1.18.18 (sandbox mitigates): ")).toBe(true);
    expect(label).toContain("no longer gates writes or execution");
  });

  test("an unmitigated break says so", () => {
    const label = describeHarnessBreakage({
      from: "0.9.0", note: "auto-approve ignores its flag",
      affects: ["high"], mitigatedBySandbox: false,
    });
    expect(label).toBe(
      "known break at high autonomy from 0.9.0 (no mitigation): auto-approve ignores its flag"
    );
  });
});

describe("session floors and the audited band", () => {
  const codex = HARNESS_CONTRACTS.codex!;

  test("a session at exactly its floor is supported, never unaudited", () => {
    // Review live10: both harnesses whose floors sit above their run
    // contracts' maxAudited at the time (claude 2.1.280 over 2.1.223, codex
    // 0.159.3 over 0.147.0; both ceilings rose on 2026-11-02) warned
    // "unaudited" on every session launch — the
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

  test("above the audited band still warns, naming the higher of floor and ceiling", () => {
    // The session floor (2.1.280) sits inside the run contract's audited
    // band since the live gates raised the ceiling (2.1.317 on 2026-11-06), so
    // the band's top is the ceiling; a floor above the ceiling would be
    // named instead (the override raises both, never lowers either).
    const verdict = evaluateHarnessVersion(
      "claude",
      claude,
      "2.1.320",
      "high",
      false,
      "2.1.280"
    );
    expect(verdict.kind).toBe("unaudited");
    expect(verdict.message).toContain("newer than the 2.1.317");
    expect(evaluateHarnessVersion("claude", claude, "2.1.290", "high", false, "2.1.280").kind).toBe("supported");
    // Below the floor is still a refusal whatever the run contract's
    // maxAudited says — the floor, not the contract, is the session's
    // boundary (2.1.240 sits above the 2.1.220 minimum but under the 2.1.280 floor).
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
