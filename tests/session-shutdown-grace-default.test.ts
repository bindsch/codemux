import { expect, test } from "bun:test";
import { DEFAULT_SHUTDOWN_GRACE_MS } from "../src/session/process.js";

// Live gate 2026-11-12: Claude Code 2.1.317 exited after a completed
// shutdown in up to 11.1 s with a 60 s grace, while the 10 s default sent
// SIGTERM mid-exit and 5 of 11 sessions ended SIGKILL or exit 143.
test("the session shutdown grace defaults to 30 s on every path", async () => {
  expect(DEFAULT_SHUTDOWN_GRACE_MS).toBe(30_000);
  const help = Bun.spawnSync([process.execPath, "src/index.ts", "session", "--help"], { cwd: process.cwd() }).stdout.toString();
  expect(help.replace(/\s+/g, " ")).toMatch(/--shutdown-grace <seconds>.*\(default: "30"\)/);
});
