import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { durableFs } from "../src/fs-durable.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { pinCodexSessionCatalogBinary, prepareCodexSessionCatalog, type CodexSessionCatalog } from "../src/session/codex-catalog.js";
import { codexSessionToolConfig, validateCodexSessionTools } from "../src/session/codex-config.js";
import { CodexSessionDriver, type CodexDriverOptions } from "../src/session/codex-driver.js";
import { buildCodexSessionCommand } from "../src/session/codex-session.js";
import { SessionProcess } from "../src/session/process.js";
import type { RunRequest } from "../src/types.js";
import { FAKE, waitFor } from "./session-codex-e2e-helpers.js";

const roots: string[] = [];
const catalogs: CodexSessionCatalog[] = [];
afterEach(() => {
  for (const catalog of catalogs.splice(0)) catalog.remove();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const parent = join(process.cwd(), "scratch", "fix", "codex-session-catalog");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "case-"));
  roots.push(root);
  const realCodexHome = join(root, "state"), cwd = join(root, "work"), binaryPath = join(root, "fake-codex");
  mkdirSync(realCodexHome, { mode: 0o700 });
  mkdirSync(cwd);
  // This inert file is read and pinned, never executed. The only child is
  // the existing synthetic JSON-RPC server run explicitly by Bun below.
  writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(join(realCodexHome, "models_cache.json"), JSON.stringify({ client_version: "0.166.0", models: [
    { slug: "selected", tool_mode: "code_mode", apply_patch_tool_type: "freeform", multi_agent_version: "v2", experimental_supported_tools: ["clock", "search"] },
    { slug: "fallback", apply_patch_tool_type: "function" },
  ] }));
  const request: RunRequest = { agent: "codex", prompt: "p", cwd, model: "selected", tools: "none", autonomy: "high" };
  const binary = pinCodexSessionCatalogBinary(request, binaryPath, cwd, "")!;
  const options = { request, realCodexHome, binary, harnessVersion: "0.166.0" };
  return { root, cwd, binaryPath, options };
}

function prepare(options: Parameters<typeof prepareCodexSessionCatalog>[0]): CodexSessionCatalog {
  const catalog = prepareCodexSessionCatalog(options)!;
  catalogs.push(catalog);
  return catalog;
}

