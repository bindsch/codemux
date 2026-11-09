import { expect, test } from "bun:test";
import type { BaseAdapter, RunContext } from "../src/adapters/base.js";
import { prepareSessionEnvironment } from "../src/session/cli-environment.js";
import type { RunRequest } from "../src/types.js";

function environmentFixture() {
  const seen: unknown[] = [];
  const runLike = { prompt: "synthetic request" } as unknown as RunRequest;
  const passthroughEnv = ["TEST_PASSTHROUGH"];
  const adapter = {
    getEnv: () => ({ SYNTHETIC_API_KEY: "test-key" }),
    getRunEnv: (request: RunRequest, context: RunContext | undefined) => {
      seen.push({ request, context });
      return { TURN_VALUE: context === undefined ? "first" : "next" };
    },
    buildExecutionEnv: (runEnv: Record<string, string>, passed: string[]) => {
      seen.push(passed);
      return { ...runEnv, TEST_PASSTHROUGH: "passed" };
    },
  } as unknown as BaseAdapter;
  return { adapter, runLike, passthroughEnv, seen, sandboxed: true, sandboxOptions: undefined, override: null };
}

test("each launch builds its own context environment with the same passthrough list", () => {
  const fixture = environmentFixture();
  const { buildSessionEnvironment, needsKeepEnvPreflight } = prepareSessionEnvironment(fixture);
  const context = { finalize: () => {} } as unknown as RunContext;
  expect(needsKeepEnvPreflight).toBe(false);
  expect(buildSessionEnvironment(undefined)).toEqual({
    runEnv: { TURN_VALUE: "first" }, env: { TURN_VALUE: "first", TEST_PASSTHROUGH: "passed" },
  });
  expect(buildSessionEnvironment(context).runEnv).toEqual({ TURN_VALUE: "next" });
  expect(fixture.seen).toEqual([
    { request: fixture.runLike, context: undefined }, fixture.passthroughEnv,
    { request: fixture.runLike, context }, fixture.passthroughEnv,
  ]);
});

test("credential exemptions require a probe for explicit and implicit scrubbing", () => {
  const fixture = environmentFixture();
  for (const sandboxOptions of [{ scrubEnv: true }, { trust: "untrusted" as const }]) {
    expect(prepareSessionEnvironment({ ...fixture, sandboxOptions }).needsKeepEnvPreflight).toBe(true);
  }
  fixture.adapter.getEnv = () => ({ PUBLIC_SETTING: "plain" });
  expect(prepareSessionEnvironment({ ...fixture, sandboxOptions: { scrubEnv: true } }).needsKeepEnvPreflight).toBe(false);
});

test("an override requires the probe without resolving standing credentials", () => {
  const fixture = environmentFixture();
  fixture.adapter.getEnv = () => { throw new Error("credentials must stay lazy"); };
  const options = { ...fixture, sandboxOptions: { scrubEnv: true } };
  expect(prepareSessionEnvironment({ ...options, sandboxed: false }).needsKeepEnvPreflight).toBe(false);
  expect(prepareSessionEnvironment({
    ...options, override: { baseUrl: "https://provider.invalid", apiKey: "test-key" },
  }).needsKeepEnvPreflight).toBe(true);
});
