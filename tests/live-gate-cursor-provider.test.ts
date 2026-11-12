import { expect, test } from "bun:test";
import { CursorAdapter } from "../src/adapters/cursor.js";
import { PARITY } from "../src/parity/index.js";
import { CURSOR_PROVIDER_REFUSAL } from "../src/cursor-provider-limitation.js";
import { runCli } from "./helpers/cli.js";
import fixture from "./fixtures/live/live-gate-2.0.1-failures.json";

const override = {
  CODEMUX_CURSOR_PROVIDER_BASE_URL: "http://127.0.0.1:1",
  CODEMUX_CURSOR_PROVIDER_API_KEY: "synthetic-override-key",
  CODEMUX_CURSOR_PROVIDER_MODEL: "synthetic-model",
};

test("live H2 account-token leak is a declared refusal on run, check, session and TUI", async () => {
  expect(fixture.cursorH2).toContain("POST /aiserver.v1.DashboardService/GetMe");
  expect(fixture.cursorStderr).toContain("CURSOR_API_KEY");
  const adapter = new CursorAdapter(() => "/synthetic/cursor-agent", override);
  expect(adapter.capabilities().supportsProviderOverride).toBe(false);
  for (const feature of ["run.provider-override", "check.provider-override.served-model",
    "session.provider-override", "tui.provider-override"] as const) {
    expect(PARITY.cursor[feature].state).toBe("harness-limitation");
  }
  for (const args of [["run", "-a", "cursor", "-p", "unused"], ["check", "-a", "cursor"],
    ["session", "-a", "cursor"], ["tui", "-a", "cursor"]]) {
    const result = await runCli(args, override);
    expect(result.exitCode, args.join(" ")).toBe(64);
    expect(result.stderr).not.toContain("synthetic-override-key");
  }
  expect(() => adapter.getRunEnv({ agent: "cursor", prompt: "unused" })).toThrow(CURSOR_PROVIDER_REFUSAL);
});
