import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZaiAdapter } from "../src/adapters/zai.js";

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "codemux-zai-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("Z.AI credential handling", () => {
  test("reads a private regular key file", () => {
    withHome((home) => {
      const keyPath = join(home, ".zai");
      writeFileSync(keyPath, "file-key\n", { mode: 0o600 });
      const env = new ZaiAdapter({}, home).getEnv();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("file-key");
    });
  });

  test("rejects group/world-readable key files", () => {
    if (process.platform === "win32") return;
    withHome((home) => {
      const keyPath = join(home, ".zai");
      writeFileSync(keyPath, "file-key\n", { mode: 0o600 });
      chmodSync(keyPath, 0o644);
      expect(() => new ZaiAdapter({}, home).getEnv()).toThrow(
        "permissions must be 0600 or stricter"
      );
    });
  });

  test("fails descriptively when no credential exists", () => {
    withHome((home) => {
      expect(() => new ZaiAdapter({}, home).getEnv()).toThrow("Z.AI API key not found");
    });
  });

  test("rejects multiline and NUL-bearing credential files", () => {
    withHome((home) => {
      const keyPath = join(home, ".zai");
      writeFileSync(keyPath, "first\nsecond\n", { mode: 0o600 });
      expect(() => new ZaiAdapter({}, home).getEnv()).toThrow(
        "must contain exactly one credential line"
      );
      writeFileSync(keyPath, "first\0second", { mode: 0o600 });
      expect(() => new ZaiAdapter({}, home).getEnv()).toThrow(
        "must contain exactly one credential line"
      );
    });
  });

  test("rejects empty and symlinked credential files", () => {
    withHome((home) => {
      const keyPath = join(home, ".zai");
      writeFileSync(keyPath, " \n", { mode: 0o600 });
      expect(() => new ZaiAdapter({}, home).getEnv()).toThrow("is empty");

      if (process.platform === "win32") return;
      rmSync(keyPath);
      const target = join(home, "key-target");
      writeFileSync(target, "file-key", { mode: 0o600 });
      symlinkSync(target, keyPath);
      expect(() => new ZaiAdapter({}, home).getEnv()).toThrow(
        "must not be a symbolic link"
      );
    });
  });

  test("environment credential takes precedence and source secrets are omitted", () => {
    const adapter = new ZaiAdapter({
      ZAI_API_KEY: " env-key ",
      API_TIMEOUT_MS: "1234",
    });
    expect(adapter.getEnv()).toEqual({
      ANTHROPIC_AUTH_TOKEN: "env-key",
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      API_TIMEOUT_MS: "1234",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
    expect(adapter.getEnvOmissions()).toEqual([
      "ZAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
  });

  test("validates environment credentials and API timeout", () => {
    expect(() => new ZaiAdapter({ ZAI_API_KEY: "one\ntwo" }).getEnv())
      .toThrow("must contain exactly one credential line");
    expect(() => new ZaiAdapter({
      ZAI_API_KEY: "key",
      API_TIMEOUT_MS: "forever",
    }).getEnv()).toThrow("must be a positive integer");
    expect(() => new ZaiAdapter({
      ZAI_API_KEY: "key",
      API_TIMEOUT_MS: "999999999999",
    }).getEnv()).toThrow("must be between");
  });
});
