import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

// End-to-end provider overrides: fake harness binaries that actually call the
// override endpoint through a local Bun.serve recorder, driven through the
// spawned CLI. Each case asserts the run replies, exits 0, and that the
// endpoint saw the model and token cap codemux was asked to carry — and that
// the key reached the harness through the environment, never argv.

interface Seen {
  path: string;
  method: string;
  model: string | undefined;
  maxTokens: number | undefined;
  auth: string | null;
  url: string;
}

const seen: Seen[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const body = (await request.json().catch(() => ({}))) as {
      model?: string;
      max_tokens?: number;
      max_output_tokens?: number;
    };
    seen.push({
      path: url.pathname,
      method: request.method,
      model: body.model,
      maxTokens: body.max_tokens ?? body.max_output_tokens,
      auth:
        request.headers.get("authorization") ??
        request.headers.get("x-api-key"),
      url: request.url,
    });
    return new Response("OK");
  },
});
afterAll(() => server.stop(true));
const BASE = `http://127.0.0.1:${server.port}`;
const KEY = "e2e-key-do-not-print";
const MODEL = "clawvm-qwen32b-coder";

describe("provider override end to end", () => {
  test("claude: the gateway env routes the run to the Messages endpoint with the cap", async () => {
    // The fake claude reads ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN and the
    // output cap from its environment, takes the model from its own --model
    // argv, POSTs the request to $ANTHROPIC_BASE_URL/v1/messages, and prints
    // the reply. It also dumps its argv to stderr so the test can prove the
    // key never rode it.
    const fake = createFakeBinaryEnv({
      claude: `
if [ "$1" = "--version" ]; then printf '2.1.270\\n'; exit 0; fi
printf 'ARGV:' >&2; printf ' <%s>' "$@" >&2; printf '\\n' >&2
model=unknown
while [ $# -gt 0 ]; do
  if [ "$1" = "--model" ]; then model="$2"; fi
  shift
done
body=$(printf '{"model":"%s","max_tokens":%s}' "$model" "\${CLAUDE_CODE_MAX_OUTPUT_TOKENS-1024}")
curl -s -X POST "$ANTHROPIC_BASE_URL/v1/messages" \\
  -H "authorization: Bearer $ANTHROPIC_AUTH_TOKEN" \\
  -H "content-type: application/json" \\
  -d "$body"
`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "claude", "-p", "Reply with exactly the word OK"],
        {
          ...fake.env,
          CODEMUX_CLAUDE_PROVIDER_BASE_URL: BASE,
          CODEMUX_CLAUDE_PROVIDER_API_KEY: KEY,
          CODEMUX_CLAUDE_PROVIDER_MODEL: MODEL,
          CODEMUX_CLAUDE_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
        }
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("OK");
      // The endpoint saw the Messages path, the override's model, the cap,
      // and the key as a bearer token.
      const hit = seen.find((entry) => entry.path === "/v1/messages");
      expect(hit).toBeDefined();
      expect(hit!.model).toBe(MODEL);
      expect(hit!.maxTokens).toBe(4096);
      expect(hit!.auth).toBe(`Bearer ${KEY}`);
      // The key rode the environment, never argv.
      expect(stderr).toContain("ARGV:");
      expect(stderr).not.toContain(KEY);
    } finally {
      fake.cleanup();
    }
  });

  test("codex: the private CODEX_HOME's config routes the run to the Responses endpoint", async () => {
    // The fake codex reads CODEX_HOME (delivered through env(1) in argv),
    // parses the config.toml codemux wrote, resolves the env_key against its
    // own environment, and POSTs to $base_url/responses.
    const fake = createFakeBinaryEnv({
      codex: `
if [ "$1" = "--version" ]; then printf 'codex-cli 0.159.3\\n'; exit 0; fi
printf 'ARGV:' >&2; printf ' <%s>' "$@" >&2; printf '\\n' >&2
config="$CODEX_HOME/config.toml"
[ -f "$config" ] || { printf 'no config.toml in CODEX_HOME\\n' >&2; exit 1; }
base=$(sed -n 's/^base_url = "\\(.*\\)"$/\\1/p' "$config")
model=$(sed -n 's/^model = "\\(.*\\)"$/\\1/p' "$config")
keyenv=$(sed -n 's/^env_key = "\\(.*\\)"$/\\1/p' "$config")
ctx=$(sed -n 's/^model_context_window = \\(.*\\)$/\\1/p' "$config")
key=$(eval "printf '%s' \\$$keyenv")
printf 'CODEX_HOME=%s\\nMODEL=%s\\nCTX=%s\\nKEYENV=%s\\n' "$CODEX_HOME" "$model" "\${ctx-absent}" "$keyenv" >&2
curl -s -X POST "$base/responses" \\
  -H "authorization: Bearer $key" \\
  -H "content-type: application/json" \\
  -d "{\\"model\\":\\"$model\\"}"
`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "codex", "-p", "Reply with exactly the word OK"],
        {
          ...fake.env,
          CODEMUX_CODEX_PROVIDER_BASE_URL: `${BASE}/v1`,
          CODEMUX_CODEX_PROVIDER_API_KEY: KEY,
          CODEMUX_CODEX_PROVIDER_MODEL: MODEL,
          CODEMUX_CODEX_PROVIDER_MAX_CONTEXT_TOKENS: "32768",
        }
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("OK");
      const hit = seen.find((entry) => entry.path === "/v1/responses");
      expect(hit).toBeDefined();
      expect(hit!.model).toBe(MODEL);
      expect(hit!.auth).toBe(`Bearer ${KEY}`);
      // The config carried the model, the env-key NAME, and the context cap;
      // the key itself stayed in the environment, and the private home is
      // gone once the run ends.
      expect(stderr).toContain(`MODEL=${MODEL}`);
      expect(stderr).toContain("CTX=32768");
      expect(stderr).toContain("KEYENV=CODEMUX_CODEX_PROVIDER_API_KEY");
      expect(stderr).not.toContain(KEY);
      const home = /CODEX_HOME=(\S+)/.exec(stderr)?.[1]!;
      expect(home).toContain(".codemux-provider");
      expect(existsSync(home)).toBe(false);
      // The model rode the config, never -m.
      expect(stderr).not.toContain("<-m>");
    } finally {
      fake.cleanup();
    }
  });

  test("codex: MULTI_AGENT=off writes features.multi_agent = false; without the knob nothing is written", async () => {
    // The fake codex reports whether the config carried the opt-out (MA=)
    // beside the env-key name, then calls the endpoint as above.
    const fake = createFakeBinaryEnv({
      codex: `
if [ "$1" = "--version" ]; then printf 'codex-cli 0.159.3\\n'; exit 0; fi
printf 'ARGV:' >&2; printf ' <%s>' "$@" >&2; printf '\\n' >&2
config="$CODEX_HOME/config.toml"
[ -f "$config" ] || { printf 'no config.toml in CODEX_HOME\\n' >&2; exit 1; }
base=$(sed -n 's/^base_url = "\\(.*\\)"$/\\1/p' "$config")
model=$(sed -n 's/^model = "\\(.*\\)"$/\\1/p' "$config")
keyenv=$(sed -n 's/^env_key = "\\(.*\\)"$/\\1/p' "$config")
if grep -q '^features.multi_agent = false$' "$config"; then ma=false; else ma=absent; fi
printf 'MA=%s\\nKEYENV=%s\\n' "$ma" "$keyenv" >&2
key=$(eval "printf '%s' \\$$keyenv")
curl -s -X POST "$base/responses" \\
  -H "authorization: Bearer $key" \\
  -H "content-type: application/json" \\
  -d "{\\"model\\":\\"$model\\"}"
`,
    });
    const args = [
      "run", "--no-sandbox", "--auto", "high", "-a", "codex",
      "-p", "Reply with exactly the word OK",
    ];
    const overrideEnv = {
      CODEMUX_CODEX_PROVIDER_BASE_URL: `${BASE}/v1`,
      CODEMUX_CODEX_PROVIDER_API_KEY: KEY,
      CODEMUX_CODEX_PROVIDER_MODEL: MODEL,
    };
    try {
      const off = await runCli(args, {
        ...fake.env,
        ...overrideEnv,
        CODEMUX_CODEX_PROVIDER_MULTI_AGENT: "off",
      });
      expect(off.exitCode).toBe(0);
      expect(off.stdout).toBe("OK");
      expect(off.stderr).toContain("MA=false");
      // Without the knob codex's own default stays in force: no features
      // line is written for the run to lean on.
      const plain = await runCli(args, { ...fake.env, ...overrideEnv });
      expect(plain.exitCode).toBe(0);
      expect(plain.stderr).toContain("MA=absent");
      expect(off.stderr).not.toContain(KEY);
      expect(plain.stderr).not.toContain(KEY);
    } finally {
      fake.cleanup();
    }
  });

  test("codex: the multi-agent knob is rejected for any value but on/off", async () => {
    const fake = createFakeBinaryEnv({
      codex: `
if [ "$1" = "--version" ]; then printf 'codex-cli 0.159.3\\n'; exit 0; fi
exit 3
`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "codex", "-p", "x"],
        {
          ...fake.env,
          CODEMUX_CODEX_PROVIDER_BASE_URL: `${BASE}/v1`,
          CODEMUX_CODEX_PROVIDER_API_KEY: KEY,
          CODEMUX_CODEX_PROVIDER_MODEL: MODEL,
          CODEMUX_CODEX_PROVIDER_MULTI_AGENT: "maybe",
        }
      );
      // Refused before launch: the harness never ran.
      expect(exitCode).not.toBe(0);
      expect(stdout).not.toContain(KEY);
      expect(stderr).toContain('CODEMUX_CODEX_PROVIDER_MULTI_AGENT must be "on" or "off"');
      expect(stderr).not.toContain(KEY);
    } finally {
      fake.cleanup();
    }
  });

  test("codex: the multi-agent knob without an override fails loudly", async () => {
    const fake = createFakeBinaryEnv({
      codex: `
if [ "$1" = "--version" ]; then printf 'codex-cli 0.159.3\\n'; exit 0; fi
exit 3
`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "codex", "-p", "x"],
        { ...fake.env, CODEMUX_CODEX_PROVIDER_MULTI_AGENT: "off" }
      );
      expect(exitCode).not.toBe(0);
      expect(stdout).not.toContain(KEY);
      expect(stderr).toContain(
        "CODEMUX_CODEX_PROVIDER_MULTI_AGENT is set but no provider override is"
      );
      expect(stderr).not.toContain(KEY);
    } finally {
      fake.cleanup();
    }
  });

  test("openhands: the LLM_* trio routes the run with the openai/ prefix", async () => {
    const fake = createFakeBinaryEnv({
      openhands: `
if [ "$1" = "--version" ]; then printf 'OpenHands CLI 1.16.0\\n'; exit 0; fi
printf 'ARGV:' >&2; printf ' <%s>' "$@" >&2; printf '\\n' >&2
curl -s -X POST "$LLM_BASE_URL/chat/completions" \\
  -H "authorization: Bearer $LLM_API_KEY" \\
  -H "content-type: application/json" \\
  -d "{\\"model\\":\\"$LLM_MODEL\\"}"
`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "openhands", "-p", "Reply with exactly the word OK"],
        {
          ...fake.env,
          CODEMUX_OPENHANDS_PROVIDER_BASE_URL: `${BASE}/v1`,
          CODEMUX_OPENHANDS_PROVIDER_API_KEY: KEY,
          CODEMUX_OPENHANDS_PROVIDER_MODEL: MODEL,
        }
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("OK");
      const hit = seen.find((entry) => entry.path === "/v1/chat/completions");
      expect(hit).toBeDefined();
      expect(hit!.model).toBe(`openai/${MODEL}`);
      expect(hit!.auth).toBe(`Bearer ${KEY}`);
      expect(stderr).toContain("ARGV:");
      expect(stderr).not.toContain(KEY);
      // The flag rides whenever a model resolves through the environment.
      expect(stderr).toContain("<--override-with-envs>");
    } finally {
      fake.cleanup();
    }
  });
});
