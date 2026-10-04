import { describe, expect, test } from "bun:test";
import { sanitizeEnvironment } from "../src/environment.js";
import { AGENT_IDS, type AgentId } from "../src/types.js";

const CREDENTIALS_BY_AGENT = {
  // GOOGLE_APPLICATION_CREDENTIALS is deliberately absent: a live probe
  // (missing and valid-shaped service-account files both) left agy's
  // headless auth path at the identical OAuth browser wall, so the
  // variable has no reader to forward a key to.
  agy: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  aider: [
    "ANTHROPIC_API_KEY",
    "AZURE_API_BASE",
    "AZURE_API_KEY",
    "AZURE_API_VERSION",
    "DEEPSEEK_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GROQ_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
  ],
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  cline: [],
  codex: ["OPENAI_API_KEY"],
  copilot: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
  cursor: ["CURSOR_API_ENDPOINT", "CURSOR_API_KEY"],
  droid: ["FACTORY_API_KEY"],
  goose: [],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  kimi: ["KIMI_API_KEY", "OPENAI_API_KEY"],
  opencode: [],
  openhands: ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"],
  pi: [],
  qwen: ["DASHSCOPE_API_KEY", "OPENAI_API_KEY", "QWEN_API_KEY"],
  zai: ["ANTHROPIC_AUTH_TOKEN"],
} as const satisfies Record<AgentId, readonly string[]>;

describe("environment sanitization", () => {
  test("keeps only credentials required by the selected harness", () => {
    expect(sanitizeEnvironment("claude", {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "required",
      OPENAI_API_KEY: "unrelated",
      AWS_SECRET_ACCESS_KEY: "unrelated",
      DATABASE_URL: "postgres://secret",
      HARMLESS_BUT_UNNEEDED: "removed",
    })).toEqual({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "required",
    });
  });

  test("isolates every adapter credential allowlist", () => {
    const credentialNames = new Set(
      Object.values(CREDENTIALS_BY_AGENT).flat()
    );
    const environment = Object.fromEntries([
      ["PATH", "/bin"],
      ...[...credentialNames].map((name) => [name, `${name}-value`]),
    ]);

    for (const agentId of AGENT_IDS) {
      expect(sanitizeEnvironment(agentId, environment)).toEqual(
        Object.fromEntries([
          ["PATH", "/bin"],
          ...CREDENTIALS_BY_AGENT[agentId].map(
            (name) => [name, `${name}-value`]
          ),
        ])
      );
    }
  });

  test("agy's allowlist does not forward GOOGLE_APPLICATION_CREDENTIALS", () => {
    // The round-2 finding: the variable was allowlisted on the strength of
    // "the Google auth stack reads it" (the ADC function is linked in the
    // binary), but a live probe -- setting it to a missing and then a
    // valid-shaped service-account file -- left agy's headless auth path
    // at the identical OAuth browser wall, so forwarding a service-account
    // key was a claim without a reader.
    expect(sanitizeEnvironment("agy", {
      PATH: "/bin",
      GEMINI_API_KEY: "kept",
      GOOGLE_API_KEY: "kept",
      GOOGLE_APPLICATION_CREDENTIALS: "/home/user/service-account.json",
    })).toEqual({
      PATH: "/bin",
      GEMINI_API_KEY: "kept",
      GOOGLE_API_KEY: "kept",
    });
  });

  test("allows an explicit passthrough without exposing its control variable", () => {
    expect(sanitizeEnvironment("codex", {
      PATH: "/bin",
      INTERNAL_TOKEN: "required-for-task",
      CODEMUX_PASSTHROUGH_ENV: "INTERNAL_TOKEN",
    }, ["INTERNAL_TOKEN"])).toEqual({
      PATH: "/bin",
      INTERNAL_TOKEN: "required-for-task",
    });
  });

  test("never passes runtime loaders, even when explicitly requested", () => {
    expect(sanitizeEnvironment("claude", {
      PATH: "/bin",
      BASH_ENV: "/repo/owned.sh",
      bash_env: "/repo/mixed-case-owned.sh",
      NODE_OPTIONS: "--require=/repo/owned.js",
      Node_Options: "--require=/repo/mixed-case-owned.js",
      PYTHONPATH: "/repo/owned",
      DYLD_INSERT_LIBRARIES: "/repo/owned.dylib",
      AIDER_LOAD: "/repo/commands.txt",
      SCODE_CONFIG: "/repo/weakened.yaml",
      COPILOT_ALLOW_ALL: "1",
      COPILOT_HOME: "/repo/copilot-home",
      GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS: "true",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      CI_JOB_JWT: "secret",
    }, [
      "BASH_ENV",
      "bash_env",
      "NODE_OPTIONS",
      "Node_Options",
      "AIDER_LOAD",
      "SCODE_CONFIG",
      "COPILOT_ALLOW_ALL",
      "COPILOT_HOME",
      "GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS",
    ]))
      .toEqual({ PATH: "/bin" });
  });
});
