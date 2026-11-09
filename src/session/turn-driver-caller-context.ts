import { dirname, join } from "node:path";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import type { BaseAdapter, RunContext } from "../adapters/base.js";
import { readUtf8FileBounded } from "../file-io.js";
import { writeOwnedSync } from "../fs-durable.js";
import { writeDroidProviderSettings } from "../droid-provider.js";
import { geminiPlaywrightSettings } from "../gemini-mcp.js";
import { preparePiPlaywright } from "../pi-mcp-launch.js";
import { buildPlaywrightSandboxMcp } from "../mcp.js";
import { piProviderBareModel, piProviderModelsJson } from "../pi-provider.js";
import type { ProviderOverride } from "../provider-override.js";
import type { RunRequest } from "../types.js";
import { UsageRefusalError } from "../validation.js";
import { writeQwenRunSettings } from "../qwen-effort.js";
import type { CallerHarnessHome } from "./harness-home.js";
import type { TurnAgentId } from "./turn-driver-types.js";

const MAX_CALLER_MODELS_BYTES = 1024 * 1024;

function callerDirectory(home: string, ...parts: string[]): string {
  const directory = join(home, ...parts);
  let ancestor = directory;
  while (lstatSync(ancestor, { throwIfNoEntry: false }) === undefined) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== ancestor) throw new UsageRefusalError("caller state directory must not contain symlinks");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== directory) throw new UsageRefusalError("caller state directory must not contain symlinks");
  return directory;
}

/** An explicit Pi override adds its reserved provider while preserving the
 * caller's other providers, settings, extensions and native session store. */
function preparePiModels(home: string, override: ProviderOverride & { baseUrl: string; apiKey: string }, model: string): void {
  const path = join(home, "models.json");
  let settings: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(readUtf8FileBounded(path, {
      maxBytes: MAX_CALLER_MODELS_BYTES, label: "caller Pi models", noFollow: true,
    }));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new UsageRefusalError("caller Pi models.json must contain an object");
    }
    settings = value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (settings.providers !== undefined && (!settings.providers || typeof settings.providers !== "object" || Array.isArray(settings.providers))) {
    throw new UsageRefusalError("caller Pi models.json providers must contain an object");
  }
  const generated = JSON.parse(piProviderModelsJson(override, piProviderBareModel(model))) as { providers: object };
  writeOwnedSync(path, JSON.stringify({ ...settings, providers: { ...settings.providers as object, ...generated.providers } }), 0o600);
}

/** Preparation never imports operator customization or redirects to a
 * disposable run home. Artifacts needed by explicit options stay in H. */
export function prepareCallerTurnContext(input: {
  agent: TurnAgentId; adapter: BaseAdapter; request: RunRequest; home: CallerHarnessHome;
  override: (ProviderOverride & { baseUrl: string; apiKey: string }) | null;
  model: string | undefined;
  printOnly?: boolean;
}): RunContext {
  const { agent, adapter, request, home, override } = input;
  const model = input.model ?? override?.model;
  if (agent === "pi") {
    const directory = input.printOnly ? join(home.dir, ".pi", "agent") : callerDirectory(home.dir, ".pi", "agent");
    if (override !== null) {
      if (model === undefined) throw new UsageRefusalError("pi provider override needs a model");
      if (!input.printOnly) preparePiModels(directory, override, model);
    }
    if (input.printOnly) {
      const mcp = buildPlaywrightSandboxMcp(request.sandboxed, {
        enabled: request.enablePlaywrightMcp, pathEnv: adapter.executionPathEnv(), forbiddenRoot: request.cwd,
      });
      return { piProviderAgentDir: { path: directory, finalize: () => {} },
        ...(mcp.check === null ? {} : { piMcpExtension: { path: join(directory, ".codemux", "preview", "playwright.mjs"),
          directory: { path: directory, finalize: () => {} } }, playwrightMcpCheck: mcp.check }) } as RunContext;
    }
    return preparePiPlaywright(request, { piProviderAgentDir: { path: directory, finalize: () => {} } },
      directory, adapter.executionPathEnv());
  }
  if (agent === "gemini") {
    const geminiDir = input.printOnly ? join(home.dir, ".gemini") : callerDirectory(home.dir, ".gemini");
    const mcp = geminiPlaywrightSettings(request.sandboxed, request.enablePlaywrightMcp,
      adapter.executionPathEnv(), request.cwd);
    return { geminiHermeticHome: { home: home.dir, geminiDir, finalize: () => {} },
      playwrightMcpCheck: mcp.check };
  }
  if (agent === "droid" && override !== null) {
    if (model === undefined) throw new UsageRefusalError("droid provider override needs a model");
    if (input.printOnly) return { droidProviderSettings: { path: join(home.dir, ".factory", ".codemux", "preview", "settings.json"), finalize: () => {} } };
    return { droidProviderSettings: writeDroidProviderSettings(callerDirectory(home.dir, ".factory"), override, model) };
  }
  if (agent === "qwen") return request.effort === undefined && override?.maxContextTokens === undefined ? {} : {
    qwenEffortSettings: input.printOnly ? { path: join(home.dir, ".qwen", ".codemux", "preview", "settings.json"), finalize: () => {} }
    : writeQwenRunSettings(callerDirectory(home.dir, ".qwen"), {
      effort: request.effort, contextWindowTokens: override?.maxContextTokens,
    }),
  };
  // Copilot RPC applies the provider in its session configuration. OpenHands
  // writes its prompt through the session profile under the caller root.
  return {};
}
