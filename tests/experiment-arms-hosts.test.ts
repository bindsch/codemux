// Review B1 and M4 (scratch/fix/review-owner-integration.md): the
// retained-failure read keeps its ExperimentFailure type, and every relay
// host -- gemini included -- is both read for a retained failure and
// handed the catch-path failure, so its recording closes with a failure
// record instead of a clean close.
import { describe, expect, test } from "bun:test";
import type { BaseAdapter, RunContext } from "../src/adapters/base.js";
import { armExperimentFailure, retainedExperimentFailure } from "../src/launch/experiment-arms.js";
import { ExperimentFailure, ExperimentFailureCode } from "../src/experiment-records.js";
import type { RunRequest } from "../src/types.js";

const RELAY_HOSTS: string[] = ["experimentKimi", "experimentOpencode", "experimentGemini", "experimentCopilot",
  "experimentPi", "experimentGoose", "experimentQwen"];

function fakeHost(): { relay: { failureError: ExperimentFailure | null; failed: unknown[]; fail(error: unknown): void }; capturedOutput: string; hasOutput: boolean } {
  const relay = {
    failureError: null as ExperimentFailure | null,
    failed: [] as unknown[],
    fail(error: unknown) { this.failed.push(error); this.failureError ??= error as ExperimentFailure; },
  };
  return { relay, capturedOutput: "", hasOutput: false };
}

const adapter = { processRunResult: (raw: unknown) => raw } as unknown as BaseAdapter;

describe("experiment arms cover every relay host", () => {
  test("the retained read is typed ExperimentFailure | null (B1)", () => {
    // A compile-time pin: `bun run typecheck` covers tests/, so an
    // `unknown` return type fails here as it did in launch.ts.
    const none: ExperimentFailure | null = retainedExperimentFailure(undefined);
    expect(none).toBeNull();
    const failure = new ExperimentFailure(ExperimentFailureCode.Protocol, "x");
    const primary = retainedExperimentFailure({ experimentGemini: { relay: { failureError: failure } } } as unknown as RunContext)
      ?? new ExperimentFailure(ExperimentFailureCode.Protocol, "fallback");
    expect(primary.code).toBe(ExperimentFailureCode.Protocol);
    expect(primary.message).toContain("x");
  });

  test.each(RELAY_HOSTS)("%s: a retained relay failure is read", (key) => {
    const host = fakeHost();
    const failure = new ExperimentFailure(ExperimentFailureCode.Protocol, `${key} failed`);
    host.relay.failureError = failure;
    expect(retainedExperimentFailure({ [key]: host } as unknown as RunContext)).toBe(failure);
  });

  test.each(RELAY_HOSTS)("%s: the catch path hands the failure to the host's relay", (key) => {
    const host = fakeHost();
    const agent = key.replace("experiment", "").toLowerCase() as RunRequest["agent"];
    const request = { agent, prompt: "p", experimentMcp: "/spec.json" } as unknown as RunRequest;
    const context = { [key]: host } as unknown as RunContext;
    armExperimentFailure(adapter, request, request, context,
      new Error("experiment output exceeded the capture limit"), {});
    expect(host.relay.failed).toHaveLength(1);
    expect((host.relay.failed[0] as Error).message).toContain("capture limit");
    expect(retainedExperimentFailure(context)?.message).toContain("capture limit");
  });
});
