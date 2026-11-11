import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { StrictSandboxRefusalError, strictLaunchFailureExitCode } from "../src/sandbox-command.js";
import { unexpectedErrorExitCode } from "../src/cli-runtime.js";
import { UsageRefusalError } from "../src/validation.js";
import { captureStrictRefusal, strictRefusalCases } from "./helpers/strict-refusal-cases.js";
import * as aider from "./helpers/session-aider-e2e.js";
import * as opencode from "./helpers/session-opencode-e2e.js";
import * as kimi from "./helpers/session-kimi-e2e.js";
import { engineSession } from "./helpers/session-turn-engine.js";

afterAll(async () => {
  for (const cleanup of [...aider.cleanups, ...opencode.cleanups, ...kimi.cleanups].reverse()) await cleanup();
  rmSync(root, { recursive: true, force: true });
});

const root = mkdtempSync(join(import.meta.dir, "../scratch/strict-refusals-"));
const cases = strictRefusalCases(root);

test.each(cases)("$name maps a real builder refusal to usage exit 64", ({ fail, message }) => {
  const error = captureStrictRefusal(fail);
  expect(error).toBeInstanceOf(StrictSandboxRefusalError);
  expect(error.message).toContain(message);
  expect(strictLaunchFailureExitCode(error)).toBe(64);
  expect(unexpectedErrorExitCode(error)).toBe(64);
});

test("unrelated per-turn failures retain exit 1", () => {
  expect(strictLaunchFailureExitCode(new UsageRefusalError("unrelated usage"))).toBe(1);
  expect(strictLaunchFailureExitCode(new Error("crash"))).toBe(1);
});

for (const { name: site, fail, message } of cases) {
for (const [name, harness] of [["aider", aider], ["opencode", opencode], ["kimi", kimi]] as const) {
  test.each([false, true])(`${name}: ${site} preserves exit 64, shutdown=%s`, async (shutdown) => {
    const pending = Promise.withResolvers<never>(), started = Promise.withResolvers<void>();
    const session = await harness.startSession({ spawnTurn: () => { started.resolve(); return pending.promise; } });
    harness.send(session.driver as never, { type: "user", text: "synthetic" });
    await started.promise;
    if (shutdown) session.driver.handleCallerEnd();
    pending.reject(captureStrictRefusal(fail));
    expect(await session.code).toBe(64);
    expect(session.events.at(-1)?.type).toBe("session_ended");
    expect(session.events.at(-1)?.exit_code).toBe(64);
    expect(session.events.find((event) => event.type === "error")?.message).toContain(message);
  });
}

test.each([false, true])(`shared turn engine: ${site} preserves exit 64, shutdown=%s`, async (shutdown) => {
  const pending = Promise.withResolvers<never>(), started = Promise.withResolvers<void>();
  const session = engineSession({ options: { spawnTurn: () => { started.resolve(); return pending.promise; } } });
  try {
    session.user();
    await started.promise;
    if (shutdown) session.close();
    pending.reject(captureStrictRefusal(fail));
    expect(await session.code()).toBe(64);
    expect(session.events.at(-1)?.exit_code).toBe(64);
    expect(session.events.find((event) => event.type === "error")?.message).toContain(message);
  } finally { session.dispose(); }
});
}
