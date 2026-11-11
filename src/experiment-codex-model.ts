import { join } from "node:path";
import { readUtf8FileBounded } from "./file-io.js";
import { CODEX_EXPERIMENT_CATALOG_REMOVED, codexExperimentCatalogEntry } from "./experiment-codex-catalog.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";
import { MAX_MODEL_NAME_BYTES, validateModelName } from "./validation.js";
import { timestampValid } from "./calendar.js";

const MAX_MODEL_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_BYTES = 1024 * 1024;
const CLIENT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const CATALOG_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const FETCHED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export interface CodexExperimentCatalog {
  body: string;
  override: {
    slug: string;
    source_path: string;
    source_fetched_at: unknown;
    served_models: number;
    served_bytes: number;
    removed: typeof CODEX_EXPERIMENT_CATALOG_REMOVED;
    requested_only: boolean;
  };
}

export interface CodexExperimentModel {
  model: string;
  catalog?: CodexExperimentCatalog;
  clientVersion: string;
  sourcePath: string;
}

/** Read real metadata before preparation replaces CODEX_HOME with a private home. */
export function codexExperimentModel(model: string | undefined, realCodexHome: string): CodexExperimentModel {
  if (model === undefined) {
    throw new ExperimentFailure(Code.ModelRequired, "Codex experiment requires an explicit --model");
  }
  const selected = validateModelName(model);
  const sourcePath = join(realCodexHome, "models_cache.json");
  const cache = readModelCache(sourcePath);
  const clientVersion = cache.client_version;
  if (typeof clientVersion !== "string" || !CLIENT_VERSION_PATTERN.test(clientVersion)) {
    throw sourceFailure(sourcePath, "client_version must be a numeric major.minor.patch string");
  }
  const models = cache.models;
  if (!Array.isArray(models)) throw sourceFailure(sourcePath, "models must be an array");
  const matches = models.filter((value): value is Record<string, unknown> => isObject(value) && value.slug === selected);
  if (matches.length === 0) throw unavailableFailure(selected, sourcePath, cache.fetched_at, models);
  if (matches.length !== 1) {
    throw sourceFailure(sourcePath, `expected exactly one descriptor for model ${selected}; found ${matches.length}`);
  }
  const requested = matches[0]!;
  const mode = requested.tool_mode;
  const selection = { model: selected, clientVersion, sourcePath };
  if (mode != null && mode !== "direct" && mode !== "code_mode" && mode !== "code_mode_only") {
    throw sourceFailure(sourcePath, `model ${selected} has an unsupported tool_mode`);
  }
  const rewritten = codexExperimentCatalogEntry(requested);
  let served = models.map(codexExperimentCatalogEntry);
  let body = JSON.stringify({ models: served });
  let requestedOnly = false;
  if (Buffer.byteLength(body, "utf8") > MAX_CATALOG_BYTES) {
    served = [rewritten];
    body = JSON.stringify({ models: served });
    requestedOnly = true;
  }
  const servedBytes = Buffer.byteLength(body, "utf8");
  if (servedBytes > MAX_CATALOG_BYTES) {
    throw sourceFailure(sourcePath, `model ${selected} alone exceeds the ${MAX_CATALOG_BYTES}-byte catalog limit`);
  }
  return { ...selection, catalog: { body, override: {
    slug: selected, source_path: sourcePath, source_fetched_at: cache.fetched_at ?? null,
    served_models: served.length, served_bytes: servedBytes,
    removed: CODEX_EXPERIMENT_CATALOG_REMOVED, requested_only: requestedOnly,
  } } };
}

function readModelCache(sourcePath: string): Record<string, unknown> {
  try {
    const cache: unknown = JSON.parse(readUtf8FileBounded(sourcePath, {
      maxBytes: MAX_MODEL_CACHE_BYTES, label: "real Codex model cache",
    }));
    if (!isObject(cache)) throw new Error("cache must be an object");
    return cache;
  } catch {
    // Parser diagnostics can include source bytes. Do not expose them.
    throw sourceFailure(sourcePath, `cache must be a readable UTF-8 JSON object within ${MAX_MODEL_CACHE_BYTES} bytes`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourceFailure(sourcePath: string, reason: string): ExperimentFailure {
  return new ExperimentFailure(Code.CodeMode, `Codex experiment cannot use model cache ${sourcePath}: ${reason}`);
}

function unavailableFailure(model: string, sourcePath: string, fetchedAt: unknown, models: unknown[]): ExperimentFailure {
  // Treat diagnostic metadata as untrusted. Never stringify arbitrary cache values.
  const timestamp = fetchedAt === undefined ? "<missing>" :
    typeof fetchedAt === "string" && FETCHED_AT_PATTERN.test(fetchedAt) && timestampValid(fetchedAt)
      ? fetchedAt : "<invalid>";
  const slugs = new Set(models.flatMap((entry) => {
    if (!isObject(entry) || typeof entry.slug !== "string" || entry.slug.length > MAX_MODEL_NAME_BYTES ||
      !CATALOG_SLUG_PATTERN.test(entry.slug)) return [];
    return [entry.slug];
  }));
  const listed = [...slugs].map((slug) => JSON.stringify(slug)).join(", ") || "<none>";
  return new ExperimentFailure(Code.ModelUnavailable,
    `Codex experiment model ${JSON.stringify(model)} is absent from the account's catalog: ${sourcePath} ` +
    `(fetched_at: ${timestamp}). Codex itself could not run it. Catalog listed slugs: ${listed}.`);
}
