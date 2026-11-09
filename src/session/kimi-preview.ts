import { join } from "node:path";
import { kimiPrivateBrandHome } from "../kimi-hermetic.js";
import { buildKimiSessionCommand } from "./kimi-session.js";
import type { CallerHarnessHome } from "./harness-home.js";

/** Representative per-turn argv; the real caller supplies the prompt later.
 * No profile, config, credential, or session record is created here. */
export function buildKimiSessionPreview(options: {
  model?: string; resumeSessionId?: string; homeDir?: string; harnessHome: string;
  hermetic: boolean; projectSettings?: boolean; tools?: "none" | "default";
  callerHome?: CallerHarnessHome;
}): string[] {
  const argv = buildKimiSessionCommand({
    model: options.model, resumeSessionId: options.resumeSessionId, prompt: "<session prompt>",
    callerHome: options.callerHome,
    hermeticHome: options.hermetic ? options.homeDir : undefined,
    brandHome: !options.hermetic && options.homeDir !== undefined ? kimiPrivateBrandHome(options.homeDir) : undefined,
    projectSettings: options.projectSettings,
  });
  if (options.tools === "none" && options.resumeSessionId === undefined) {
    const brandHome = options.homeDir === undefined ? options.harnessHome : kimiPrivateBrandHome(options.homeDir);
    argv.splice(argv.indexOf("--output-format"), 0, "--agent-file", join(brandHome, ".codemux", "<generated-no-tools-profile>"));
  }
  return argv;
}
