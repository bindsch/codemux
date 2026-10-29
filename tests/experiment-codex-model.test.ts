import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import { codexCatalogProviderTable } from "../src/experiment-codex-config.js";
import { codexExperimentModel } from "../src/experiment-codex-model.js";
import { CodexRolloutParser } from "../src/experiment-codex-parser.js";
import type { RunRequest } from "../src/types.js";
import { codexCatalog, codexDefinitions } from "./fixtures/experiment-codex.js";

const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_CACHE_BYTES = 2 * MAX_CATALOG_BYTES;
const CLIENT_VERSION = "0.165.0";

function fixture() {
  const parent = resolve("scratch/session-14c66a93/exp/codex-model-fixtures");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  const home = join(cwd, "operator");
  const codexHome = join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const sourcePath = join(codexHome, "models_cache.json");
  const cache = (models: unknown[], extra: Record<string, unknown> = {}) => {
    const source = JSON.stringify({ models, fetched_at: "2026-10-29T00:00:00Z", client_version: CLIENT_VERSION, ...extra });
    writeFileSync(sourcePath, source);
    return source;
  };
  return { cwd, home, codexHome, sourcePath, cache };
}

function expectFailure(action: () => unknown, code: string, detail: string) {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ name: "ExperimentFailure", code });
  expect((failure as Error).message).toContain(detail);
  return failure as Error;
}

test("catalog provider table uses its custom id with the same OpenAI transport and authentication", () => {
  const url = "http://127.0.0.1:43123/catalog/synthetic-nonce";
  const table = codexCatalogProviderTable(CLIENT_VERSION, url);
  expect(table).toBe([
    "[model_providers.codemux-experiment]",
    'name = "OpenAI"',
    'wire_api = "responses"',
    `http_headers = { version = "${CLIENT_VERSION}" }`,
    'env_http_headers = { "OpenAI-Organization" = "OPENAI_ORGANIZATION", "OpenAI-Project" = "OPENAI_PROJECT" }',
    "requires_openai_auth = true",
    "supports_websockets = true",
    "supports_standalone_web_search = true",
    `model_catalog_url = "${url}"`,
  ].join("\n"));
  expect(table).not.toContain("base_url");
  expect(table).not.toContain("[model_providers.openai]");
});

test.each(["code_mode", "code_mode_only"])("rewrites only requested tool_mode %s and preserves all other model data", (mode) => {
  const { codexHome, sourcePath, cache } = fixture();
  const requested = { slug: "gpt-6.1-sol", tool_mode: mode, supports_search_tool: true, display_name: "Exact model", priority: 4,
    nested: { tool_mode: "keep", instructions: ["first\nsecond", "é", null] }, future_flag: true };
  const other = { slug: "other", tool_mode: "code_mode_only", nested: { arbitrary: 3 }, tools: [] };
  const source = cache([other, requested], { etag: "source-metadata-is-not-catalog-data" });
  const result = codexExperimentModel(requested.slug, codexHome);
  const { tool_mode: _removed, ...expected } = requested;
  expect(result.model).toBe(requested.slug);
  expect(result.clientVersion).toBe(CLIENT_VERSION);
  expect(result.sourcePath).toBe(sourcePath);
  expect(JSON.parse(result.catalog!.body)).toEqual({ models: [other, expected] });
  expect(result.catalog!.override).toEqual({ slug: requested.slug, source_path: sourcePath,
    source_fetched_at: "2026-10-29T00:00:00Z", served_models: 2,
    served_bytes: Buffer.byteLength(result.catalog!.body), removed: ["tool_mode"], requested_only: false });
  expect(readFileSync(sourcePath, "utf8")).toBe(source);
});

test.each(["direct", null, undefined])("does not override requested mode %j despite another code-mode entry", (mode) => {
  const { codexHome, sourcePath, cache } = fixture();
  cache([{ slug: "gpt-6.1-sol", tool_mode: mode }, { slug: "other", tool_mode: "code_mode_only" }]);
  expect(codexExperimentModel("gpt-6.1-sol", codexHome)).toEqual({ model: "gpt-6.1-sol", clientVersion: CLIENT_VERSION, sourcePath });
});

