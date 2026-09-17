import { describe, expect, test } from "bun:test";
import {
  providerOverrideEnvNames,
  readProviderOverride,
  requireProviderOverride,
} from "../src/provider-override.js";

describe("provider override: environment names", () => {
  test("names are derived from the agent id", () => {
    expect(providerOverrideEnvNames("aider")).toEqual({
      baseUrl: "CODEMUX_AIDER_PROVIDER_BASE_URL",
      apiKey: "CODEMUX_AIDER_PROVIDER_API_KEY",
      model: "CODEMUX_AIDER_PROVIDER_MODEL",
    });
    expect(providerOverrideEnvNames("opencode").apiKey).toBe(
      "CODEMUX_OPENCODE_PROVIDER_API_KEY"
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
      readProviderOverride("openhands", {
        CODEMUX_OPENHANDS_PROVIDER_BASE_URL: " https://api.z.ai/api/coding/paas/v4 ",
        CODEMUX_OPENHANDS_PROVIDER_API_KEY: " k-1 ",
        CODEMUX_OPENHANDS_PROVIDER_MODEL: " glm-5.3 ",
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
