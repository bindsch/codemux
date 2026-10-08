import { describe, expect, test } from "bun:test";
import {
  assertProviderCap,
  providerIdentityBaseUrl,
  providerOverrideEnvNames,
  readProviderOverride,
  requireProviderOverride,
} from "../src/provider-override.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { getAdapter } from "../src/adapters/index.js";
import type { RunRequest } from "../src/types.js";

describe("provider override: environment names", () => {
  test("names are derived from the agent id", () => {
    expect(providerOverrideEnvNames("aider")).toEqual({
      baseUrl: "CODEMUX_AIDER_PROVIDER_BASE_URL",
      apiKey: "CODEMUX_AIDER_PROVIDER_API_KEY",
      model: "CODEMUX_AIDER_PROVIDER_MODEL",
      maxOutputTokens: "CODEMUX_AIDER_PROVIDER_MAX_OUTPUT_TOKENS",
      maxContextTokens: "CODEMUX_AIDER_PROVIDER_MAX_CONTEXT_TOKENS",
    });
    expect(providerOverrideEnvNames("opencode").apiKey).toBe(
      "CODEMUX_OPENCODE_PROVIDER_API_KEY"
    );
    expect(providerOverrideEnvNames("codex").maxContextTokens).toBe(
      "CODEMUX_CODEX_PROVIDER_MAX_CONTEXT_TOKENS"
    );
  });
});

describe("provider override: reading", () => {
  test("absent names give null", () => {
    expect(readProviderOverride("aider", {})).toBeNull();
  });

  test("blank values count as unset", () => {
    expect(
      readProviderOverride("goose", {
        CODEMUX_GOOSE_PROVIDER_BASE_URL: "  ",
        CODEMUX_GOOSE_PROVIDER_API_KEY: "",
      })
    ).toBeNull();
  });

  test("a full override round-trips trimmed", () => {
    expect(
      readProviderOverride("goose", {
        CODEMUX_GOOSE_PROVIDER_BASE_URL: " https://api.z.ai/api/coding/paas/v4 ",
        CODEMUX_GOOSE_PROVIDER_API_KEY: " k-1 ",
        CODEMUX_GOOSE_PROVIDER_MODEL: " glm-5.3 ",
      })
    ).toEqual({
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      apiKey: "k-1",
      model: "glm-5.3",
    });
  });

  test("a partial override is readable; requirement is the adapter's", () => {
    expect(
      readProviderOverride("pi", { CODEMUX_PI_PROVIDER_API_KEY: "k-1" })
    ).toEqual({ apiKey: "k-1" });
  });

  test("caps round-trip with the override, trimmed like the rest", () => {
    expect(
      readProviderOverride("kimi", {
        CODEMUX_KIMI_PROVIDER_BASE_URL: "http://localhost:8011/v1",
        CODEMUX_KIMI_PROVIDER_API_KEY: "k-1",
        CODEMUX_KIMI_PROVIDER_MODEL: "clawvm-qwen32b-coder",
        CODEMUX_KIMI_PROVIDER_MAX_OUTPUT_TOKENS: " 4096 ",
        CODEMUX_KIMI_PROVIDER_MAX_CONTEXT_TOKENS: "32768",
      })
    ).toEqual({
      baseUrl: "http://localhost:8011/v1",
      apiKey: "k-1",
      model: "clawvm-qwen32b-coder",
      maxOutputTokens: 4096,
      maxContextTokens: 32768,
    });
  });

  test("a cap alone is refused, not treated as an override", () => {
    // A cap sizes a provider the override names; without one it would sit
    // silently on the harness's native provider.
    expect(() =>
      readProviderOverride("goose", {
        CODEMUX_GOOSE_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
      })
    ).toThrow(
      "CODEMUX_GOOSE_PROVIDER_MAX_OUTPUT_TOKENS is set but no provider override is; " +
        "a token cap applies only to a provider override, so also set " +
        "CODEMUX_GOOSE_PROVIDER_BASE_URL, CODEMUX_GOOSE_PROVIDER_API_KEY and CODEMUX_GOOSE_PROVIDER_MODEL"
    );
    expect(() =>
      readProviderOverride("aider", {
        CODEMUX_AIDER_PROVIDER_MAX_CONTEXT_TOKENS: "32768",
      })
    ).toThrow(
      "CODEMUX_AIDER_PROVIDER_MAX_CONTEXT_TOKENS is set but no provider override is"
    );
  });

  const capCases: [string, Record<string, string>][] = [
    ["non-numeric", { CODEMUX_KIMI_PROVIDER_MAX_OUTPUT_TOKENS: "lots" }],
    ["signed", { CODEMUX_KIMI_PROVIDER_MAX_OUTPUT_TOKENS: "-1" }],
    ["zero", { CODEMUX_KIMI_PROVIDER_MAX_OUTPUT_TOKENS: "0" }],
    ["decimal", { CODEMUX_KIMI_PROVIDER_MAX_CONTEXT_TOKENS: "1.5" }],
    ["exponent", { CODEMUX_KIMI_PROVIDER_MAX_CONTEXT_TOKENS: "1e6" }],
  ];
  for (const [name, env] of capCases) {
    test(`a cap that is not a positive integer is refused (${name})`, () => {
      expect(() =>
        readProviderOverride("kimi", {
          CODEMUX_KIMI_PROVIDER_BASE_URL: "http://localhost:8011/v1",
          ...env,
        })
      ).toThrow(/must be a positive integer number of tokens/);
    });
  }

  test("a blank cap counts as unset", () => {
    expect(
      readProviderOverride("kimi", {
        CODEMUX_KIMI_PROVIDER_BASE_URL: "http://localhost:8011/v1",
        CODEMUX_KIMI_PROVIDER_MAX_OUTPUT_TOKENS: "  ",
      })
    ).toEqual({ baseUrl: "http://localhost:8011/v1" });
  });
});

