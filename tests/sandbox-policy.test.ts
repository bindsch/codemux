import { describe, expect, test } from "bun:test";
import { resolveSandboxOptionsForAgent } from "../src/sandbox-policy.js";

describe("sandbox policy", () => {
  test("enforces read-only filesystem modes where the native level is not durable", () => {
    expect(resolveSandboxOptionsForAgent("codex", "read-only"))
      .toEqual({ trust: "standard", fsMode: "ro" });
    expect(resolveSandboxOptionsForAgent("codex", "low"))
      .toEqual({ trust: "standard" });
    expect(resolveSandboxOptionsForAgent("opencode", "read-only"))
      .toEqual({ trust: "standard", fsMode: "ro" });
  });

  test("uses writable standard mode where the normalized level permits writes", () => {
    expect(resolveSandboxOptionsForAgent("codex", "medium"))
      .toEqual({ trust: "standard" });
    expect(resolveSandboxOptionsForAgent("pi", "high"))
      .toEqual({ trust: "standard" });
  });

  test("applies only representable scode policy overrides", () => {
    expect(resolveSandboxOptionsForAgent("codex", "medium", {
      trust: "trusted",
      noNet: true,
      scrubEnv: true,
    })).toEqual({
      trust: "trusted",
      noNet: true,
      scrubEnv: true,
    });
  });

  test("untrusted trust still retains mandatory read-only invariants", () => {
    expect(resolveSandboxOptionsForAgent("codex", "read-only", {
      trust: "untrusted",
    })).toEqual({ trust: "untrusted", fsMode: "ro" });
  });
});
