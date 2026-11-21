import { expect, spyOn, test } from "bun:test";
import childProcess from "node:child_process";
import { agyLoginState } from "../src/harness-health.js";
import { readKeychainStatus } from "../src/doctor-environment.js";
test("login health never spawns a process", async () => {
  const spawn = spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("no native probe"); });
  const refuse = (() => { throw new Error("no native probe"); }) as never;
  const nodeSpawns = [spyOn(childProcess, "spawnSync").mockImplementation(refuse),
    spyOn(childProcess, "execFileSync").mockImplementation(refuse), spyOn(childProcess, "spawn").mockImplementation(refuse)];
  try {
    expect(agyLoginState(process.env.HOME!, {}, "darwin")).toMatchObject({ state: "unknown", store: "macOS Keychain" });
    expect(agyLoginState(process.env.HOME!, {}, "linux").state).toBe("unknown");
    expect(agyLoginState(process.env.HOME!, { GEMINI_API_KEY: "synthetic" }, "darwin"))
      .toEqual({ state: "logged-in", store: "GEMINI_API_KEY" });
    expect(await readKeychainStatus({})).toMatchObject({ state: "skipped" });
    expect(spawn).not.toHaveBeenCalled();
    for (const spy of nodeSpawns) expect(spy).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); for (const spy of nodeSpawns) spy.mockRestore(); }
});