test("serves the complete catalog at exactly 1 MiB", () => {
  const { codexHome, cache } = fixture();
  const requested = { slug: "requested", tool_mode: "code_mode", instructions: "" };
  const other = { slug: "other", payload: "kept" };
  const bytes = Buffer.byteLength(JSON.stringify({ models: [{ slug: requested.slug, instructions: "" }, other] }));
  requested.instructions = "x".repeat(MAX_CATALOG_BYTES - bytes);
  cache([requested, other]);
  const catalog = codexExperimentModel(requested.slug, codexHome).catalog!;
  expect(Buffer.byteLength(catalog.body)).toBe(MAX_CATALOG_BYTES);
  expect(catalog.override).toMatchObject({ served_models: 2, served_bytes: MAX_CATALOG_BYTES, requested_only: false });
  expect(JSON.parse(catalog.body).models[1]).toEqual(other);
});

test("serves only the requested entry when full UTF-8 catalog exceeds 1 MiB", () => {
  const { codexHome, cache } = fixture();
  const requested = { slug: "requested", tool_mode: "code_mode_only", payload: "retain" };
  const other = { slug: "other", payload: "é".repeat(MAX_CATALOG_BYTES / 2) };
  cache([other, requested]);
  const catalog = codexExperimentModel(requested.slug, codexHome).catalog!;
  expect(JSON.parse(catalog.body)).toEqual({ models: [{ slug: requested.slug, payload: "retain" }] });
  expect(catalog.override).toMatchObject({ served_models: 1, requested_only: true,
    served_bytes: Buffer.byteLength(catalog.body) });
});

test("refuses a requested entry whose UTF-8 serialization alone exceeds 1 MiB", () => {
  const { codexHome, sourcePath, cache } = fixture();
  cache([{ slug: "requested", tool_mode: "code_mode_only", payload: "é".repeat(MAX_CATALOG_BYTES / 2) }]);
  expectFailure(() => codexExperimentModel("requested", codexHome), "code_mode", sourcePath);
});

test("accepts a 2 MiB source cache and strips source metadata before measuring catalog", () => {
  const { codexHome, sourcePath, cache } = fixture();
  const models = [{ slug: "requested", tool_mode: "code_mode_only" }];
  const base = cache(models, { padding: "" });
  cache(models, { padding: "x".repeat(MAX_CACHE_BYTES - Buffer.byteLength(base)) });
  expect(Buffer.byteLength(readFileSync(sourcePath))).toBe(MAX_CACHE_BYTES);
  const result = codexExperimentModel("requested", codexHome);
  expect(JSON.parse(result.catalog!.body)).toEqual({ models: [{ slug: "requested" }] });
  expect(result.catalog!.override.requested_only).toBe(false);
});

test("refuses a UTF-8 source cache one byte above 2 MiB", () => {
  const { codexHome, sourcePath, cache } = fixture();
  const models = [{ slug: "requested", tool_mode: "code_mode_only" }];
  const base = cache(models, { padding: "é" });
  cache(models, { padding: "é" + "x".repeat(MAX_CACHE_BYTES - Buffer.byteLength(base) + 1) });
  expect(Buffer.byteLength(readFileSync(sourcePath))).toBe(MAX_CACHE_BYTES + 1);
  expectFailure(() => codexExperimentModel("requested", codexHome), "code_mode", sourcePath);
});

test.each(["missing", "directory", "malformed", "invalid-utf8"])("refuses %s source with its path and no bundled fallback", (kind) => {
  const { codexHome, sourcePath } = fixture();
  if (kind === "directory") mkdirSync(sourcePath);
  if (kind === "malformed") writeFileSync(sourcePath, "{broken");
  if (kind === "invalid-utf8") writeFileSync(sourcePath, Buffer.from([0xff]));
  expectFailure(() => codexExperimentModel("gpt-6.1-sol", codexHome), "code_mode", sourcePath);
});

test("does not expose malformed source bytes in its failure message", () => {
  const { codexHome, sourcePath } = fixture();
  const syntheticSecret = "SYNTHETIC_CACHE_SECRET";
  writeFileSync(sourcePath, syntheticSecret);
  let failure: unknown;
  try { codexExperimentModel("requested", codexHome); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ name: "ExperimentFailure", code: "code_mode" });
  expect((failure as Error).message).toContain(sourcePath);
  expect((failure as Error).message).not.toContain(syntheticSecret);
});

test.each([null, [], {}, { models: {} }, { models: "invalid" }].map((value) => ({ value })))("refuses an invalid cache structure %#", ({ value }) => {
  const { codexHome, sourcePath } = fixture();
  writeFileSync(sourcePath, JSON.stringify(value));
  expectFailure(() => codexExperimentModel("requested", codexHome), "code_mode", sourcePath);
});

