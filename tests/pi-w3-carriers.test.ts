import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PiAdapter } from "../src/adapters/pi.js";
import { piNativeSessionDir, preparePiTuiLaunch } from "../src/pi-launch.js";
import { buildPiDriverTurnCommand } from "../src/session/pi-driver.js";
import { buildPiSessionCommand } from "../src/session/pi-session.js";
import { resolveSessionRequest } from "../src/session/cli-request.js";
import { refusingCall } from "./helpers/session-cli-hermetic.js";
import { runSessionCommand } from "./helpers/session-command.js";
import { getDefaultConfig } from "../src/config.js";

const ID = "11111111-1111-4111-8111-111111111111";
const OVERRIDE = {
  CODEMUX_PI_PROVIDER_BASE_URL: "https://pi.synthetic.invalid/v1",
  CODEMUX_PI_PROVIDER_API_KEY: "synthetic-key",
  CODEMUX_PI_PROVIDER_MODEL: "synthetic-model",
};

function withHome(run: (home: string) => void): void {
  const parent = join(process.cwd(), "scratch", "fix", "pi-synthetic");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "home-"));
  try { run(home); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

describe("pi native run/check limitations", () => {
  const adapter = new PiAdapter({});
  test("spend caps require prepared native extension artifacts", () => {
    expect(() => adapter.validateRunRequest({ agent: "pi", prompt: "p", maxBudgetUsd: 1 })).not.toThrow();
    expect(() => adapter.buildRunCommand({ agent: "pi", prompt: "p", maxBudgetUsd: 1 }))
      .toThrow("Pi budget extension was not prepared");
  });
  test("no-web preserves the native registry, which contains no web tools", () => {
    // Exact allToolNames inventory from pi 0.85.1 dist/core/tools/index.js,
    // read 2026-11-09. Extensions and shell networking are outside this
    // flag's built-in tool contract, just as they are on Claude.
    const nativeTools = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
    expect(nativeTools.some((name) => /web|fetch|search/i.test(name))).toBe(false);
    for (const autonomy of ["read-only", "low", "medium", "high"] as const) {
      const request = { agent: "pi" as const, prompt: "p", autonomy };
      expect(() => adapter.validateRunRequest({ ...request, web: false })).not.toThrow();
      expect(adapter.buildRunCommand({ ...request, web: false })).toEqual(adapter.buildRunCommand(request));
    }
  });
  test("project-policy requests refuse instead of disappearing; Playwright passes the gate", () => {
    expect(() => adapter.validateRunRequest({ agent: "pi", prompt: "p", experimentProjectSettings: true }))
      .toThrow("pi has no project setting source mapping");
    // Playwright is supported now: the shared member table admits pi, and
    // tests/pi-mcp-stdio.test.ts proves the delivered extension at the
    // run boundary. The gate must not silently drop the request either.
    expect(() => adapter.validateRunRequest({ agent: "pi", prompt: "p", enablePlaywrightMcp: true, sandboxed: true }))
      .not.toThrow();
  });
  test("session tools pass the shared gate; permission-policy deny stays refused", async () => {
    const tools = refusingCall(() => resolveSessionRequest({ agent: "pi", tools: "none", auto: "high" }, getDefaultConfig()));
    expect(tools.code).not.toBe(64);
    expect(tools.message).not.toContain("--tools none is refused for sessions");
    const cli = await runSessionCommand(["-a", "pi", "--tools", "none"]);
    expect(cli.exitCode).toBe(1);
    expect(cli.stderr).toContain("is not installed");
    expect(cli.stderr).not.toContain("--tools");
    const deny = refusingCall(() => resolveSessionRequest({ agent: "pi", permissionPolicy: "deny" }, getDefaultConfig()));
    expect(deny.code).toBe(64);
    expect(deny.message).toContain("--permission-policy deny is unavailable for 'pi'");
  });
});

describe("pi native session carriers", () => {
  test("tools none overrides every autonomy allowlist on every launch", () => {
    for (const autonomy of ["read-only", "low", "medium", "high"] as const) {
      const argv = buildPiSessionCommand({ sessionId: ID, autonomy, tools: "none" });
      expect(argv).toContain("--no-tools");
      expect(argv).toContain("--no-extensions");
      expect(argv).not.toContain("--tools");
      expect(argv).toContain(ID);
      expect(argv).not.toContain("--no-session");
    }
  });
  test("an override's model and transcript path stay independent of its private config", () => {
    const directory = piNativeSessionDir("/agent", "/project/with:colon");
    expect(directory).toBe("/agent/sessions/--project-with-colon--");
    expect(piNativeSessionDir("/agent", "/")).toBe("/agent/sessions/----");
    expect(() => piNativeSessionDir("relative", "/project")).toThrow("must be absolute");
    expect(() => piNativeSessionDir("/agent", "relative")).toThrow("must be absolute");
    const input = {
      text: "never in argv", sessionId: ID, firstTurn: false, hermeticHome: null,
      autonomy: "low" as const, tools: "none" as const, sessionDir: directory,
      model: "raw-model", providerModelId: "codemux/raw-model",
    };
    const command = buildPiDriverTurnCommand(input);
    expect(command.slice(command.indexOf("--session-dir"), command.indexOf("--session-dir") + 2))
      .toEqual(["--session-dir", directory]);
    expect(command.slice(command.indexOf("--model"), command.indexOf("--model") + 2))
      .toEqual(["--model", "codemux/raw-model"]);
    expect(command).not.toContain(input.text);
    expect(command).toContain("--no-tools");
    expect(buildPiDriverTurnCommand({ ...input, hermeticHome: "/private/agent" }))
      .toContain("PI_CODING_AGENT_DIR=/private/agent");
  });
});

test("session Playwright extension is explicit and stays outside builtin allowlists", () => {
  for (const autonomy of ["read-only", "low", "medium", "high"] as const) {
    const command = buildPiSessionCommand({ sessionId: ID, autonomy, mcpExtensionPath: "/private/playwright.mjs" });
    expect(command).toContain("/private/playwright.mjs");
    expect(command).not.toContain("--tools");
    if (autonomy === "low") expect(command).toContain("bash,powershell");
  }
});

describe("pi TUI provider artifacts", () => {
  test("provider directory and secret live only for the caller-owned launch", () => {
    withHome((home) => {
      const adapter = new PiAdapter({ ...OVERRIDE, HOME: home }, home);
      const launch = preparePiTuiLaunch(adapter, { cwd: home, autonomy: "low", effort: "high" });
      const directory = launch.env.PI_CODING_AGENT_DIR!;
      expect(launch.command).toEqual([
        "pi", "--no-approve", "--model", "codemux/synthetic-model",
        "--no-extensions", "--tools", "read,grep,find,ls,edit,write", "--thinking", "high",
        "--session-dir", piNativeSessionDir(join(home, ".pi", "agent"), home),
      ]);
      expect(launch.env.CODEMUX_PI_PROVIDER_API_KEY).toBe("synthetic-key");
      const models = readFileSync(join(directory, "models.json"), "utf8");
      expect(models).not.toContain("synthetic-key");
      expect(JSON.parse(models).providers.codemux.models[0].id).toBe("synthetic-model");
      launch.cleanup();
      expect(existsSync(directory)).toBe(false);
    });
  });
  test("plain models and default models need no artifacts", () => {
    withHome((home) => {
      const adapter = new PiAdapter({ HOME: home }, home);
      const plain = preparePiTuiLaunch(adapter, { cwd: home, autonomy: "high", model: "plain" });
      expect(plain.command).toEqual(["pi", "--no-approve", "--model", "plain"]);
      expect(plain.env).toEqual({});
      plain.cleanup();
      const automatic = preparePiTuiLaunch(adapter, { cwd: home, autonomy: "high" });
      expect(automatic.command).toEqual(["pi", "--no-approve"]);
      automatic.cleanup();
    });
  });
  test("validation is before preparation, and a post-preparation error removes its artifacts", () => {
    withHome((home) => {
      const adapter = new PiAdapter({ ...OVERRIDE, HOME: home }, home);
      expect(() => preparePiTuiLaunch(adapter, { cwd: home, autonomy: "high", model: "${SECRET}" }))
        .toThrow();
      const original = adapter.prepareRun.bind(adapter);
      let directory = "";
      const prepare = spyOn(adapter, "prepareRun").mockImplementation((request) => {
        const context = original(request);
        directory = context.piProviderAgentDir!.path;
        return context;
      });
      const environment = spyOn(adapter, "getRunEnv").mockImplementation(() => { throw new Error("synthetic launch failure"); });
      try {
        expect(() => preparePiTuiLaunch(adapter, { cwd: home, autonomy: "high" }))
          .toThrow("synthetic launch failure");
        expect(directory).not.toBe("");
        expect(existsSync(directory)).toBe(false);
      } finally { environment.mockRestore(); prepare.mockRestore(); }
    });
  });
});
