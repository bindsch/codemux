import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import { codexNoToolsCatalogArgs, codexNoToolsCatalogBody, needsCodexNoToolsCatalog, prepareCodexNoToolsCatalog } from "../src/codex-no-tools.js";
import type { RunRequest } from "../src/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(environment: NodeJS.ProcessEnv = {}) {
  const parent = join(process.cwd(), "scratch", "fix", "codex-no-tools");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "case-"));
  roots.push(root);
  const home = join(root, "home"), cwd = join(root, "work"), codexHome = join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(cwd);
  mkdirSync(join(cwd, ".git"));
  const cache = join(codexHome, "models_cache.json");
  writeFileSync(cache, JSON.stringify({ client_version: "0.166.0", models: [
    { slug: "selected", display_name: "Selected", tool_mode: "code_mode", apply_patch_tool_type: "freeform", multi_agent_version: "v2", experimental_supported_tools: ["clock", "search"] },
    { slug: "fallback", display_name: "Fallback", apply_patch_tool_type: "function" },
  ] }));
  const adapter = new CodexAdapter({ CODEX_API_KEY: "synthetic-native-key", ...environment }, home);
  const request: RunRequest = { agent: "codex", prompt: "p", cwd, tools: "none", model: "selected", autonomy: "high" };
  return { root, home, cwd, codexHome, cache, adapter, request };
}

describe("Codex native catalog for writable tools none", () => {
  test.each(["low", "medium", "high"] as const)("%s removes model-selected tools from every catalog entry", (autonomy) => {
    const { adapter, request, cache } = fixture();
    request.autonomy = autonomy;
    const original = readFileSync(cache, "utf8");
    expect(adapter.capabilities().toolsNoneRequiresReadOnly).toBe(false);
    expect(() => adapter.validateRunRequest(request)).not.toThrow();
    const context = adapter.prepareRun(request);
    context.harnessVersion = "0.166.0";
    const args = adapter.buildRunCommand(request, context);
    const assignment = args.find((arg) => arg.startsWith("model_catalog_json="))!;
    const path = JSON.parse(assignment.slice("model_catalog_json=".length)) as string;
    try {
      expect(args).toContain("code_mode");
      expect(args).toContain("multi_agent_v2.disable_native_tools=true");
      expect(args[0]).toBe("codex");
      expect(path.startsWith(context.lastMessageDir!)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ models: [
        { slug: "selected", display_name: "Selected", apply_patch_tool_type: null, experimental_supported_tools: ["search"] },
        { slug: "fallback", display_name: "Fallback", apply_patch_tool_type: null },
      ] });
      expect(readFileSync(cache, "utf8")).toBe(original);
    } finally { adapter.cleanupRunSync(context); }
    expect(existsSync(path)).toBe(false);
  });

  test("the local file preserves a hermetic provider override's transport and model", () => {
    const { adapter, request } = fixture({
      CODEMUX_CODEX_PROVIDER_BASE_URL: "https://synthetic.invalid/v1",
      CODEMUX_CODEX_PROVIDER_API_KEY: "synthetic-override-key",
      CODEMUX_CODEX_PROVIDER_MODEL: "selected",
    });
    request.hermetic = true;
    delete request.model;
    expect(() => adapter.validateRunRequest(request)).not.toThrow();
    const context = adapter.prepareRun(request);
    context.harnessVersion = "0.166.0";
    try {
      const args = adapter.buildRunCommand(request, context);
      expect(args.some((arg) => arg.startsWith("model_catalog_json="))).toBe(true);
      expect(args).not.toContain("--ignore-user-config");
      const config = readFileSync(join(context.hermeticHome!.codexHome, "config.toml"), "utf8");
      expect(config).toContain('model_provider = "codemux"');
      expect(config).toContain('base_url = "https://synthetic.invalid/v1"');
      expect(config).not.toContain("model_catalog_url");
      expect(config).not.toContain("synthetic-override-key");
    } finally { adapter.cleanupRunSync(context); }
  });

  test("an unspecified or uncached model fails before launch-owned directories are created", () => {
    const { adapter, request, codexHome } = fixture();
    delete request.model;
    expect(() => adapter.validateRunRequest(request)).toThrow("requires an explicit --model");
    expect(() => adapter.prepareRun(request)).toThrow("requires an explicit --model");
    expect(() => codexNoToolsCatalogBody("missing", codexHome)).toThrow("absent from the account's catalog");
    expect(readdirSync(codexHome)).toEqual(["models_cache.json"]);
  });

  test("malformed cache data fails without printing the source bytes", () => {
    const { cache, codexHome } = fixture();
    writeFileSync(cache, "SYNTHETIC_PRIVATE_CACHE_VALUE");
    let failure: unknown;
    try { codexNoToolsCatalogBody("selected", codexHome); } catch (error) { failure = error; }
    expect((failure as Error).message).toContain("cannot prepare its native model catalog");
    expect((failure as Error).message).not.toContain("SYNTHETIC_PRIVATE_CACHE_VALUE");
  });

  test("read-only and experiment launches retain their existing catalog policies", () => {
    const { request, codexHome } = fixture();
    expect(needsCodexNoToolsCatalog({ ...request, autonomy: "read-only" })).toBe(false);
    expect(needsCodexNoToolsCatalog({ ...request, autonomy: undefined })).toBe(false);
    expect(needsCodexNoToolsCatalog({ ...request, tools: "default" })).toBe(false);
    expect(needsCodexNoToolsCatalog({ ...request, experimentMcp: "spec.json" })).toBe(false);
    expect(codexNoToolsCatalogArgs({ ...request, autonomy: "read-only" }, {}, codexHome)).toEqual([]);
  });

  test("static previews fail closed and actual launches need a readable state path", () => {
    const { adapter, request, codexHome } = fixture();
    for (const hermetic of [false, true]) {
      expect(codexNoToolsCatalogArgs({ ...request, hermetic }, undefined, codexHome).join(" ")).toContain("unprepared/no-tools-model-catalog.json");
    }
    expect(() => prepareCodexNoToolsCatalog({}, "{}")).toThrow("sandbox-readable catalog file");
    expect(() => adapter.prepareRun(request, "untrusted")).toThrow("sandbox-readable catalog file");
    expect(() => adapter.prepareRun({ ...request, hermetic: true }, "untrusted")).toThrow("sandbox-readable catalog file");
  });

  test("a launch with a missing, malformed, or older version cannot silently ignore the catalog", () => {
    const { request, codexHome } = fixture();
    for (const harnessVersion of [undefined, null, "invalid", "0.165.0"]) {
      expect(() => codexNoToolsCatalogArgs(request, { harnessVersion }, codexHome)).toThrow("requires verified Codex 0.166.0");
    }
  });
});