test.each([undefined, null, "", "  ", 165, "0.165.0\n"])("requires a valid client_version in source cache %#", (client_version) => {
  const { codexHome, sourcePath, cache } = fixture();
  cache([{ slug: "requested", tool_mode: "direct" }], { client_version });
  expectFailure(() => codexExperimentModel("requested", codexHome), "code_mode", sourcePath);
});

test.each([[], [{ slug: "other", tool_mode: "direct" }]].map((models) => ({ models })))("refuses a missing requested slug %#", ({ models }) => {
  const { codexHome, sourcePath, cache } = fixture();
  cache(models);
  const failure = expectFailure(() => codexExperimentModel("requested", codexHome), "model_unavailable", sourcePath);
  expect(failure.message).toContain("absent from the account's catalog");
  expect(failure.message).toContain("fetched_at: 2026-10-29T00:00:00Z");
  expect(failure.message).toContain("Codex itself could not run it");
  expect(failure.message).toContain(`Catalog listed slugs: ${models.length ? '"other"' : "<none>"}`);
});

test("unavailable model failure lists unique catalog slugs in cache order without model metadata", () => {
  const { codexHome, sourcePath, cache } = fixture();
  cache([{ slug: "gpt-6-astra", tool_mode: "code_mode_only", instructions: "SYNTHETIC_PRIVATE_INSTRUCTIONS" },
    { slug: "gpt-6.1-sol", tool_mode: "code_mode" }, { slug: "gpt-6-astra", tool_mode: "direct" }],
  { fetched_at: "2026-10-29T00:10:00.123456Z", identity: "SYNTHETIC_PRIVATE_IDENTITY" });
  const failure = expectFailure(() => codexExperimentModel("gpt-5.5", codexHome), "model_unavailable", sourcePath);
  expect(failure.message).toBe(`Codex experiment model "gpt-5.5" is absent from the account's catalog: ${sourcePath} ` +
    '(fetched_at: 2026-10-29T00:10:00.123456Z). Codex itself could not run it. Catalog listed slugs: "gpt-6-astra", "gpt-6.1-sol".');
  expect(failure.message).not.toContain("SYNTHETIC_PRIVATE");
});

test.each([undefined, null, { secret: "SYNTHETIC_PRIVATE_TIMESTAMP" }, "SYNTHETIC_PRIVATE_TIMESTAMP", 123])(
  "unavailable model failure sanitizes absent or malformed fetched_at %#", (fetched_at) => {
    const { codexHome, sourcePath, cache } = fixture();
    cache([{ slug: "available", tool_mode: "direct" }], { fetched_at });
    const failure = expectFailure(() => codexExperimentModel("requested", codexHome), "model_unavailable", sourcePath);
    expect(failure.message).toContain(`fetched_at: ${fetched_at === undefined ? "<missing>" : "<invalid>"}`);
    expect(failure.message).not.toContain("SYNTHETIC_PRIVATE");
    expect(failure.message).toContain('Catalog listed slugs: "available"');
  });

test("unavailable model failure omits malformed slug fields without rendering their contents", () => {
  const { codexHome, sourcePath, cache } = fixture();
  cache([null, 123, {}, { slug: { secret: "SYNTHETIC_PRIVATE_SLUG" } },
    { slug: "SYNTHETIC_PRIVATE_SLUG\n" }, { slug: "available", tool_mode: "direct" }]);
  const failure = expectFailure(() => codexExperimentModel("requested", codexHome), "model_unavailable", sourcePath);
  expect(failure.message).toContain('Catalog listed slugs: "available".');
  expect(failure.message).not.toContain("SYNTHETIC_PRIVATE");
});

test("refuses duplicate descriptors for the requested slug", () => {
  const { codexHome, sourcePath, cache } = fixture();
  cache([{ slug: "requested", tool_mode: "direct" }, { slug: "requested", tool_mode: "code_mode" }]);
  expectFailure(() => codexExperimentModel("requested", codexHome), "code_mode", sourcePath);
});

test.each(["future-mode", false, 1, {}])("refuses an unsupported requested tool mode %#", (tool_mode) => {
  const { codexHome, sourcePath, cache } = fixture();
  cache([{ slug: "requested", tool_mode }]);
  expectFailure(() => codexExperimentModel("requested", codexHome), "code_mode", sourcePath);
});

test.each(["2026-10-29T00:00:00Z", { opaque: true }, null, 0])("records fetched_at exactly %#", (fetched_at) => {
  const { codexHome, cache } = fixture();
  cache([{ slug: "requested", tool_mode: "code_mode" }], { fetched_at });
  expect(codexExperimentModel("requested", codexHome).catalog!.override.source_fetched_at).toEqual(fetched_at);
});

