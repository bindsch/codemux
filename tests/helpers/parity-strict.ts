import { expect } from "bun:test";
import type { AgentId } from "../../src/types.js";
import { parseSandboxPolicyOverrides } from "../../src/cli-runtime/options.js";
import { resolveSandboxOptionsForAgent } from "../../src/sandbox-policy.js";
import { buildScodeCommand } from "../../src/sandbox.js";
import { STRICT_LIVE_FAILURES, strictOkProbePassed } from "./strict-live-evidence.js";
import type { FeatureState, ParityFeature } from "../../src/parity/features.js";

/** Login-store policy is universal, including harnesses with no native grant. */
export function loginStoreOutcome(agent: AgentId) {
  const overrides = parseSandboxPolicyOverrides({ sandbox: true, sandboxLoginStore: true });
  const options = resolveSandboxOptionsForAgent(agent, "read-only", overrides);
  expect(options.loginStore).toBe(true);
  expect(options.noLoginStore).not.toBe(true);
  return { message: null, code: null };
}

export function noLoginStoreOutcome(agent: AgentId) {
  const overrides = parseSandboxPolicyOverrides({ sandbox: true, sandboxNoLoginStore: true });
  const options = resolveSandboxOptionsForAgent(agent, "read-only", overrides);
  expect(options.noLoginStore).toBe(true);
  const argv = buildScodeCommand([agent], undefined, "read-only", options, "scode", {}, false, true, true);
  expect(argv).toContain("--no-login-store");
  expect(argv).not.toContain("--allow");
  expect(argv).not.toContain("--allow-staged");
  return { message: null, code: null };
}

/** All four launch modes cross this parser and policy builder. */
export function strictSandboxOutcome(agent: AgentId) {
  const overrides = parseSandboxPolicyOverrides({ sandbox: true, sandboxStrict: true });
  const options = resolveSandboxOptionsForAgent(agent, "read-only", overrides);
  expect(buildScodeCommand([agent], undefined, "read-only", options)).toContain("--strict");
  expect(() => parseSandboxPolicyOverrides({ sandbox: false, sandboxStrict: true }))
    .toThrow("--sandbox-strict requires --sandbox");
  const failure = STRICT_LIVE_FAILURES[agent];
  if (failure) {
    expect(strictOkProbePassed(failure)).toBe(false);
    return { message: failure.stdout + failure.stderr, code: failure.code, runtimeLimitation: true as const };
  }
  return { message: null, code: null };
}

export function assertStrictRuntimeLimitation(feature: ParityFeature, state: Extract<FeatureState, { state: "harness-limitation" }>, message: string | null): void {
  expect(feature.endsWith(".sandbox-strict")).toBe(true);
  expect(state.test).toBe("tests/sandbox-strict-live-evidence.test.ts");
  expect(message).toContain(state.refusal);
}
