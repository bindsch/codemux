import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("forwards scratch accounting requests into sandbox options", () => {
    expect(resolveSandboxOptionsForAgent("codex", "medium", {
      accountFile: "/tmp/trace/account.jsonl",
      accountId: "crew-job-42",
    })).toEqual({
      trust: "standard",
      accountFile: "/tmp/trace/account.jsonl",
      accountId: "crew-job-42",
    });
    expect(resolveSandboxOptionsForAgent("codex", "medium").accountFile).toBeUndefined();
  });

  test("forwards extra block paths into sandbox options", () => {
    expect(resolveSandboxOptionsForAgent("claude", "low", {
      blockPaths: ["/Users/example/secrets"],
    })).toEqual({
      trust: "standard",
      blockPaths: ["/Users/example/secrets"],
    });
    // No override: no blocks, and an empty override list stays absent
    // rather than becoming an empty --block-free spelling.
    expect(resolveSandboxOptionsForAgent("claude", "low").blockPaths).toBeUndefined();
    expect(
      resolveSandboxOptionsForAgent("claude", "low", { blockPaths: [] }).blockPaths
    ).toBeUndefined();
  });

  test("block paths are canonical at the policy boundary, so a symlink cannot be retargeted later (round 29, edges 2)", () => {
    const root = mkdtempSync(join(tmpdir(), "codemux-policy-block-"));
    try {
      const target = join(root, "secrets");
      mkdirSync(target);
      const link = join(root, "link");
      symlinkSync(target, link);
      expect(resolveSandboxOptionsForAgent("claude", "low", { blockPaths: [link] }).blockPaths).toEqual([realpathSync(target)]);
      // A path that does not exist yet is blocked under its deepest existing
      // ancestor's canonical spelling (the temp root is a symlink on macOS).
      expect(resolveSandboxOptionsForAgent("claude", "low", { blockPaths: [join(root, "absent")] }).blockPaths)
        .toEqual([join(realpathSync(root), "absent")]);
      // A relative path is refused: it would resolve against this process's
      // cwd, not the run's (round 34, edges 1).
      expect(() => resolveSandboxOptionsForAgent("claude", "low", { blockPaths: ["secrets"] }))
        .toThrow("--sandbox-block requires absolute paths");
      // A missing leaf under a symlinked parent resolves the parent, so the
      // link cannot be retargeted before scode reads --block (round 30).
      expect(resolveSandboxOptionsForAgent("claude", "low", { blockPaths: [join(link, "later", "file.txt")] }).blockPaths)
        .toEqual([join(realpathSync(target), "later", "file.txt")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("untrusted trust still retains mandatory read-only invariants", () => {
    expect(resolveSandboxOptionsForAgent("codex", "read-only", {
      trust: "untrusted",
    })).toEqual({ trust: "untrusted", fsMode: "ro" });
  });
});