async function drive(f: ReturnType<typeof fixture>, catalog: CodexSessionCatalog, resume: boolean, provider: boolean) {
  const state = join(f.root, "fake-server");
  mkdirSync(state);
  const events: Record<string, any>[] = [];
  const options: CodexDriverOptions = {
    resumeThreadId: resume ? "0123456789abcdef" : null, autonomy: f.options.request.autonomy!,
    model: "selected", modelAlias: "worker", wireModel: provider ? null : undefined,
    tools: "none", noToolsCatalog: catalog, hermetic: true, cwd: f.cwd,
    sandboxed: true, sandboxTrust: "standard", sandboxNoNet: true, sandboxScrubEnv: true,
    passEnv: [], authorPrefix: false, permissionTimeoutMs: 1000, turnTimeoutMs: null, sessionTimeoutMs: null,
    registryPath: null, harnessHome: f.options.realCodexHome,
    providerBaseUrl: provider ? "https://synthetic.invalid/v1" : null,
    sink: (line) => { events.push(JSON.parse(line)); },
  };
  const driver = new CodexSessionDriver(options);
  const proc = new SessionProcess({
    command: ["bun", FAKE], cwd: f.cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: f.root, FAKE_STATE_DIR: state, FAKE_CWD: f.cwd },
    graceMs: 100, onLine: (line) => driver.handleHarnessLine(line), onFatal: (fatal) => driver.handleFatal(fatal),
  });
  driver.attach(proc);
  const code = driver.run();
  try {
    await waitFor(events, (all) => all.find((event) => event.type === "session_started"), "session started");
    const requests = readFileSync(join(state, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const thread = requests.find((frame) => frame.method === (resume ? "thread/resume" : "thread/start"));
    expect(thread.params.config).toEqual({
      project_doc_max_bytes: 0, project_doc_fallback_filenames: [], ...codexSessionToolConfig("none", catalog),
    });
    expect(thread.params.approvalPolicy).toBe("on-request");
    expect(thread.params.sandbox).toBe(options.autonomy === "high" ? "danger-full-access" : "read-only");
    expect(thread.params.model).toBe(provider ? undefined : "selected");
    expect(events.find((event) => event.type === "session_started")?.model_alias).toBe("worker");
    expect(existsSync(catalog.path)).toBe(true);
  } finally {
    driver.handleCallerLine(JSON.stringify({ type: "shutdown" }));
    expect(await code).toBe(0);
    await proc.settled;
    driver.dispose();
  }
}

describe("Codex session native tool-free model catalog", () => {
  test("native effort none survives run and TUI validation and argv construction", () => {
    const f = fixture();
    const adapter = new CodexAdapter({}, f.root);
    const request = { ...f.options.request, tools: "default" as const, effort: "none" as const };
    expect(() => adapter.validateRunRequest(request)).not.toThrow();
    expect(() => adapter.validateTuiRequest("selected", f.cwd, "high", "none")).not.toThrow();
    expect(adapter.buildRunCommand(request)).toContain('model_reasoning_effort="none"');
    expect(adapter.buildTuiCommand("selected", "high", "none")).toContain('model_reasoning_effort="none"');
  });
  for (const autonomy of ["low", "medium", "high"] as const) {
    for (const resume of [false, true]) {
      test(`${autonomy}, ${resume ? "resume" : "fresh"}: startup and thread use one catalog without changing providers`, async () => {
        for (const provider of [false, true]) {
          const f = fixture();
          f.options.request.autonomy = autonomy;
          const configPath = join(f.options.realCodexHome, "config.toml");
          const config = provider ? 'model_provider="custom"\nmodel="selected"\n' : 'model_provider="openai"\n';
          writeFileSync(configPath, config);
          const catalog = prepare(f.options);
          const argv = buildCodexSessionCommand(["CODEX_HOME=/synthetic/state"], [], {
            tools: "none", noToolsCatalog: catalog, hermetic: true,
          });
          expect(argv[2]).toBe(f.binaryPath);
          expect(argv).toContain(`model_catalog_json=${JSON.stringify(catalog.path)}`);
          expect(argv).toContain("features.code_mode=false");
          expect(argv).toContain("multi_agent_v2.disable_native_tools=true");
          expect(argv.join(" ")).not.toContain("model_provider");
          expect(statSync(catalog.dir).mode & 0o777).toBe(0o700);
          expect(statSync(catalog.path).mode & 0o777).toBe(0o600);
          expect(JSON.parse(readFileSync(catalog.path, "utf8"))).toEqual({ models: [
            { slug: "selected", apply_patch_tool_type: null, experimental_supported_tools: ["search"] },
            { slug: "fallback", apply_patch_tool_type: null },
          ] });
          await drive(f, catalog, resume, provider);
          expect(readFileSync(configPath, "utf8")).toBe(config);
          expect(catalog.remove()).toBe(true);
          expect(catalog.remove()).toBe(true);
          expect(existsSync(catalog.path)).toBe(false);
          expect(() => validateCodexSessionTools("none", autonomy, catalog)).toThrow("already been removed");
        }
      });
    }
  }

  test("default and read-only sessions need no binary, file, or version", () => {
    const f = fixture();
    for (const request of [{ ...f.options.request, tools: "default" as const }, { ...f.options.request, autonomy: "read-only" as const }]) {
      expect(pinCodexSessionCatalogBinary(request, "/missing", f.cwd, "")).toBeNull();
      expect(prepareCodexSessionCatalog({ ...f.options, request, binary: null, harnessVersion: null })).toBeNull();
    }
  });

  test("version, executable pin, sandbox policy, and model prerequisites fail before creating state", () => {
    const f = fixture();
    for (const harnessVersion of [null, "invalid", "0.165.0"]) {
      expect(() => prepareCodexSessionCatalog({ ...f.options, harnessVersion })).toThrow("requires verified Codex 0.166.0");
    }
    expect(() => prepareCodexSessionCatalog({ ...f.options, binary: null })).toThrow("executable pin");
    expect(() => prepareCodexSessionCatalog({ ...f.options, sandboxOptions: { trust: "untrusted" } })).toThrow("sandbox-readable");
    expect(() => prepareCodexSessionCatalog({ ...f.options, callerBlockPaths: [f.options.realCodexHome] })).toThrow("covers the launch's own harness state");
    expect(() => prepareCodexSessionCatalog({ ...f.options, request: { ...f.options.request, model: undefined } })).toThrow("explicit --model");
    expect(readdirSync(f.options.realCodexHome)).toEqual(["models_cache.json"]);
  });

  test("a preview is write-free, retains sandbox options, and cannot start a driver", () => {
    const f = fixture();
    const sandboxOptions = { trust: "standard" as const, noNet: true, scrubEnv: true,
      blockPaths: [f.options.realCodexHome], harnessStateDirs: ["/synthetic/prior-state"] };
    const catalog = prepare({ ...f.options, sandboxOptions, printOnly: true });
    expect(catalog.path).toContain("/unprepared/no-tools-model-catalog.json");
    expect(catalog.sandboxOptions).toEqual({ ...sandboxOptions, harnessStateDirs: [...sandboxOptions.harnessStateDirs, catalog.dir] });
    expect(() => validateCodexSessionTools("none", "high", catalog)).toThrow("preview cannot launch");
    expect(catalog.remove()).toBe(true);
    expect(readdirSync(f.options.realCodexHome)).toEqual(["models_cache.json"]);
  });

  test("sandboxed sessions re-allow only their catalog directory and preserve every policy option", () => {
    const f = fixture();
    const sandboxOptions = { trust: "trusted" as const, noNet: true, scrubEnv: true,
      blockPaths: [f.options.realCodexHome], harnessStateDirs: ["/synthetic/prior-state"], keepEnv: ["SYNTHETIC_KEY"] };
    const catalog = prepare({ ...f.options, sandboxOptions });
    expect(catalog.sandboxOptions).toEqual({ ...sandboxOptions, harnessStateDirs: [...sandboxOptions.harnessStateDirs, catalog.dir] });
    expect(sandboxOptions.harnessStateDirs).toEqual(["/synthetic/prior-state"]);
    expect(() => catalog.assertPrepared()).not.toThrow();
    writeFileSync(catalog.path, "{}");
    expect(() => catalog.assertPrepared()).toThrow("catalog changed before launch");
  });

  test("the version-probed executable identity remains pinned through spawn preparation", () => {
    const f = fixture();
    const catalog = prepare(f.options);
    writeFileSync(f.binaryPath, "#!/bin/sh\nexit 1\n");
    expect(() => catalog.assertPrepared()).toThrow();
    expect(() => prepareCodexSessionCatalog(f.options)).toThrow();
  });

  test("a failed file write removes the newly created directory", () => {
    const f = fixture();
    const write = spyOn(durableFs, "writeFileSync").mockImplementation(() => { throw new Error("synthetic write failure"); });
    try { expect(() => prepareCodexSessionCatalog(f.options)).toThrow("synthetic write failure"); }
    finally { write.mockRestore(); }
    expect(readdirSync(join(f.options.realCodexHome, ".codemux-scratch"))).toEqual([]);
  });
});
