import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import { ClineAdapter } from "../src/adapters/cline.js";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import * as remote from "../src/opencode-remote-config.js";
import * as experimentSpec from "../src/experiment-mcp.js";
import { buildEffectiveScodeCommands } from "../src/verify.js";

const roots: string[] = [];
const root = () => {
  const parent = join(import.meta.dir, "../scratch/fix"); mkdirSync(parent, { recursive: true });
  const path = realpathSync(mkdtempSync(join(parent, "r8-adapter-"))); roots.push(path); return path;
};
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

for (const agent of ["cline", "gemini"] as const) {
  test.each([{ tools: "none" as const }, { experimentMcp: "synthetic.json" }])(`${agent} fails closed without prepared state for %j`, (restriction) => {
    const adapter = agent === "cline" ? new ClineAdapter({}) : new GeminiAdapter({});
    expect(() => adapter.getRunEnv({ agent, prompt: "p", ...restriction })).toThrow(/prepar/);
  });
}

test("OpenCode TUI sandbox status cannot disable remote configuration validation", () => {
  const home = root();
  const adapter = new OpencodeAdapter({ HOME: home, CODEMUX_OPENCODE_PROVIDER_BASE_URL: "https://provider.invalid/v1",
    CODEMUX_OPENCODE_PROVIDER_API_KEY: "synthetic", CODEMUX_OPENCODE_PROVIDER_MODEL: "model" }, home);
  const carrier = spyOn(remote, "opencodeRemoteConfigCarrier").mockReturnValue("synthetic remote config");
  try {
    expect(() => adapter.getTuiEnv(undefined, undefined, undefined, true)).toThrow("remote configuration");
    expect(() => adapter.getTuiEnv(undefined, undefined, undefined, false)).toThrow("remote configuration");
    const preview = adapter.prepareTuiEnvironment(undefined, undefined, undefined, true, [], true);
    expect(preview.env.CODEMUX_OPENCODE_PROVIDER_API_KEY).toBe("synthetic"); preview.finalize();
  } finally { carrier.mockRestore(); }
});

test("OpenCode TUI previews use an effort request that validation accepts", () => {
  const validate = spyOn(OpencodeAdapter.prototype, "buildTuiCommand");
  try {
    const rows = buildEffectiveScodeCommands(["opencode"]);
    expect(rows.filter((row) => row.mode === "tui")).toHaveLength(4);
    for (const [model, autonomy, effort] of validate.mock.calls) {
      expect(effort).toBeUndefined();
      expect(() => new OpencodeAdapter({}).validateTuiRequest(model, undefined, autonomy, effort, [], false, { printOnly: true })).not.toThrow();
    }
  } finally { validate.mockRestore(); }
});

test("Gemini experiment control has a real linked login without a provider override", () => {
  const home = root(); mkdirSync(join(home, ".gemini"));
  writeFileSync(join(home, ".gemini/oauth_creds.json"), "synthetic-login");
  const spec = spyOn(experimentSpec, "readExperimentRunSpec").mockReturnValue({ name: "test", command: "/synthetic/server",
    args: [], env: [], control: true, recording: join(home, "records"),
    accept_harness_prefix: ["gemini-untrusted-context"], accept_harness_schema: ["gemini-wait-for-previous"] });
  const adapter = new GeminiAdapter({ HOME: home });
  try {
    const request = { agent: "gemini" as const, prompt: "p", cwd: home, experimentMcp: "synthetic.json" };
    const context = adapter.prepareRun(request);
    try {
      expect(existsSync(context.geminiHermeticHome!.home)).toBe(true);
      expect(readFileSync(join(context.geminiHermeticHome!.geminiDir, "oauth_creds.json"), "utf8")).toBe("synthetic-login");
      expect(adapter.buildRunCommand(request, context)).toContain(`GEMINI_CLI_HOME=${context.geminiHermeticHome!.home}`);
    } finally { adapter.cleanupRunSync(context); }
  } finally { spec.mockRestore(); }
});