test("records absent fetched_at as null", () => {
  const { codexHome, cache } = fixture();
  cache([{ slug: "requested", tool_mode: "code_mode" }], { fetched_at: undefined });
  expect(codexExperimentModel("requested", codexHome).catalog!.override.source_fetched_at).toBeNull();
});

test("requires an explicit model even when real config has a default", () => {
  const { codexHome, cache } = fixture();
  cache([{ slug: "gpt-5.5", tool_mode: "direct" }]);
  writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n');
  expectFailure(() => codexExperimentModel(undefined, codexHome), "model_required", "--model");
});

test("requires an explicit model before attempting to read cache", () => {
  const { codexHome } = fixture();
  expectFailure(() => codexExperimentModel(undefined, codexHome), "model_required", "--model");
});

test("reads the specified real home without consulting another home", () => {
  const real = fixture();
  const other = fixture();
  real.cache([{ slug: "requested", tool_mode: "code_mode_only", marker: "real" }]);
  other.cache([{ slug: "requested", tool_mode: "direct", marker: "other" }]);
  const catalog = codexExperimentModel("requested", real.codexHome).catalog!;
  expect(catalog.override.source_path).toBe(real.sourcePath);
  expect(JSON.parse(catalog.body)).toEqual({ models: [{ slug: "requested", marker: "real" }] });
});

test("experiment flags disable configurable code mode without changing ordinary launches", () => {
  const { cwd, home, cache } = fixture();
  cache([{ slug: "gpt-5.5", tool_mode: "direct" }]);
  const request: RunRequest = { agent: "codex", prompt: "fixture", cwd, model: "gpt-5.5",
    hermetic: true, tools: "none", autonomy: "read-only", experimentMcp: "synthetic-spec.json" };
  const adapter = new CodexAdapter({ HOME: home, CODEX_API_KEY: "synthetic" }, home);
  const command = adapter.buildRunCommand(request);
  const disabled = command.flatMap((value, index) => value === "--disable" ? [command[index + 1]] : []);
  expect(disabled).toContain("code_mode");
  expect(disabled).toContain("code_mode_host");
  const ordinary = adapter.buildRunCommand({ ...request, experimentMcp: undefined });
  expect(ordinary).not.toContain("code_mode");
  expect(ordinary).not.toContain("code_mode_host");
});

test.each(["custom_tool_call", "function_call"])("classifies outside exec as code_mode for %s", (type) => {
  const records: Record<string, unknown>[] = [];
  const parser = new CodexRolloutParser("thread", "experiment", () => new Set(["bash"]),
    (kind, fields) => { records.push({ kind, ...fields }); }, () => codexDefinitions(["bash"]));
  parser.accept(codexCatalog(["bash"])); records.length = 0;
  expectFailure(() => parser.accept({ timestamp: "2026-10-29T01:02:03Z", type: "response_item",
    payload: { type, id: "outside", call_id: "native-exec", name: "exec", arguments: "{}", input: "text(ALL_TOOLS)" } }), "code_mode", "exec");
  expect(records[0]).toMatchObject({ kind: "tool_call", name: "exec", allowed: false });
});

test.each(["custom_tool_call", "function_call"])("names an unknown tool instead of its %s item type", (type) => {
  const parser = new CodexRolloutParser("thread", "experiment", () => new Set(["bash"]), () => {}, () => codexDefinitions(["bash"]));
  parser.accept(codexCatalog(["bash"]));
  expectFailure(() => parser.accept({ timestamp: "2026-10-29T01:02:03Z", type: "response_item", payload: {
    type, id: "outside", call_id: "native-foreign", name: "foreign_tool", namespace: "functions",
    arguments: "{}", input: "ignored" } }), "unknown_tool", "foreign_tool");
});

test("an experiment tool named exec remains an allowed direct function call", () => {
  const parser = new CodexRolloutParser("thread", "experiment", () => new Set(["exec"]), () => {}, () => codexDefinitions(["exec"]));
  parser.accept(codexCatalog(["exec"]));
  expect(() => parser.accept({ timestamp: "2026-10-29T01:02:03Z", type: "response_item", payload: {
    type: "function_call", id: "experiment-exec", call_id: "native-exec", namespace: "mcp__experiment",
    name: "exec", arguments: "{}" } })).not.toThrow();
  expect(parser.calls[0]).toMatchObject({ callId: "native-exec", name: "exec", input: {} });
});