describe("provider override: cap support", () => {  test("a supported cap passes", () => {
    const override = readProviderOverride("pi", {
      CODEMUX_PI_PROVIDER_BASE_URL: "http://localhost:8011/v1",
      CODEMUX_PI_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
    })!;
    expect(() =>
      assertProviderCap("pi", override, "maxOutputTokens", true)
    ).not.toThrow();
  });

  test("an unsupported cap fails loudly with its evidence", () => {
    const override = readProviderOverride("codex", {
      CODEMUX_CODEX_PROVIDER_BASE_URL: "http://localhost:8011/v1",
      CODEMUX_CODEX_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
    })!;
    expect(() =>
      assertProviderCap("codex", override, "maxOutputTokens", "no key exists")
    ).toThrow(
      "CODEMUX_CODEX_PROVIDER_MAX_OUTPUT_TOKENS cannot be honored: no key exists"
    );
  });

  test("no override or no cap means no refusal", () => {
    expect(() =>
      assertProviderCap("codex", null, "maxOutputTokens", "no key exists")
    ).not.toThrow();
    const override = readProviderOverride("codex", {
      CODEMUX_CODEX_PROVIDER_BASE_URL: "http://localhost:8011/v1",
    })!;
    expect(() =>
      assertProviderCap("codex", override, "maxOutputTokens", "no key exists")
    ).not.toThrow();
  });
});

