import { expect, spyOn, test } from "bun:test";
import * as canaryDriver from "../src/hermetic-session-canary-driver.js";
import { runHermeticSessionCanary } from "../src/hermetic-session-canary.js";

test("OpenCode canary refuses a missing private home before running its control", async () => {
  const run = spyOn(canaryDriver, "runCanarySession").mockResolvedValue({
    exitCode: 0, sessionId: "synthetic", assistantText: "OK",
    ended: { reason: "shutdown", exitCode: 0 }, completed: true,
    stdout: "OK", stderr: "", stopped: false, failure: null,
  });
  const errors: string[] = [];
  const log = spyOn(console, "error").mockImplementation((message) => { errors.push(String(message)); });
  try {
    expect(await runHermeticSessionCanary({ agent: "opencode", autonomy: "read-only", passthroughEnv: [], timeoutMs: 1000 })).toBe(1);
    expect(errors.join("\n")).toContain("reported no private_home");
    expect(run).toHaveBeenCalledTimes(1);
  } finally { run.mockRestore(); log.mockRestore(); }
});
