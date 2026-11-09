import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import { codexSessionConfigArgs, codexSessionToolConfig, validateCodexSessionTools } from "../src/session/codex-config.js";
import { buildCodexSessionCommand } from "../src/session/codex-session.js";
import { readRegistry } from "../src/session/registry.js";
import { writeCodexProjectSettingsConfig } from "../src/codex-project-settings.js";
import { writeCodexProviderConfigInto } from "../src/codex-provider.js";
import { cleanupSessions, fakeRecord, send, startAndWait } from "./session-codex-e2e-helpers.js";

afterAll(cleanupSessions);
const THREAD = "0123456789abcdef";
const OVERRIDE = {
  baseUrl: "https://synthetic.invalid/v1", apiKey: "synthetic-key", model: "synthetic-model",
};

describe("Codex session parity carriers", () => {
  test("session writable tools none fails until the session catalog is prepared", () => {
    expect(() => validateCodexSessionTools("none", "high")).toThrow("requires a prepared native model catalog");
    expect(() => validateCodexSessionTools("none", "read-only")).not.toThrow();
    expect(() => validateCodexSessionTools("default", "high")).not.toThrow();
  });
  test("plain app-server leaves config unchanged; hermetic startup suppresses account surfaces", () => {
    expect(codexSessionConfigArgs({})).toEqual([]);
    const args = buildCodexSessionCommand(["HOME=/private/h", "CODEX_HOME=/private/h/.codex"], [], { hermetic: true });
    expect(args).toContain("project_doc_max_bytes=0");
    expect(args).toContain("features.hooks=false");
    expect(args).toContain("features.plugins=false");
    expect(args).toContain("features.shell_snapshot=false");
    expect(args).not.toContain("--disable");
    expect(args.indexOf("app-server")).toBeLessThan(args.indexOf("-c"));
  });

  test("project settings keep repository instructions and hooks while disabling account surfaces", () => {
    const args = codexSessionConfigArgs({ hermetic: true, projectSettings: true });
    expect(args).not.toContain("project_doc_max_bytes=0");
    expect(args).not.toContain("project_doc_fallback_filenames=[]");
    expect(args).not.toContain("features.hooks=false");
    expect(args).toContain("include_apps_instructions=false");
    expect(args).toContain("features.apps=false");
    expect(args).toContain("features.plugins=false");
  });

  test("tools none uses native feature and web-search overrides; default sends none", () => {
    expect(codexSessionToolConfig(undefined)).toEqual({});
    expect(codexSessionToolConfig("default")).toEqual({});
    expect(codexSessionToolConfig("none")).toMatchObject({
      "features.shell_tool": false, "features.unified_exec": false,
      "features.multi_agent": false, "features.browser_use": false,
      "features.computer_use": false, "features.image_generation": false,
      "tools.view_image": false, web_search: "disabled",
    });
  });

  for (const resume of [false, true]) {
    test(`tools none is reapplied on ${resume ? "resumed" : "fresh"} threads with hermetic config`, async () => {
      const session = await startAndWait({
        resumeThreadId: resume ? THREAD : null, tools: "none", autonomy: "read-only", hermetic: true,
      });
      try {
        const request = fakeRecord(session, "requests.jsonl").find((entry) =>
          entry.method === (resume ? "thread/resume" : "thread/start"));
        expect(request?.params.config).toEqual({
          project_doc_max_bytes: 0, project_doc_fallback_filenames: [], ...codexSessionToolConfig("none"),
        });
        expect(request?.params.approvalPolicy).toBe("never");
      } finally { send(session.driver, { type: "shutdown" }); expect(await session.code).toBe(0); }
    });

    test(`project settings keep docs on ${resume ? "resumed" : "fresh"} threads and record the mode`, async () => {
      const session = await startAndWait({
        resumeThreadId: resume ? THREAD : null, projectSettings: true, hermetic: true,
      });
      try {
        const request = fakeRecord(session, "requests.jsonl").find((entry) =>
          entry.method === (resume ? "thread/resume" : "thread/start"));
        expect(request?.params.config).toBeUndefined();
        const registry = readRegistry(session.options.registryPath!);
        expect(registry.outcome).toBe("ok");
        if (registry.outcome === "ok") {
          expect(registry.file.sessions[0]?.project_settings).toBe(true);
          expect(registry.file.sessions[0]?.hermetic).toBe(true);
        }
      } finally { send(session.driver, { type: "shutdown" }); expect(await session.code).toBe(0); }
    });
  }

  for (const resumed of [false, true]) test(`Playwright registration records the actual flag on ${resumed ? "resume" : "fresh start"}`, async () => {
    const session = await startAndWait({ playwrightMcp: true, autonomy: "low", resumeThreadId: resumed ? THREAD : null });
    try {
      const registry = readRegistry(session.options.registryPath!);
      expect(registry.outcome).toBe("ok");
      if (registry.outcome === "ok") expect(registry.file.sessions[0]?.playwright_mcp).toBe(true);
    } finally { send(session.driver, { type: "shutdown" }); expect(await session.code).toBe(0); }
  });

  test("project trust preserves a private provider configuration", () => {
    const parent = join(process.cwd(), "scratch", "fix", "codex-project-provider");
    mkdirSync(parent, { recursive: true });
    const home = mkdtempSync(join(parent, "home-"));
    try {
      writeCodexProviderConfigInto(home, OVERRIDE, OVERRIDE.model, null);
      writeCodexProjectSettingsConfig(home, home, true);
      const config = Bun.TOML.parse(readFileSync(join(home, "config.toml"), "utf8")) as any;
      expect(config.model_provider).toBe("codemux");
      expect(config.model).toBe(OVERRIDE.model);
      // The parent repository is the nearest .git ancestor of this fixture.
      expect(Object.values(config.projects)).toContainEqual({ trust_level: "trusted" });
      expect(config.model_providers.codemux.base_url).toBe(OVERRIDE.baseUrl);
      expect(readFileSync(join(home, "config.toml"), "utf8")).not.toContain(OVERRIDE.apiKey);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("the run twin carries provider configuration and project trust together", () => {
    const parent = join(process.cwd(), "scratch", "fix", "codex-project-provider");
    mkdirSync(parent, { recursive: true });
    const home = mkdtempSync(join(parent, "run-"));
    const adapter = new CodexAdapter({
      CODEMUX_CODEX_PROVIDER_BASE_URL: OVERRIDE.baseUrl,
      CODEMUX_CODEX_PROVIDER_API_KEY: OVERRIDE.apiKey,
      CODEMUX_CODEX_PROVIDER_MODEL: OVERRIDE.model,
    }, home);
    const request = { agent: "codex" as const, prompt: "p", cwd: home,
      hermetic: true, sandboxed: true, autonomy: "low" as const, experimentProjectSettings: true };
    try {
      const context = adapter.prepareRun(request);
      try {
        const config = Bun.TOML.parse(readFileSync(join(context.hermeticHome!.codexHome, "config.toml"), "utf8")) as any;
        expect(config.model_provider).toBe("codemux");
        expect(Object.values(config.projects)).toContainEqual({ trust_level: "trusted" });
        expect(adapter.buildRunCommand(request, context)).not.toContain("--ignore-user-config");
      } finally { adapter.cleanupRun(context); }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
