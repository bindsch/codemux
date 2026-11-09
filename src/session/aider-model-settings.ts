import { closeSync, constants, fstatSync, ftruncateSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertAiderHistoryForTurn } from "./aider-session.js";

export const aiderSessionModelSettingsPath = (historyPath: string): string =>
  join(dirname(historyPath), "model-settings.yml");

/** Rewrite the cap before every turn, including resumed turns. Aider 0.86.2
 * merges aider/extra_params into main, weak, and editor model settings. JSON
 * is valid YAML. Validate the descriptor before truncating an existing file. */
export function prepareAiderSessionModelSettings(
  historyPath: string,
  maxOutputTokens: number | undefined
): string | undefined {
  if (maxOutputTokens === undefined) return undefined;
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error("aider output cap must be a positive safe integer");
  }
  assertAiderHistoryForTurn(historyPath);
  const path = aiderSessionModelSettingsPath(historyPath);
  const fd = openSync(path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("aider model settings must be an owned regular file with mode 0600 and one link");
    }
    ftruncateSync(fd, 0);
    writeFileSync(fd, JSON.stringify([{
      name: "aider/extra_params",
      extra_params: { max_tokens: maxOutputTokens },
    }]));
  } finally { closeSync(fd); }
  return path;
}
