import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ClineAdapter } from "../src/adapters/cline.js";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { OpenHandsAdapter } from "../src/adapters/openhands.js";

test.each(["cline", "kimi", "openhands"] as const)("%s refuses a Playwright binary under the execution root", (agent) => {
  const root = mkdtempSync(resolve("scratch/fix/r12-trust-"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "home"));
  const binary = join(root, "bin", "playwright-mcp");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n");
  chmodSync(binary, 0o700);
  const env = { HOME: join(root, "home"), PATH: join(root, "bin"),
    CODEMUX_OPENHANDS_PROVIDER_BASE_URL: "https://provider.invalid/v1",
    CODEMUX_OPENHANDS_PROVIDER_API_KEY: "synthetic", CODEMUX_OPENHANDS_PROVIDER_MODEL: "fixture" };
  const request = { agent, prompt: "fixture", sandboxed: true, enablePlaywrightMcp: true };
  // The fixture is under process.cwd(), so leaving cwd absent must still reject it.
  if (agent === "cline") {
    expect(() => new ClineAdapter(env).prepareRun(request)).toThrow("inside the execution working directory");
  } else if (agent === "kimi") {
    expect(() => new KimiAdapter(env).buildRunCommand(request)).toThrow("inside the execution working directory");
  } else {
    const adapter = new OpenHandsAdapter(env);
    // OpenHands already refuses absent cwd before the trust check is reached.
    expect(() => adapter.prepareRun({ ...request, hermetic: true })).toThrow("requires an explicit --cwd");
    expect(() => adapter.prepareRun({ ...request, hermetic: true, cwd: process.cwd() }))
      .toThrow("inside the execution working directory");
  }
});
