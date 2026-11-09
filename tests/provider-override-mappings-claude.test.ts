import type { SecretReader } from "../src/credentials.js";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import type { RunRequest } from "../src/types.js";

// How each adapter translates a provider override
// (CODEMUX_<AGENT>_PROVIDER_{BASE_URL,API_KEY,MODEL}) into what the harness
// consumes. The key must travel in the environment or a private file, never
// in argv; assertions check the command carries no key.

const VLLM_CLAUDE = {
  CODEMUX_CLAUDE_PROVIDER_BASE_URL: "http://localhost:8011",
  CODEMUX_CLAUDE_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_CLAUDE_PROVIDER_MODEL: "clawvm-qwen32b-coder",
};

describe("claude provider override", () => {
  const scratch: string[] = [];
  afterEach(() => {
    while (scratch.length > 0) {
      const dir = scratch.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const adapterOf = (env: NodeJS.ProcessEnv = {}): ClaudeAdapter => new ClaudeAdapter(env);

  test("without an override nothing changes", () => {
    const adapter = adapterOf();
    expect(adapter.getEnv()).toEqual({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" });
    expect(adapter.getEnvOmissions()).toEqual([]);
    const cmd = adapter.buildRunCommand({ agent: "claude", prompt: "p" } as RunRequest);
    expect(cmd).not.toContain("--model");
    // The picker mapping is the override's remedy for the client catalog
    // check; a plain run never carries it.
    expect(cmd).not.toContain("--settings");
  });

  test("the override rides the gateway env; the operator login stays out", () => {
    const adapter = adapterOf(VLLM_CLAUDE);
    const model = VLLM_CLAUDE.CODEMUX_CLAUDE_PROVIDER_MODEL;
    expect(adapter.getEnv()).toEqual({
      ANTHROPIC_AUTH_TOKEN: VLLM_CLAUDE.CODEMUX_CLAUDE_PROVIDER_API_KEY,
      ANTHROPIC_BASE_URL: VLLM_CLAUDE.CODEMUX_CLAUDE_PROVIDER_BASE_URL,
      // Every tier Claude Code picks on its own goes to the same model, so
      // background requests and subagents never ask the endpoint for a
      // model it does not serve.
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
    // The token is the credential; a stray operator API key or OAuth token
    // would be a second, operator-funded authentication path.
    expect(adapter.getEnvOmissions()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  test("the model is always explicit: the override's, else --model's", () => {
    const adapter = adapterOf(VLLM_CLAUDE);
    const request: RunRequest = { agent: "claude", prompt: "p" };
    expect(adapter.buildRunCommand(request)).toContain("clawvm-qwen32b-coder");
    const explicit = adapterOf(VLLM_CLAUDE);
    const cmd = explicit.buildRunCommand({
      agent: "claude",
      prompt: "p",
      model: "other-model",
    } as RunRequest);
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("other-model");
  });

  test("an override model carries the modelPicker mapping on --settings", () => {
    // Claude Code 2.1.280 validates --model against its own model catalog
    // before any request leaves the client, and a provider-format id is
    // not in it: the run dies client-side with zero requests reaching the
    // endpoint. The mapping row names the catalog tier the model behaves
    // as, which changes neither the row's label nor the model id sent —
    // the id stays exactly what the endpoint serves.
    const adapter = adapterOf(VLLM_CLAUDE);
    const cmd = adapter.buildRunCommand({ agent: "claude", prompt: "p" } as RunRequest);
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("clawvm-qwen32b-coder");
    const settings = cmd[cmd.indexOf("--settings") + 1] ?? "";
    expect(JSON.parse(settings)).toEqual({
      modelPicker: {
        options: [{ model: "clawvm-qwen32b-coder", behavesAs: "claude-sonnet-5" }],
      },
    });
    // The tui carries the same pair, same as its model fallback.
    const tui = adapter.buildTuiCommand(undefined);
    expect(tui[tui.indexOf("--model") + 1]).toBe("clawvm-qwen32b-coder");
    expect(tui[tui.indexOf("--settings") + 1]).toBe(settings);
    // A request model maps onto itself, not the override's.
    const explicit = adapterOf(VLLM_CLAUDE);
    const other = explicit.buildRunCommand({
      agent: "claude",
      prompt: "p",
      model: "other-model",
    } as RunRequest);
    expect(other[other.indexOf("--settings") + 1]).toBe(
      JSON.stringify({
        modelPicker: { options: [{ model: "other-model", behavesAs: "claude-sonnet-5" }] },
      })
    );
    // No override: a non-catalog explicit model carries the same picker
    // row (audit round 2, A1). The 2.1.280 catalog check rejects provider
    // ids client-side on plain runs too, so the picker rule is one
    // predicate for override and plain launches alike; a catalog alias
    // still carries no --settings.
    const plain = adapterOf().buildRunCommand({
      agent: "claude",
      prompt: "p",
      model: "other-model",
    } as RunRequest);
    expect(plain[plain.indexOf("--settings") + 1]).toBe(
      JSON.stringify({
        modelPicker: { options: [{ model: "other-model", behavesAs: "claude-sonnet-5" }] },
      })
    );
    const alias = adapterOf().buildRunCommand({
      agent: "claude",
      prompt: "p",
      model: "opus",
    } as RunRequest);
    expect(alias).not.toContain("--settings");
  });

  test("--safe-mode keeps the modelPicker mapping: a hermetic override run carries both (al7)", () => {
    // Verified live against Claude Code 2.1.280 (round al7): a --hermetic
    // run under the override launches --safe-mode AND the inline
    // --settings picker row together, and the client honors the row under
    // --safe-mode — the request left the client for the override's
    // endpoint carrying the override's model, with no client-side catalog
    // rejection. This pins the argv pair so a refactor that drops
    // --settings under hermetic fails here instead of launching runs the
    // client would reject.
    const adapter = adapterOf(VLLM_CLAUDE);
    const cmd = adapter.buildRunCommand({
      agent: "claude",
      prompt: "p",
      hermetic: true,
    } as RunRequest);
    expect(cmd).toContain("--safe-mode");
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("clawvm-qwen32b-coder");
    expect(cmd[cmd.indexOf("--settings") + 1]).toBe(
      JSON.stringify({
        modelPicker: {
          options: [{ model: "clawvm-qwen32b-coder", behavesAs: "claude-sonnet-5" }],
        },
      })
    );
    // The tui carries the same pair on every plain launch (--safe-mode is
    // its default); its row is pinned in the test above.
  });

  test("an override without any model fails validation; a keyless override names it", () => {
    const keyless = adapterOf({
      CODEMUX_CLAUDE_PROVIDER_BASE_URL: VLLM_CLAUDE.CODEMUX_CLAUDE_PROVIDER_BASE_URL,
    });
    expect(() => keyless.validateRunRequest({ agent: "claude", prompt: "p" } as RunRequest))
      .toThrow("provider override is missing CODEMUX_CLAUDE_PROVIDER_API_KEY");
    const modelless = adapterOf({
      CODEMUX_CLAUDE_PROVIDER_BASE_URL: VLLM_CLAUDE.CODEMUX_CLAUDE_PROVIDER_BASE_URL,
      CODEMUX_CLAUDE_PROVIDER_API_KEY: VLLM_CLAUDE.CODEMUX_CLAUDE_PROVIDER_API_KEY,
    });
    expect(() => modelless.validateRunRequest({ agent: "claude", prompt: "p" } as RunRequest))
      .toThrow("claude needs a model for the provider override");
    expect(() => modelless.validateTuiRequest(undefined, undefined))
      .toThrow("claude needs a model for the provider override");
  });

  test("the output and context caps ride their CLAUDE_CODE env carriers", () => {
    const adapter = adapterOf({
      ...VLLM_CLAUDE,
      CODEMUX_CLAUDE_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
    });
    expect(adapter.getEnv().CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("4096");
    // Claude Code 2.1.317's window resolver (nA, bundle byte ~256459969)
    // returns CLAUDE_CODE_MAX_CONTEXT_TOKENS for a model its catalog does
    // not name — the override's case — and the unrecognized-model notice
    // tells the operator to set it, so the cap rides the same env view.
    const capped = adapterOf({
      ...VLLM_CLAUDE,
      CODEMUX_CLAUDE_PROVIDER_MAX_CONTEXT_TOKENS: "32768",
    });
    expect(capped.getEnv().CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("32768");
    expect(() => capped.validateRunRequest({ agent: "claude", prompt: "p" } as RunRequest))
      .not.toThrow();
    // And without the caps the env carries only the gateway.
    expect(adapterOf(VLLM_CLAUDE).getEnv()).not.toHaveProperty("CLAUDE_CODE_MAX_OUTPUT_TOKENS");
    expect(adapterOf(VLLM_CLAUDE).getEnv()).not.toHaveProperty("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
  });

  test("the tui carries the override's model fallback, same as a run", () => {
    const adapter = adapterOf(VLLM_CLAUDE);
    expect(adapter.buildTuiCommand("other-model")).toContain("other-model");
    expect(adapter.buildTuiCommand(undefined)).toContain("clawvm-qwen32b-coder");
  });

  test("the sanitizer keeps the gateway env and drops the operator's own login", () => {
    const adapter = adapterOf(VLLM_CLAUDE);
    const saved: [string, string | undefined][] = [
      ["ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY],
      ["CLAUDE_CODE_OAUTH_TOKEN", process.env.CLAUDE_CODE_OAUTH_TOKEN],
    ];
    process.env.ANTHROPIC_API_KEY = "operator-key-do-not-print";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "operator-token-do-not-print";
    try {
      const env = adapter.buildExecutionEnv();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe(VLLM_CLAUDE.CODEMUX_CLAUDE_PROVIDER_API_KEY);
      expect(env.ANTHROPIC_BASE_URL).toBe(VLLM_CLAUDE.CODEMUX_CLAUDE_PROVIDER_BASE_URL);
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("the sandbox sync is skipped under an override; a refresh token refuses only when a Keychain entry owns the login", () => {
    // Nothing of the operator's login may be copied for a run that does not
    // use it: prepareSandbox must not read the Keychain at all. The mirror
    // is still guarded, because the child reads ~/.claude whatever
    // credential it uses.
    const home = mkdtempSync(join(tmpdir(), "codemux-claude-home-"));
    scratch.push(home);
    const mirror = join(home, ".credentials.json");
    writeFileSync(
      mirror,
      JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "" } })
    );
    let keychainReads = 0;
    class TestableClaudeAdapter extends ClaudeAdapter {
      protected override credentialReader: SecretReader = () => {
        keychainReads++;
        return { kind: "missing" };
      };
      protected override credentialTarget = (): string => mirror;
      protected override credentialBackupDir = (): string => home;
    }
    // A plain run syncs an existing mirror, so the Keychain is consulted.
    const noKeychainSync = process.env.CODEMUX_NO_KEYCHAIN_SYNC;
    delete process.env.CODEMUX_NO_KEYCHAIN_SYNC;
    try {
      const plain = new TestableClaudeAdapter({});
      expect(() => plain.prepareSandbox()).not.toThrow();
      expect(keychainReads).toBeGreaterThan(0);

      const override = new TestableClaudeAdapter(VLLM_CLAUDE);
      keychainReads = 0;
      expect(() => override.prepareSandbox()).not.toThrow();
      expect(keychainReads).toBe(0);

      writeFileSync(
        mirror,
        JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "rt" } })
      );
      // No Keychain entry (Linux, a file-only login): the file is Claude
      // Code's only store, the token is normal, the launch proceeds and the
      // file is left alone. Presence was checked, nothing copied.
      expect(() => override.prepareSandbox()).not.toThrow();
      expect(keychainReads).toBe(1);
      expect(readFileSync(mirror, "utf8")).toContain('"rt"');
      // The Keychain opt-out means "do not consult the Keychain" here too:
      // reported, never refused, and no read happens.
      process.env.CODEMUX_NO_KEYCHAIN_SYNC = "1";
      keychainReads = 0;
      expect(() => override.prepareSandbox()).not.toThrow();
      expect(keychainReads).toBe(0);
      delete process.env.CODEMUX_NO_KEYCHAIN_SYNC;
      // A Keychain entry owns the login: the file is a mirror and the
      // token in it is the second copy — refused.
      class MirroredClaudeAdapter extends TestableClaudeAdapter {
        protected override credentialReader: SecretReader = () => ({
          kind: "secret",
          value: JSON.stringify({ claudeAiOauth: { accessToken: "k", refreshToken: "k" } }),
        });
      }
      expect(() => new MirroredClaudeAdapter(VLLM_CLAUDE).prepareSandbox()).toThrow(/holds a refresh token/);
      expect(readFileSync(mirror, "utf8")).toContain('"rt"'); // untouched either way
    } finally {
      if (noKeychainSync !== undefined) process.env.CODEMUX_NO_KEYCHAIN_SYNC = noKeychainSync;
    }
  });
});
