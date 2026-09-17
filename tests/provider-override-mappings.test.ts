import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiderAdapter } from "../src/adapters/aider.js";
import type { RunRequest } from "../src/types.js";

// How each adapter translates a provider override
// (CODEMUX_<AGENT>_PROVIDER_{BASE_URL,API_KEY,MODEL}) into what the harness
// consumes. The key must travel in the environment or a private file, never
// in argv; assertions check the command carries no key.

const ZAI = {
  CODEMUX_AIDER_PROVIDER_BASE_URL: "https://api.z.ai/api/coding/paas/v4",
  CODEMUX_AIDER_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_AIDER_PROVIDER_MODEL: "glm-5.3",
};

describe("aider provider override", () => {
  const scratch: string[] = [];
  afterEach(() => {
    while (scratch.length > 0) {
      const dir = scratch.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const cwdOf = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-aider-override-"));
    mkdirSync(join(cwd, ".git"));
    scratch.push(cwd);
    return cwd;
  };
  const run = (env: NodeJS.ProcessEnv, request: Partial<RunRequest> = {}): string[] =>
    new AiderAdapter(env).buildRunCommand({
      agent: "aider",
      prompt: "p",
      cwd: cwdOf(),
      ...request,
    } as RunRequest);
  const modelArg = (cmd: string[]): string => cmd[cmd.indexOf("--model") + 1]!;

  test("without an override nothing changes", () => {
    const adapter = new AiderAdapter({});
    expect(adapter.getRunEnv({ agent: "aider", prompt: "p" } as RunRequest)).toEqual({});
    expect(run({})).not.toContain("--model");
  });

  test("the override rides OPENAI_API_BASE/OPENAI_API_KEY and the openai/ model prefix", () => {
    const adapter = new AiderAdapter(ZAI);
    expect(adapter.getRunEnv({ agent: "aider", prompt: "p" } as RunRequest)).toEqual({
      OPENAI_API_KEY: ZAI.CODEMUX_AIDER_PROVIDER_API_KEY,
      OPENAI_API_BASE: ZAI.CODEMUX_AIDER_PROVIDER_BASE_URL,
    });
    const cmd = run(ZAI);
    expect(modelArg(cmd)).toBe("openai/glm-5.3");
    // The key never rides argv.
    expect(cmd.join(" ")).not.toContain(ZAI.CODEMUX_AIDER_PROVIDER_API_KEY);
  });

  test("an explicit --model wins and is prefixed once", () => {
    expect(modelArg(run(ZAI, { model: "glm-5.3-flash" }))).toBe("openai/glm-5.3-flash");
    expect(modelArg(run(ZAI, { model: "openai/glm-5.3" }))).toBe("openai/glm-5.3");
  });

  test("the override survives --hermetic", () => {
    const cmd = run(ZAI, { hermetic: true });
    expect(cmd).toContain("--map-tokens");
    expect(modelArg(cmd)).toBe("openai/glm-5.3");
  });

  test("a keyless override fails validation with the missing name", () => {
    const adapter = new AiderAdapter({
      CODEMUX_AIDER_PROVIDER_BASE_URL: ZAI.CODEMUX_AIDER_PROVIDER_BASE_URL,
      CODEMUX_AIDER_PROVIDER_MODEL: "glm-5.3",
    });
    expect(() =>
      adapter.validateRunRequest({ agent: "aider", prompt: "p", cwd: cwdOf() } as RunRequest)
    ).toThrow("provider override is missing CODEMUX_AIDER_PROVIDER_API_KEY");
  });

  test("an override without any model fails validation", () => {
    const adapter = new AiderAdapter({
      CODEMUX_AIDER_PROVIDER_BASE_URL: ZAI.CODEMUX_AIDER_PROVIDER_BASE_URL,
      CODEMUX_AIDER_PROVIDER_API_KEY: ZAI.CODEMUX_AIDER_PROVIDER_API_KEY,
    });
    expect(() =>
      adapter.validateRunRequest({ agent: "aider", prompt: "p", cwd: cwdOf() } as RunRequest)
    ).toThrow("aider needs a model for the provider override");
  });

  test("the tui command and env carry the same override", () => {
    const adapter = new AiderAdapter(ZAI);
    const cmd = adapter.buildTuiCommand("glm-5.3");
    expect(modelArg(cmd)).toBe("openai/glm-5.3");
    expect(adapter.getTuiEnv()).toEqual({
      OPENAI_API_KEY: ZAI.CODEMUX_AIDER_PROVIDER_API_KEY,
      OPENAI_API_BASE: ZAI.CODEMUX_AIDER_PROVIDER_BASE_URL,
    });
  });
});
