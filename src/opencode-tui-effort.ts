import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOpencodeHermeticHome } from "./opencode-hermetic.js";
import type { ReasoningEffort } from "./types.js";
import { UsageRefusalError } from "./validation.js";

/** The TUI stores variants by provider/model, unlike run's --variant argument. */
export function validateOpencodeTuiEffortModel(model: string | undefined): string {
  const slash = model?.indexOf("/") ?? -1;
  if (!model || slash < 1 || slash === model.length - 1) {
    throw new UsageRefusalError("opencode TUI effort requires an explicit provider/model selector; pass --model or configure a provider override model");
  }
  return model;
}

/** Isolate the persisted variant map for this TUI. The operator's model.json
 * is never changed. Native context/local.tsx reads this map before submitting
 * prompts, so an older saved variant cannot override the requested effort. */
export function prepareOpencodeTuiEffort(dataDir: string, model: string | undefined, effort: ReasoningEffort) {
  const selected = validateOpencodeTuiEffortModel(model);
  const slash = selected.indexOf("/");
  const home = createOpencodeHermeticHome(dataDir);
  try {
    const state = join(home.home, ".local", "state");
    const directory = join(state, "opencode");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "model.json"), JSON.stringify({
      recent: [{ providerID: selected.slice(0, slash), modelID: selected.slice(slash + 1) }],
      favorite: [], variant: { [selected]: effort },
    }), { mode: 0o600, flag: "wx" });
    return { env: { XDG_STATE_HOME: state }, finalize: home.finalize };
  } catch (error) {
    home.finalize();
    throw error;
  }
}
