import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GooseAdapter, gooseOpenAiEndpoint } from "../src/adapters/goose.js";
import { UsageRefusalError } from "../src/validation.js";
import type { RunRequest } from "../src/types.js";

// How each adapter translates a provider override
// (CODEMUX_<AGENT>_PROVIDER_{BASE_URL,API_KEY,MODEL}) into what the harness
// consumes. The key must travel in the environment or a private file, never
// in argv; assertions check the command carries no key.

const ZAI_GOOSE = {
  CODEMUX_GOOSE_PROVIDER_BASE_URL: "https://api.z.ai/api/coding/paas/v4",
  CODEMUX_GOOSE_PROVIDER_API_KEY: "test-key-do-not-print",
  CODEMUX_GOOSE_PROVIDER_MODEL: "glm-5.3",
};

describe("goose provider override", () => {
  const scratch: string[] = [];
  afterEach(() => {
    while (scratch.length > 0) {
      const dir = scratch.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const cwdOf = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-goose-override-"));
    mkdirSync(join(cwd, ".git"));
    scratch.push(cwd);
    return cwd;
  };
  const run = (env: NodeJS.ProcessEnv, request: Partial<RunRequest> = {}): string[] =>
    new GooseAdapter(env).buildRunCommand({
      agent: "goose",
      prompt: "p",
      cwd: cwdOf(),
      ...request,
    } as RunRequest);

  test("without an override nothing changes", () => {
    const adapter = new GooseAdapter({});
    expect(adapter.getRunEnv({ agent: "goose", prompt: "p", autonomy: "high" } as RunRequest))
      .toEqual({ GOOSE_MODE: "auto" });
    expect(run({})).toEqual(["goose", "run", "--output-format", "stream-json", "-i", "-"]);
    // An operator model still rides GOOSE_MODEL.
    expect(adapter.getRunEnv({ agent: "goose", prompt: "p", model: "gpt-5.3" } as RunRequest))
      .toEqual({ GOOSE_MODE: "chat", GOOSE_MODEL: "gpt-5.3" });
  });

  test("the override rides the OPENAI_* environment group goose reads first", () => {
    const adapter = new GooseAdapter(ZAI_GOOSE);
    expect(adapter.getRunEnv({ agent: "goose", prompt: "p", autonomy: "high" } as RunRequest))
      .toEqual({
        GOOSE_MODE: "auto",
        GOOSE_PROVIDER: "openai",
        OPENAI_HOST: "https://api.z.ai",
        OPENAI_BASE_PATH: "api/coding/paas/v4/chat/completions",
        OPENAI_API_KEY: ZAI_GOOSE.CODEMUX_GOOSE_PROVIDER_API_KEY,
        GOOSE_MODEL: "glm-5.3",
      });
    const cmd = run(ZAI_GOOSE);
    expect(cmd).toEqual(["goose", "run", "--output-format", "stream-json", "-i", "-"]);
    expect(cmd.join(" ")).not.toContain(ZAI_GOOSE.CODEMUX_GOOSE_PROVIDER_API_KEY);
  });

  test("the endpoint split mirrors goose's own base-path derivation", () => {
    // The Z.AI OpenAI-compatible endpoint: a version segment gains the
    // chat-completions suffix.
    expect(gooseOpenAiEndpoint("https://api.z.ai/api/coding/paas/v4")).toEqual({
      host: "https://api.z.ai",
      basePath: "api/coding/paas/v4/chat/completions",
    });
    expect(gooseOpenAiEndpoint("https://proxy.example")).toEqual({
      host: "https://proxy.example",
      basePath: "v1/chat/completions",
    });
    expect(gooseOpenAiEndpoint("https://proxy.example/v1")).toEqual({
      host: "https://proxy.example",
      basePath: "v1/chat/completions",
    });
    expect(gooseOpenAiEndpoint("https://proxy.example/openai/v1/chat/completions")).toEqual({
      host: "https://proxy.example",
      basePath: "openai/v1/chat/completions",
    });
    expect(gooseOpenAiEndpoint("https://opencode.ai/zen/go")).toEqual({
      host: "https://opencode.ai",
      basePath: "zen/go/v1/chat/completions",
    });
    expect(gooseOpenAiEndpoint("http://localhost:8080")).toEqual({
      host: "http://localhost:8080",
      basePath: "v1/chat/completions",
    });
    // A query string cannot ride the host/path pair goose consumes.
    expect(() => gooseOpenAiEndpoint("https://gw.example/v1?api-version=2024-02-01"))
      .toThrow("cannot map onto goose's OPENAI_HOST/OPENAI_BASE_PATH");
    // Already-complete endpoints stay as they are — the bare path, a
    // versioned one, a nested one, and one with a trailing slash — but
    // only at a segment boundary: "notchat/completions" is not the
    // completions endpoint and gains the suffix (review round 169).
    expect(gooseOpenAiEndpoint("https://h/chat/completions")).toEqual({
      host: "https://h",
      basePath: "chat/completions",
    });
    expect(gooseOpenAiEndpoint("https://h/v1/chat/completions")).toEqual({
      host: "https://h",
      basePath: "v1/chat/completions",
    });
    expect(gooseOpenAiEndpoint("https://h/x/v2/chat/completions/")).toEqual({
      host: "https://h",
      basePath: "x/v2/chat/completions",
    });
    expect(gooseOpenAiEndpoint("https://h/notchat/completions")).toEqual({
      host: "https://h",
      basePath: "notchat/completions/v1/chat/completions",
    });
  });

  test("a query-string base URL refuses at validation with exit 64", () => {
    // The split used to fail only when the launch built its environment,
    // after the quota gate, and as a plain Error (exit 1). Validation
    // refuses the URL first, as the usage error the operator can fix.
    const adapter = new GooseAdapter({
      ...ZAI_GOOSE,
      CODEMUX_GOOSE_PROVIDER_BASE_URL: "https://gw.example/v1?api-version=2024-02-01",
    });
    const request = { agent: "goose" as const, prompt: "p", cwd: cwdOf() };
    expect(() => adapter.validateRunRequest(request as RunRequest))
      .toThrow(UsageRefusalError);
    expect(() => adapter.validateTuiRequest(undefined, cwdOf()))
      .toThrow("cannot map onto goose's OPENAI_HOST/OPENAI_BASE_PATH");
  });

  test("an explicit --model wins as the routed GOOSE_MODEL", () => {
    const adapter = new GooseAdapter(ZAI_GOOSE);
    expect(adapter.getRunEnv({ agent: "goose", prompt: "p", model: "glm-5.3-flash" } as RunRequest))
      .toMatchObject({ GOOSE_MODEL: "glm-5.3-flash" });
  });

  test("the override and --tools none coexist", () => {
    const adapter = new GooseAdapter(ZAI_GOOSE);
    const request = { agent: "goose" as const, prompt: "p", cwd: cwdOf(), tools: "none" as const };
    expect(adapter.buildRunCommand(request as RunRequest))
      .toEqual(["goose", "run", "--no-profile", "--output-format", "stream-json", "-i", "-"]);
    expect(adapter.getRunEnv(request as RunRequest)).toMatchObject({
      OPENAI_API_KEY: ZAI_GOOSE.CODEMUX_GOOSE_PROVIDER_API_KEY,
      GOOSE_MODEL: "glm-5.3",
    });
  });

  test("a keyless override fails validation with the missing name", () => {
    const adapter = new GooseAdapter({
      CODEMUX_GOOSE_PROVIDER_BASE_URL: ZAI_GOOSE.CODEMUX_GOOSE_PROVIDER_BASE_URL,
      CODEMUX_GOOSE_PROVIDER_MODEL: "glm-5.3",
    });
    expect(() => adapter.validateRunRequest({ agent: "goose", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("provider override is missing CODEMUX_GOOSE_PROVIDER_API_KEY");
  });

  test("an override without any model fails validation", () => {
    const adapter = new GooseAdapter({
      CODEMUX_GOOSE_PROVIDER_BASE_URL: ZAI_GOOSE.CODEMUX_GOOSE_PROVIDER_BASE_URL,
      CODEMUX_GOOSE_PROVIDER_API_KEY: ZAI_GOOSE.CODEMUX_GOOSE_PROVIDER_API_KEY,
    });
    expect(() => adapter.validateRunRequest({ agent: "goose", prompt: "p", cwd: cwdOf() } as RunRequest))
      .toThrow("goose needs a model for the provider override");
    expect(() => adapter.validateTuiRequest(undefined, cwdOf()))
      .toThrow("goose needs a model for the provider override");
  });

  test("the tui command and env carry the same override", () => {
    const adapter = new GooseAdapter(ZAI_GOOSE);
    expect(adapter.buildTuiCommand(undefined, "high")).toEqual(["goose"]);
    expect(adapter.getTuiEnv("glm-5.3", "high")).toEqual({
      GOOSE_MODE: "auto",
      GOOSE_PROVIDER: "openai",
      OPENAI_HOST: "https://api.z.ai",
      OPENAI_BASE_PATH: "api/coding/paas/v4/chat/completions",
      OPENAI_API_KEY: ZAI_GOOSE.CODEMUX_GOOSE_PROVIDER_API_KEY,
      GOOSE_MODEL: "glm-5.3",
    });
  });

  test("both token caps ride the config layer's env aliases", () => {
    // GOOSE_MAX_TOKENS and GOOSE_CONTEXT_LIMIT are the per-model
    // max_tokens/context_limit environment aliases (1.50.1 config layer),
    // so a set cap reaches the run; a non-positive value is refused
    // rather than silently uncapped.
    const request = { agent: "goose" as const, prompt: "p", cwd: cwdOf() };
    const outputCap = new GooseAdapter({
      ...ZAI_GOOSE,
      CODEMUX_GOOSE_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
    });
    expect(outputCap.getRunEnv(request as RunRequest)).toMatchObject({
      GOOSE_MAX_TOKENS: "4096",
      GOOSE_MODEL: "glm-5.3",
    });
    expect(() => outputCap.validateRunRequest(request as RunRequest)).not.toThrow();
    const contextCap = new GooseAdapter({
      ...ZAI_GOOSE,
      CODEMUX_GOOSE_PROVIDER_MAX_CONTEXT_TOKENS: "32768",
    });
    expect(contextCap.getRunEnv(request as RunRequest)).toMatchObject({
      GOOSE_CONTEXT_LIMIT: "32768",
    });
    const refused = new GooseAdapter({
      ...ZAI_GOOSE,
      CODEMUX_GOOSE_PROVIDER_MAX_OUTPUT_TOKENS: "0",
    });
    expect(() => refused.getRunEnv(request as RunRequest))
      .toThrow("CODEMUX_GOOSE_PROVIDER_MAX_OUTPUT_TOKENS must be a positive integer");
  });
});
