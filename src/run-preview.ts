/** Representative artifact paths without file reads, writes, or cleanup hooks. */
import { join } from "node:path";
import type { RunRequest } from "./types.js";
import type { CopilotRunContext } from "./copilot-usage.js";
import type { ProviderOverride } from "./provider-override.js";
import { UsageRefusalError } from "./validation.js";

export const previewFinalize = (): void => {};
export const previewHome = (root: string) => join(root, ".codemux-hermetic", "preview");
const file = (path: string) => ({ path, finalize: previewFinalize });

/** Copilot's RPC preview shares the native command builder without starting a model run. */
export function previewCopilotRun(request: RunRequest, root: string,
  provider: ProviderOverride | null = null): CopilotRunContext {
  if (request.experimentMcp) throw new UsageRefusalError("--print-sandbox cannot prepare an experiment MCP relay");
  const home = previewHome(root);
  const context: CopilotRunContext = { printOnly: true };
  if (request.hermetic) context.copilotHermeticHome = { home, finalize: previewFinalize };
  if (request.resultJson) context.copilotUsageFile = file(join(home, "usage.json"));
  if (provider?.maxContextTokens !== undefined) {
    context.copilotProviderFile = { ...file(join(home, "providers.json")), modelId: "codemux/model" };
  }
  return context;
}
