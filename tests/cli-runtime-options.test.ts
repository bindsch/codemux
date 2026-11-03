import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAutonomyOption,
  parseEffortOption,
  parsePassthroughEnvOption,
  parseSandboxPolicyOverrides,
  parseTimeoutOption,
  resolveAutonomyForAdapter,
  resolveEffortForAdapter,
} from "../src/cli-runtime.js";
import { getAdapter } from "../src/adapters/index.js";
import { AGENT_IDS } from "../src/types.js";
import type { AdapterCapabilities } from "../src/types.js";

const fullCapabilities: AdapterCapabilities = {
  supportsNonInteractive: true,
  supportsInteractive: true,
  supportsModel: true,
  supportsAutonomy: true,
  autonomyLevels: ["read-only", "low", "medium", "high"],
  supportsEffort: true,
  effortLevels: ["none", "low", "medium", "high"],
};

describe("CLI runtime option parsing", () => {
  test("parses valid normalized options and explicit environment grants", () => {
    expect(parseAutonomyOption(undefined)).toBeUndefined();
    expect(parseAutonomyOption("low")).toBe("low");
    expect(parseEffortOption(undefined)).toBeUndefined();
    expect(parseEffortOption("none")).toBe("none");
    expect(parsePassthroughEnvOption()).toEqual([]);
    expect(parsePassthroughEnvOption("TOKEN_A, TOKEN_B,TOKEN_A"))
      .toEqual(["TOKEN_A", "TOKEN_B"]);
    expect(() => parsePassthroughEnvOption("NOT-VALID"))
      .toThrow("invalid environment variable name");
    expect(() => parsePassthroughEnvOption(""))
      .toThrow("--pass-env requires 1 to");
    expect(() => parsePassthroughEnvOption(
      Array.from({ length: 65 }, (_, index) => `TOKEN_${index}`).join(",")
    )).toThrow("--pass-env requires 1 to 64");
    expect(parseTimeoutOption("0.001")).toBe(1);
    expect(parseTimeoutOption("60")).toBe(60_000);
    expect(() => parseTimeoutOption("0")).toThrow("--timeout must be a number");
    expect(() => parseTimeoutOption("Infinity")).toThrow(
      "--timeout must be a number"
    );
    for (const value of ["-1", "not-a-number", "86400.1"]) {
      expect(() => parseTimeoutOption(value)).toThrow(
        "--timeout must be a number"
      );
    }
  });

  test("resolves supported levels and fails closed for unsupported semantics", () => {
    expect(resolveAutonomyForAdapter("claude", fullCapabilities, "medium"))
      .toBe("medium");
    expect(resolveEffortForAdapter("claude", fullCapabilities, "high"))
      .toBe("high");
    expect(resolveEffortForAdapter("gemini", {
      ...fullCapabilities,
      supportsEffort: false,
      effortLevels: [],
    }, "none")).toBeUndefined();
    expect(() => resolveEffortForAdapter("gemini", {
      ...fullCapabilities,
      supportsEffort: false,
      effortLevels: [],
    }, "high")).toThrow("does not support reasoning effort");
    expect(() => resolveAutonomyForAdapter("claude", {
      ...fullCapabilities,
      supportsAutonomy: false,
      autonomyLevels: [],
    }, "read-only")).toThrow("cannot enforce requested autonomy");
    expect(() => resolveAutonomyForAdapter("claude", {
      ...fullCapabilities,
      autonomyLevels: ["high"],
    }, "read-only")).toThrow("does not support autonomy level");
  });

  test("--effort none resolves on every adapter, and adds no effort flag where none is not native", () => {
    // One rule (docs/cli.md): `none` is the CLI's "send no effort flag"
    // spelling. The regression: claude, agy, and opencode — effort-capable
    // adapters whose level lists omit `none` — refused it with exit 64,
    // and codex run sent `-c model_reasoning_effort="none"` while a codex
    // session refused the same spelling.
    for (const id of AGENT_IDS) {
      const caps = getAdapter(id).capabilities();
      const resolved = resolveEffortForAdapter(id, caps, "none");
      if (caps.effortLevels.includes("none")) {
        expect(resolved).toBe("none");
      } else {
        expect(resolved).toBeUndefined();
      }
    }
    // The adapters that refused `none` now launch with no effort flag.
    for (const id of ["claude", "agy", "opencode"] as const) {
      const cmd = getAdapter(id).buildRunCommand({ agent: id, prompt: "x" });
      expect(cmd.includes("--effort")).toBe(false);
    }
    // Codex's config-override carrier cannot ride an undefined effort.
    expect(getAdapter("codex").capabilities().effortLevels.includes("none")).toBe(false);
  });

  test("parses sandbox policy and reports flags without sandbox", () => {
    expect(parseSandboxPolicyOverrides({
      sandbox: true,
      sandboxTrust: "trusted",
      sandboxNoNet: true,
    })).toEqual({
      trust: "trusted",
      noNet: true,
      scrubEnv: false,
    });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => warnings.push(String(message));
    try {
      expect(parseSandboxPolicyOverrides({
        sandbox: false,
        sandboxNoNet: true,
      })).toBeUndefined();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.join("\n")).toContain("require --sandbox");
  });

  test("canonicalizes --sandbox-block paths at the flag boundary (round 19, edges 1)", () => {
    // The caller's spelling must not survive into the enforced block
    // list: scode dereferences a symlink at block time, so a raw spelling
    // means a retargeted symlink makes later children block the new
    // target. The parse returns the dereferenced, deduplicated, sorted
    // paths every consumer downstream shares.
    const dir = mkdtempSync(join(tmpdir(), "codemux-block-canonical-"));
    try {
      const target = join(dir, "tree");
      mkdirSync(target);
      const link = join(dir, "link");
      symlinkSync(target, link);
      const overrides = parseSandboxPolicyOverrides({
        sandbox: true,
        sandboxBlock: [link, target, join(dir, "missing", "tail")],
      });
      expect(overrides?.blockPaths).toEqual([
        join(realpathSync(dir), "missing", "tail"),
        realpathSync(target),
      ]);
      // Without --sandbox the flags are ignored with a warning, so an
      // unresolvable spelling must not refuse there.
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (message?: unknown) => warnings.push(String(message));
      try {
        expect(parseSandboxPolicyOverrides({
          sandbox: false,
          sandboxBlock: [join(dir, "loop")],
        })).toBeUndefined();
      } finally {
        console.warn = originalWarn;
      }
      expect(warnings.join("\n")).toContain("require --sandbox");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a relative --sandbox-account path outright", () => {
    expect(() => parseSandboxPolicyOverrides({
      sandbox: true,
      sandboxAccount: "relative/account.jsonl",
    })).toThrow("absolute path");
    expect(() => parseSandboxPolicyOverrides({
      sandbox: false,
      sandboxAccount: "relative/account.jsonl",
    })).toThrow("absolute path");
    // An explicitly empty value is not an absolute path either; the guard
    // tests for undefined, not truthiness, so "" cannot slip through.
    expect(() => parseSandboxPolicyOverrides({
      sandbox: true,
      sandboxAccount: "",
    })).toThrow("absolute path");
  });

  test("rejects account ids outside scode's accepted set", () => {
    // scode drops any id carrying characters outside [A-Za-z0-9._:-] to
    // null; refusing here beats discovering unjoinable records later.
    expect(() => parseSandboxPolicyOverrides({
      sandbox: true,
      sandboxAccount: "/tmp/account.jsonl",
      sandboxAccountId: "crew/job-42",
    })).toThrow("silently break correlation");
    expect(() => parseSandboxPolicyOverrides({
      sandbox: true,
      sandboxAccount: "/tmp/account.jsonl",
      sandboxAccountId: "",
    })).toThrow("1-128 characters");
  });

  test("rejects an account id without a sink", () => {
    expect(() => parseSandboxPolicyOverrides({
      sandbox: true,
      sandboxAccountId: "crew-job-42",
    })).toThrow("without --sandbox-account");
  });

  test("parses --sandbox-block and rejects relative or NUL paths", () => {
    expect(parseSandboxPolicyOverrides({
      sandbox: true,
      sandboxBlock: ["/Users/example/secrets", "/Users/example/other"],
    })).toEqual({
      trust: undefined,
      noNet: false,
      scrubEnv: false,
      accountFile: undefined,
      accountId: undefined,
      // Canonicalized (dereferenced where they resolve, then sorted): the
      // missing /Users/example tree keeps its spelling, but the list is
      // sorted by the canonical form (round 19, edges 1).
      blockPaths: ["/Users/example/other", "/Users/example/secrets"],
    });
    // A relative path would deny the wrong tree: scode resolves it
    // against its own working directory.
    expect(() => parseSandboxPolicyOverrides({
      sandbox: true,
      sandboxBlock: ["relative/path"],
    })).toThrow("--sandbox-block requires absolute paths");
    // A NUL byte cannot survive real argv, but the parser runs before
    // anything execs, so it refuses the spelling too.
    expect(() => parseSandboxPolicyOverrides({
      sandbox: true,
      sandboxBlock: ["/abs/path\0"],
    })).toThrow("--sandbox-block requires absolute paths");
    // Without --sandbox the extra blocks warn and drop like the other
    // policy flags, not an error: an empty list is not a policy at all.
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => warnings.push(String(message));
    try {
      expect(parseSandboxPolicyOverrides({
        sandbox: false,
        sandboxBlock: ["/Users/example/secrets"],
      })).toBeUndefined();
      expect(parseSandboxPolicyOverrides({
        sandbox: false,
        sandboxBlock: [],
      })).toBeUndefined();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.join("\n")).toContain("require --sandbox");
  });
});