describe("provider override: unsupported harnesses", () => {
  // The refusal reads the adapter's environment view (the base validator's
  // seam, forwarded from the constructor), so the launch direction drives
  // process.env directly and restores it, and the verify direction builds
  // against an explicit empty view.
  const withEnv = (vars: Record<string, string>, body: () => void): void => {
    const saved: [string, string | undefined][] = [];
    for (const [name, value] of Object.entries(vars)) {
      saved.push([name, process.env[name]]);
      process.env[name] = value;
    }
    try {
      body();
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };

  const zaiOverride: Record<string, string> = {
    CODEMUX_ZAI_PROVIDER_BASE_URL: "http://localhost:8011",
    CODEMUX_ZAI_PROVIDER_API_KEY: "k",
    CODEMUX_ZAI_PROVIDER_MODEL: "m",
  };

  test("an override set for a harness without support fails the run loudly", () => {
    withEnv(zaiOverride, () => {
      expect(() =>
        getAdapter("zai").validateRunRequest({ agent: "zai", prompt: "p" } as RunRequest)
      ).toThrow("zai does not support a provider override");
      expect(() => getAdapter("zai").validateTuiRequest(undefined, undefined))
        .toThrow("zai does not support a provider override");
    });
  });

  test("an explicit environment view hides the refusal (verify's contract)", () => {
    // Round-5 regression: the base check read process.env directly, so the
    // exported trio made `codemux verify` FAIL zai ("run command generation
    // failed: zai does not support a provider override") although verify
    // builds its adapters against an explicitly empty view. The refusal
    // must read the adapter's own view: the empty view hides the override,
    // the launch view above still refuses it.
    withEnv(zaiOverride, () => {
      expect(() =>
        getAdapter("zai", {}).validateRunRequest({ agent: "zai", prompt: "p" } as RunRequest)
      ).not.toThrow();
      expect(() => getAdapter("zai", {}).validateTuiRequest(undefined, undefined))
        .not.toThrow();
    });
  });

  test("a supporting harness reads the override instead", () => {
    // Constructed against the populated view (round 5): with the adapter
    // handed `{}`, the base capability-flag early return alone made the old
    // `.not.toThrow()` pass, so the named claim was never exercised.
    const adapter = new ClaudeAdapter({
      CODEMUX_CLAUDE_PROVIDER_BASE_URL: "http://localhost:8011",
      CODEMUX_CLAUDE_PROVIDER_API_KEY: "k",
      CODEMUX_CLAUDE_PROVIDER_MODEL: "m",
    });
    expect(() =>
      adapter.validateRunRequest({ agent: "claude", prompt: "p" } as RunRequest)
    ).not.toThrow();
    // The adapter really read the override, not merely tolerated it.
    expect(adapter.getEnv().ANTHROPIC_BASE_URL).toBe("http://localhost:8011");
  });
});

describe("provider override: validation", () => {
  const cases: [string, Record<string, string>, string][] = [
    [
      "base URL that is not a URL",
      { CODEMUX_AIDER_PROVIDER_BASE_URL: "api.z.ai", CODEMUX_AIDER_PROVIDER_API_KEY: "k" },
      "CODEMUX_AIDER_PROVIDER_BASE_URL must be an absolute http(s) URL",
    ],
    [
      "base URL with credentials",
      { CODEMUX_AIDER_PROVIDER_BASE_URL: "https://k@api.z.ai", CODEMUX_AIDER_PROVIDER_API_KEY: "k" },
      "CODEMUX_AIDER_PROVIDER_BASE_URL must be a plain http(s) URL",
    ],
    [
      "base URL with a fragment",
      { CODEMUX_AIDER_PROVIDER_BASE_URL: "https://api.z.ai/#x", CODEMUX_AIDER_PROVIDER_API_KEY: "k" },
      "CODEMUX_AIDER_PROVIDER_BASE_URL must be a plain http(s) URL",
    ],
    // Regression (h4 review): braces are template syntax in the config
    // files overrides write — OpenCode substitutes {env:…}/{file:…} and
    // droid and pi expand ${VAR} — so a base URL carrying one could splice
    // another value into a config codemux writes.
    [
      "base URL with a ${VAR} template (droid/pi config expansion)",
      { CODEMUX_AIDER_PROVIDER_BASE_URL: "https://api.z.ai/${SECRET}", CODEMUX_AIDER_PROVIDER_API_KEY: "k" },
      "CODEMUX_AIDER_PROVIDER_BASE_URL must not contain braces",
    ],
    [
      "base URL with an OpenCode {env:…} substitution",
      { CODEMUX_AIDER_PROVIDER_BASE_URL: "https://api.z.ai/{env:SECRET}", CODEMUX_AIDER_PROVIDER_API_KEY: "k" },
      "CODEMUX_AIDER_PROVIDER_BASE_URL must not contain braces",
    ],
    [
      "api key with a space",
      { CODEMUX_AIDER_PROVIDER_API_KEY: "k 1" },
      "CODEMUX_AIDER_PROVIDER_API_KEY must be 1 to 4096 printable ASCII bytes",
    ],
    [
      "api key with a newline (header smuggling)",
      { CODEMUX_AIDER_PROVIDER_API_KEY: "k\n1" },
      "CODEMUX_AIDER_PROVIDER_API_KEY must be 1 to 4096 printable ASCII bytes",
    ],
  ];
  for (const [name, env, message] of cases) {
    test(name, () => {
      expect(() => readProviderOverride("aider", env)).toThrow(message);
    });
  }

  test("a whitespace-only api key is blank, hence unset", () => {
    expect(
      readProviderOverride("aider", { CODEMUX_AIDER_PROVIDER_API_KEY: "\t" })
    ).toBeNull();
  });

  test("a very long api key is refused without echoing it", () => {
    let threw: string | null = null;
    try {
      readProviderOverride("aider", {
        CODEMUX_AIDER_PROVIDER_API_KEY: "k".repeat(5000),
      });
    } catch (error) {
      threw = String((error as Error).message);
    }
    expect(threw).toContain("CODEMUX_AIDER_PROVIDER_API_KEY");
    expect(threw).not.toContain("kkk");
  });
});

describe("provider override: requirements", () => {
  test("a null override lists every required name", () => {
    expect(() =>
      requireProviderOverride("aider", null, ["baseUrl", "apiKey", "model"])
    ).toThrow(
      "provider override requires CODEMUX_AIDER_PROVIDER_BASE_URL, CODEMUX_AIDER_PROVIDER_API_KEY, CODEMUX_AIDER_PROVIDER_MODEL in the environment"
    );
  });

  test("a partial override names only what is missing", () => {
    expect(() =>
      requireProviderOverride(
        "aider",
        { baseUrl: "https://api.z.ai/api/coding/paas/v4", apiKey: "k" },
        ["baseUrl", "apiKey", "model"]
      )
    ).toThrow("provider override is missing CODEMUX_AIDER_PROVIDER_MODEL");
  });

  test("a satisfied requirement returns the override", () => {
    const override = { apiKey: "k" };
    expect(requireProviderOverride("pi", override, ["apiKey"])).toBe(override);
  });
});

describe("provider override: identity form", () => {
  test("the identity form strips the query and fragment, never re-spelling the rest (review D10, security)", () => {
    // A gateway key can ride the base URL's query (`?key=…`), and the raw
    // value goes to disk (the registry's provider_base_url) and into
    // refusal messages — so the recorded, compared, and echoed form is the
    // identity: everything from the first `?` or `#` stripped. The cut is
    // a string slice, not a URL re-render: `new URL().toString()` re-spells
    // (a trailing slash on a bare host), which would break the plain
    // string comparison the resume guard runs on the recorded value.
    expect(providerIdentityBaseUrl("http://gw.example/v1?key=e2e-secret")).toBe(
      "http://gw.example/v1"
    );
    expect(providerIdentityBaseUrl("http://gw.example/v1#fragment")).toBe(
      "http://gw.example/v1"
    );
    // Whichever comes first wins the cut; the rest is not parsed.
    expect(providerIdentityBaseUrl("http://gw.example/v1?k=1#f?k=2")).toBe(
      "http://gw.example/v1"
    );
    // No query or fragment: the exact spelling, unchanged.
    expect(providerIdentityBaseUrl("http://gw.example")).toBe("http://gw.example");
    expect(providerIdentityBaseUrl("http://gw.example/v1/")).toBe("http://gw.example/v1/");
  });
});
