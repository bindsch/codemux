import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CopilotAdapter } from "../src/adapters/copilot.js";
import type { RunRequest } from "../src/types.js";

const PKG_CACHE_ENV = "COPILOT_PKG_CACHE_HOME";
const CACHE_ENV = "COPILOT_CACHE_HOME";
const ADAPTER_HOME = join(import.meta.dir, "../scratch/copilot-cache-home");
const CACHE_HOME = join(ADAPTER_HOME, ".cache", "copilot");
const REQUEST: RunRequest = { agent: "copilot", prompt: "test", sandboxed: true };

describe.each(["headless", "TUI"] as const)("%s cache environment", (mode) => {
  const getEnv = (adapter: CopilotAdapter, request: RunRequest) => mode === "headless"
    ? adapter.getRunEnv(request, {})
    : adapter.getTuiEnv(undefined, undefined, undefined, request.sandboxed, request.passthroughEnv);

  describe.skipIf(process.platform !== "darwin")("Copilot's sandbox package cache on macOS", () => {
    test("uses the adapter's HOME and keeps the cache in the launch environment", () => {
      const adapter = new CopilotAdapter({ HOME: ADAPTER_HOME });
      const injected = getEnv(adapter, REQUEST);
      expect(injected).toEqual({ [PKG_CACHE_ENV]: CACHE_HOME });
      expect(adapter.buildExecutionEnv(injected)[PKG_CACHE_ENV]).toBe(CACHE_HOME);
    });

    test.each([false, undefined])("does not redirect when sandboxed is %s", (sandboxed) => {
      const adapter = new CopilotAdapter({ HOME: ADAPTER_HOME });
      expect(getEnv(adapter, { ...REQUEST, sandboxed })).toEqual({});
    });

    test("does not fall back to the process home when the adapter has no HOME", () => {
      const adapter = new CopilotAdapter({ PATH: "/usr/bin:/bin" });
      expect(getEnv(adapter, REQUEST)).toEqual({});
    });

    test.each([PKG_CACHE_ENV, CACHE_ENV])("preserves a passed-through %s", (name) => {
      const operatorCache = join(ADAPTER_HOME, "operator-cache");
      const adapter = new CopilotAdapter({ HOME: ADAPTER_HOME, [name]: operatorCache });
      const request = { ...REQUEST, passthroughEnv: [name] };
      const injected = getEnv(adapter, request);
      expect(injected).toEqual({});
      expect(adapter.buildExecutionEnv(injected, request.passthroughEnv)[name]).toBe(operatorCache);
    });

    test.each([
      [PKG_CACHE_ENV, undefined],
      [PKG_CACHE_ENV, ""],
      [CACHE_ENV, undefined],
      [CACHE_ENV, ""],
    ] as const)("redirects when passed-through %s has value %j", (name, value) => {
      const adapter = new CopilotAdapter({ HOME: ADAPTER_HOME, [name]: value });
      const request = { ...REQUEST, passthroughEnv: [name] };
      const injected = getEnv(adapter, request);
      expect(injected).toEqual({ [PKG_CACHE_ENV]: CACHE_HOME });
      expect(adapter.buildExecutionEnv(injected, request.passthroughEnv)[PKG_CACHE_ENV])
        .toBe(CACHE_HOME);
    });

    test.each([
      [undefined, undefined],
      [undefined, ""],
      ["", undefined],
      ["", ""],
    ] as const)("redirects when both passed-through caches are empty: %j, %j", (pkgCache, cache) => {
      const adapter = new CopilotAdapter({
        HOME: ADAPTER_HOME,
        [PKG_CACHE_ENV]: pkgCache,
        [CACHE_ENV]: cache,
      });
      const request = { ...REQUEST, passthroughEnv: [PKG_CACHE_ENV, CACHE_ENV] };
      const injected = getEnv(adapter, request);
      expect(injected).toEqual({ [PKG_CACHE_ENV]: CACHE_HOME });
      expect(adapter.buildExecutionEnv(injected, request.passthroughEnv)[PKG_CACHE_ENV])
        .toBe(CACHE_HOME);
    });

    test.each([
      [PKG_CACHE_ENV, undefined],
      [PKG_CACHE_ENV, ""],
      [CACHE_ENV, undefined],
      [CACHE_ENV, ""],
    ] as const)("preserves a nonempty override when passed-through %s is %j", (emptyName, value) => {
      const overrideName = emptyName === PKG_CACHE_ENV ? CACHE_ENV : PKG_CACHE_ENV;
      const operatorCache = join(ADAPTER_HOME, "operator-cache");
      const adapter = new CopilotAdapter({
        HOME: ADAPTER_HOME,
        [emptyName]: value,
        [overrideName]: operatorCache,
      });
      const request = { ...REQUEST, passthroughEnv: [PKG_CACHE_ENV, CACHE_ENV] };
      const injected = getEnv(adapter, request);
      expect(injected).toEqual({});
      expect(adapter.buildExecutionEnv(injected, request.passthroughEnv)[overrideName])
        .toBe(operatorCache);
    });

    test.each([PKG_CACHE_ENV, CACHE_ENV])("replaces an ambient %s without passthrough", (name) => {
      const adapter = new CopilotAdapter({ HOME: ADAPTER_HOME, [name]: "/ambient-cache" });
      const injected = getEnv(adapter, REQUEST);
      expect(injected).toEqual({ [PKG_CACHE_ENV]: CACHE_HOME });
      const env = adapter.buildExecutionEnv(injected);
      expect(env[PKG_CACHE_ENV]).toBe(CACHE_HOME);
      expect(env[CACHE_ENV]).toBeUndefined();
    });

    test("preserves both passed-through cache settings", () => {
      const adapter = new CopilotAdapter({
        HOME: ADAPTER_HOME,
        [PKG_CACHE_ENV]: "/package-cache",
        [CACHE_ENV]: "/general-cache",
      });
      const request = { ...REQUEST, passthroughEnv: [PKG_CACHE_ENV, CACHE_ENV] };
      const injected = getEnv(adapter, request);
      expect(injected).toEqual({});
      const env = adapter.buildExecutionEnv(injected, request.passthroughEnv);
      expect(env[PKG_CACHE_ENV]).toBe("/package-cache");
      expect(env[CACHE_ENV]).toBe("/general-cache");
    });

    test("still redirects when an unrelated variable is passed through", () => {
      const adapter = new CopilotAdapter({ HOME: ADAPTER_HOME });
      expect(getEnv(adapter, { ...REQUEST, passthroughEnv: ["GH_TOKEN"] }))
        .toEqual({ [PKG_CACHE_ENV]: CACHE_HOME });
    });
  });

  test.skipIf(process.platform === "darwin")("Copilot keeps the default cache on other platforms", () => {
    const adapter = new CopilotAdapter({ HOME: ADAPTER_HOME });
    expect(getEnv(adapter, REQUEST)).toEqual({});
  });
});
