import { describe, expect, test } from "bun:test";
import {
  AGENT_SANDBOX_DEFAULTS,
  hasSandboxPolicyConflicts,
  resolveSandboxOptionsForAgent,
} from "../src/sandbox-policy.js";

describe("sandbox policy", () => {
  test("detects incompatible network and env flags", () => {
    expect(hasSandboxPolicyConflicts({ noNet: true, allowNet: true, scrubEnv: false, keepEnv: false }))
      .toContain("--sandbox-no-net cannot be combined with --sandbox-allow-net");
    expect(hasSandboxPolicyConflicts({ noNet: false, allowNet: false, scrubEnv: true, keepEnv: true }))
      .toContain("--sandbox-scrub-env cannot be combined with --sandbox-keep-env");
  });

  test("maps autonomy to trust when no overrides are set", () => {
    expect(resolveSandboxOptionsForAgent("codex", "read-only")).toEqual({ trust: "untrusted" });
    expect(resolveSandboxOptionsForAgent("codex", "low")).toEqual({ trust: "untrusted" });
    expect(resolveSandboxOptionsForAgent("codex", "high")).toEqual({ trust: "standard" });
  });

  test("uses stricter medium trust for coarse autonomy harnesses", () => {
    expect(resolveSandboxOptionsForAgent("opencode", "medium")).toEqual({ trust: "untrusted" });
    expect(resolveSandboxOptionsForAgent("pi", "medium")).toEqual({ trust: "untrusted" });
    expect(resolveSandboxOptionsForAgent("opencode", "high")).toEqual({ trust: "standard" });
    expect(resolveSandboxOptionsForAgent("pi", "high")).toEqual({ trust: "standard" });
  });

  test("applies explicit policy overrides", () => {
    expect(
      resolveSandboxOptionsForAgent("codex", "medium", {
        trust: "trusted",
        noNet: true,
        scrubEnv: true,
      })
    ).toEqual({
      trust: "trusted",
      noNet: true,
      scrubEnv: true,
    });
  });

  test("allow/keep override stricter flags", () => {
    expect(
      resolveSandboxOptionsForAgent("codex", "medium", {
        noNet: true,
        allowNet: true,
        scrubEnv: true,
        keepEnv: true,
      })
    ).toEqual({
      trust: "standard",
    });
  });

  test("can disable per-agent defaults", () => {
    const original = AGENT_SANDBOX_DEFAULTS.codex;
    AGENT_SANDBOX_DEFAULTS.codex = {
      trustByAutonomy: { high: "trusted" },
      noNet: true,
      scrubEnv: true,
    };

    const withDefaults = resolveSandboxOptionsForAgent("codex", "high");
    const withoutDefaults = resolveSandboxOptionsForAgent("codex", "high", {
      disableAgentDefaults: true,
    });

    AGENT_SANDBOX_DEFAULTS.codex = original;

    expect(withDefaults).toEqual({
      trust: "trusted",
      noNet: true,
      scrubEnv: true,
    });
    expect(withoutDefaults).toEqual({
      trust: "standard",
    });
  });
});
