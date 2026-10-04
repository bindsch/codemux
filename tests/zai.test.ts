import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
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
    }, "/home/zai-user");
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

describe("Z.AI shares the Claude Code home", () => {
  // The adapter pins no CLAUDE_CONFIG_DIR: a Z.AI run reads and writes the
  // same config store a claude run does, and codemux owns nothing in it.

  test("getEnv points zai at no private config directory", () => {
    const adapter = new ZaiAdapter({ ZAI_API_KEY: "key" });
    expect("CLAUDE_CONFIG_DIR" in adapter.getEnv()).toBe(false);
  });

  test("beforeLaunch touches no state directory", () => {
    withHome((home) => {
      const adapter = new ZaiAdapter({ ZAI_API_KEY: "key" }, home);
      adapter.beforeLaunch();
      // No private directory is created: the shared store is the child's
      // ordinary CLAUDE_CONFIG_DIR (~/.claude), which codemux owns nothing in.
      expect(existsSync(join(home, ".claude-zai"))).toBe(false);
    });
  });

  test("an empty model name falls back to opus for the argv and the envelope alike", () => {
    // The round12 finding: buildRunCommand fell back with `||` and result
    // processing with `??`, so a `model: ""` request would have run
    // `--model opus` while the envelope reported "". validateModelName
    // rejects the empty name on every launch path, so no run reaches the
    // split -- this pins the two fallbacks to one rule anyway.
    const adapter = new ZaiAdapter({ ZAI_API_KEY: "key" });
    const request = {
      agent: "zai" as const,
      prompt: "t",
      model: "",
      resultJson: true,
    };
    const argv = adapter.buildRunCommand(request);
    expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
    const out = adapter.processRunResult(
      {
        stdout:
          JSON.stringify({
            type: "result",
            subtype: "success",
            session_id: null,
            result: "the reply",
          }) + "\n",
        stderr: "",
        exitCode: 0,
        success: true,
      },
      request
    );
    expect(out.success).toBe(true);
    expect(JSON.parse(out.stdout).codemux.model).toBe("opus");
  });

  test("a relative passed-through CLAUDE_CONFIG_DIR is refused", () => {
    // Same rule as the claude adapter: a relative value resolves against
    // the child's working directory, landing the shared config store
    // somewhere --cwd decides, so validation refuses it before launch.
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "relative-profile";
    const adapter = new ZaiAdapter({ ZAI_API_KEY: "key" });
    try {
      expect(() =>
        adapter.validateRunRequest({
          agent: "zai",
          prompt: "t",
          passthroughEnv: ["CLAUDE_CONFIG_DIR"],
        })
      ).toThrow(/CLAUDE_CONFIG_DIR must be an absolute path/);
      expect(() =>
        adapter.validateTuiRequest(undefined, undefined, undefined, undefined, [
          "CLAUDE_CONFIG_DIR",
        ])
      ).toThrow(/CLAUDE_CONFIG_DIR must be an absolute path/);
      // Without the pass-through the value is not the adapter's business.
      expect(() =>
        adapter.validateRunRequest({ agent: "zai", prompt: "t" })
      ).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  test("a whitespace-padded CLAUDE_CONFIG_DIR is refused, not trimmed absolute", () => {
    // Round10 (the claude-family rule, zai twin): validation trimmed the
    // value before the absolute check while the binary reads it without
    // trimming, so a padded value passed validation and still resolved
    // relative against the run's working directory.
    const prev = process.env.CLAUDE_CONFIG_DIR;
    const adapter = new ZaiAdapter({ ZAI_API_KEY: "key" });
    try {
      for (const padded of [" /var/zai-profile", "zai-profile "]) {
        process.env.CLAUDE_CONFIG_DIR = padded;
        expect(() =>
          adapter.validateRunRequest({
            agent: "zai",
            prompt: "t",
            passthroughEnv: ["CLAUDE_CONFIG_DIR"],
          })
        ).toThrow(/CLAUDE_CONFIG_DIR must be an absolute path/);
        expect(() =>
          adapter.validateTuiRequest(undefined, undefined, undefined, undefined, [
            "CLAUDE_CONFIG_DIR",
          ])
        ).toThrow(/CLAUDE_CONFIG_DIR must be an absolute path/);
      }
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});
