import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenHandsAdapter } from "../src/adapters/openhands.js";
import type { RunRequest } from "../src/types.js";

// How each adapter translates a provider override
// (CODEMUX_<AGENT>_PROVIDER_{BASE_URL,API_KEY,MODEL}) into what the harness
// consumes. The key must travel in the environment or a private file, never
// in argv; assertions check the command carries no key.

const VLLM_OPENHANDS = {
  CODEMUX_OPENHANDS_PROVIDER_BASE_URL: "http://localhost:8011/v1",
  CODEMUX_OPENHANDS_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_OPENHANDS_PROVIDER_MODEL: "clawvm-qwen32b-coder",
};

describe("openhands provider override", () => {
  const scratch: string[] = [];
  afterEach(() => {
    while (scratch.length > 0) {
      const dir = scratch.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const cwdOf = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-openhands-override-"));
    mkdirSync(join(cwd, ".git"));
    scratch.push(cwd);
    return cwd;
  };
  const adapterOf = (env: NodeJS.ProcessEnv = {}): OpenHandsAdapter => new OpenHandsAdapter(env);

  test("without an override nothing changes", () => {
    const adapter = adapterOf();
    expect(adapter.getRunEnv({ agent: "openhands", prompt: "p" } as RunRequest)).toEqual({});
    expect(adapter.buildRunCommand({ agent: "openhands", prompt: "p" } as RunRequest))
      .toEqual(["openhands", "--headless", "--task", "p"]);
  });

  test("the override rides the LLM_* trio with the openai/ prefix and --override-with-envs", () => {
    const adapter = adapterOf(VLLM_OPENHANDS);
    const request: RunRequest = { agent: "openhands", prompt: "p" };
    expect(adapter.getRunEnv(request)).toEqual({
      LLM_BASE_URL: VLLM_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_BASE_URL,
      LLM_API_KEY: VLLM_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_API_KEY,
      LLM_MODEL: "openai/clawvm-qwen32b-coder",
    });
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual([
      "openhands",
      "--headless",
      "--override-with-envs",
      "--task",
      "p",
    ]);
    expect(cmd.join(" ")).not.toContain(VLLM_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_API_KEY);
    // An explicit --model wins and is prefixed once.
    expect(adapter.getRunEnv({ ...request, model: "other-model" } as RunRequest).LLM_MODEL)
      .toBe("openai/other-model");
    expect(adapter.getRunEnv({ ...request, model: "openai/other-model" } as RunRequest).LLM_MODEL)
      .toBe("openai/other-model");
  });

  test("a half-configured override fails validation with the missing name", () => {
    const adapter = adapterOf({
      CODEMUX_OPENHANDS_PROVIDER_BASE_URL: VLLM_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_BASE_URL,
    });
    expect(() => adapter.validateRunRequest({ agent: "openhands", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("provider override is missing CODEMUX_OPENHANDS_PROVIDER_API_KEY");
    const modelless = adapterOf({
      CODEMUX_OPENHANDS_PROVIDER_BASE_URL: VLLM_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_BASE_URL,
      CODEMUX_OPENHANDS_PROVIDER_API_KEY: VLLM_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_API_KEY,
    });
    expect(() => modelless.validateRunRequest({ agent: "openhands", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("openhands needs a model for the provider override");
    expect(() => modelless.validateTuiRequest(undefined, cwdOf()))
      .toThrow("openhands needs a model for the provider override");
  });

  test("both token caps are refused: the env trio is the entire override surface", () => {
    const outputCap = adapterOf({
      ...VLLM_OPENHANDS,
      CODEMUX_OPENHANDS_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
    });
    expect(() =>
      outputCap.validateRunRequest({ agent: "openhands", prompt: "p", cwd: cwdOf() } as RunRequest)
    ).toThrow("CODEMUX_OPENHANDS_PROVIDER_MAX_OUTPUT_TOKENS cannot be honored");
    const contextCap = adapterOf({
      ...VLLM_OPENHANDS,
      CODEMUX_OPENHANDS_PROVIDER_MAX_CONTEXT_TOKENS: "32768",
    });
    expect(() =>
      contextCap.getRunEnv({ agent: "openhands", prompt: "p" } as RunRequest)
    ).toThrow("CODEMUX_OPENHANDS_PROVIDER_MAX_CONTEXT_TOKENS cannot be honored");
  });

  test("the tui command and env carry the same override", () => {
    const adapter = adapterOf(VLLM_OPENHANDS);
    expect(adapter.buildTuiCommand("clawvm-qwen32b-coder"))
      .toEqual(["openhands", "--override-with-envs"]);
    expect(adapter.getTuiEnv()).toEqual({
      LLM_BASE_URL: VLLM_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_BASE_URL,
      LLM_API_KEY: VLLM_OPENHANDS.CODEMUX_OPENHANDS_PROVIDER_API_KEY,
      LLM_MODEL: "openai/clawvm-qwen32b-coder",
    });
  });

  test("an override launch warns that LLM_API_KEY is visible to the model", () => {
    // Round-5 security finding: OpenHands' terminal tool builds the shell's
    // environment from the CLI process's own (both the subprocess and the
    // tmux implementation; its sanitizer strips only SESSION_API_KEY), so
    // the override key reaches any command the model runs. No exclusion
    // channel exists, so every launch that carries an override says so.
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      adapterOf(VLLM_OPENHANDS).beforeLaunch();
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("openhands: provider override active");
      expect(errors[0]).toContain("LLM_API_KEY is visible to the model");
      // Without an override there is nothing to disclose.
      errors.length = 0;
      adapterOf().beforeLaunch();
      expect(errors).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });
});
