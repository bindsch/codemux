import { join } from "node:path";
import type { RunContext } from "./run-context.js";
import type { RunRequest } from "./types.js";
import type { ScodeTrustLevel } from "./sandbox.js";
import { LAST_MESSAGE_BASENAME, SCRATCH_PARENT_DIR_NAME } from "./adapters/codex-flags.js";
import { validateProjectSettingsRunRequest } from "./claude-project-settings.js";
import { prepareCodexNoToolsCatalog } from "./codex-no-tools.js";

/** Representative artifact paths. No credential reads, directory sweep, or cleanup. */
export function previewCodexRun(request: RunRequest, root: string, provider: boolean,
  trust?: ScodeTrustLevel, catalog?: string): RunContext {
  if (request.experimentProjectSettings) validateProjectSettingsRunRequest(request);
  const context: RunContext = {};
  if (request.hermetic) {
    const home = join(root, ".codemux-hermetic", "preview");
    context.hermeticHome = { home, codexHome: join(home, ".codex"), finalize: () => {} };
    context.lastMessagePath = join(home, LAST_MESSAGE_BASENAME);
  } else {
    if (provider) context.codexProviderHome = { codexHome: join(root, ".codemux-provider", "preview"), finalize: () => {} };
    if (trust !== "untrusted") context.lastMessagePath = join(root, SCRATCH_PARENT_DIR_NAME, "preview", LAST_MESSAGE_BASENAME);
  }
  if (catalog !== undefined) prepareCodexNoToolsCatalog(context, catalog, trust, true);
  return context;
}
