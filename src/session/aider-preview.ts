import { join } from "node:path";
import { aiderSessionAnalyticsPath } from "./aider-analytics.js";
import { aiderSessionModelSettingsPath } from "./aider-model-settings.js";
import {
  AIDER_SESSION_ID_PATTERN,
  aiderSessionHermeticAssignments,
  aiderSessionHistoryPath,
  buildAiderSessionCommand,
  type AiderSessionCommand,
} from "./aider-session.js";
import { sessionKeyedHomePath } from "./private-home-key.js";

export interface AiderSessionPreviewOptions extends Pick<AiderSessionCommand,
  "autonomy" | "model" | "weakModel" | "effort" | "permissionPolicy" | "tools" | "callerHome"> {
  /** The operator's aider brand home, before any session redirect. */
  harnessHome: string;
  /** A known resume ID or a caller-minted preview ID. Nothing is recorded. */
  sessionId: string;
  hermetic: boolean;
  /** A validated provider cap; the actual turn prepares the named file. */
  maxOutputTokens?: number;
}

/** Build a representative first turn without creating or opening session state.
 * Session input has not arrived, so the prompt is the request validator's
 * explicit placeholder. The real driver replaces it with each turn's text. */
export function buildAiderSessionPreview(options: AiderSessionPreviewOptions) {
  if (!AIDER_SESSION_ID_PATTERN.test(options.sessionId)) {
    throw new Error("aider session preview requires a lowercase UUID session ID");
  }
  const privateHome = options.callerHome?.dir ?? (options.hermetic
    ? sessionKeyedHomePath(join(options.harnessHome, ".codemux-hermetic"), options.sessionId)
    : null);
  const historyPath = options.callerHome ? aiderSessionHistoryPath(join(options.callerHome.dir, ".aider"), options.sessionId) : privateHome === null
    ? aiderSessionHistoryPath(options.harnessHome, options.sessionId)
    : join(privateHome, "history.md");
  const analyticsPath = aiderSessionAnalyticsPath(historyPath);
  const modelSettingsPath = options.maxOutputTokens === undefined
    ? undefined : aiderSessionModelSettingsPath(historyPath);
  const argv = buildAiderSessionCommand({
    autonomy: options.autonomy,
    model: options.model,
    weakModel: options.weakModel,
    effort: options.effort,
    permissionPolicy: options.permissionPolicy,
    tools: options.tools,
    historyPath,
    analyticsPath,
    modelSettingsPath,
    prompt: "codemux session",
    callerHome: options.callerHome,
    hermeticEnvAssignments: privateHome === null
      ? undefined : aiderSessionHermeticAssignments(privateHome),
  });
  return { argv, sessionId: options.sessionId, historyPath, analyticsPath, modelSettingsPath, privateHome };
}
