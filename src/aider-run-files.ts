import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAiderHermeticHome, type AiderHermeticHome } from "./aider-hermetic.js";
import type { RunContext } from "./run-context.js";

export interface AiderRunFiles extends AiderHermeticHome {
  promptPath: string;
  analyticsPath: string;
  modelSettingsPath?: string;
}

export interface AiderRunContext extends RunContext {
  aiderRunFiles?: AiderRunFiles;
}

/** Aider 0.86.2 args.py accepts --message-file, --analytics-log, and
 * --model-settings-file. JSON is valid YAML for its safe_load reader.
 * aider/extra_params merges into every model after its native settings,
 * preserving those defaults and covering weak/editor requests too.
 * The existing private-directory lifecycle supplies mode 0700 and cleanup. */
export function createAiderRunFiles(
  sourceAiderDir: string,
  prompt: string,
  model?: string,
  maxOutputTokens?: number,
  printOnly = false
): AiderRunFiles {
  const privateHome = createAiderHermeticHome(sourceAiderDir, printOnly);
  try {
    const promptPath = join(privateHome.home, "prompt.txt");
    const analyticsPath = join(privateHome.home, "analytics.jsonl");
    if (!printOnly) {
      writeFileSync(promptPath, prompt, { mode: 0o600, flag: "wx" });
      writeFileSync(analyticsPath, "", { mode: 0o600, flag: "wx" });
    }
    let modelSettingsPath: string | undefined;
    if (maxOutputTokens !== undefined) {
      if (!model) throw new Error("aider output cap requires a resolved model");
      modelSettingsPath = join(privateHome.home, "model-settings.yml");
      if (!printOnly) writeFileSync(modelSettingsPath, JSON.stringify([{
        name: "aider/extra_params",
        extra_params: { max_tokens: maxOutputTokens },
      }]), { mode: 0o600, flag: "wx" });
    }
    return { ...privateHome, promptPath, analyticsPath, modelSettingsPath };
  } catch (error) {
    privateHome.finalize();
    throw error;
  }
}
