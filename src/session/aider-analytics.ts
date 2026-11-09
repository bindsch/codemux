import { closeSync, constants, fstatSync, ftruncateSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { readAiderHistoryDelta } from "../aider-history.js";
import { parseAiderAnalytics } from "../result-envelope/aider.js";
import { emptyUsage } from "../result-envelope.js";
import { assertAiderHistoryForTurn } from "./aider-session.js";

export const aiderSessionAnalyticsPath = (historyPath: string): string =>
  join(dirname(historyPath), "analytics.jsonl");

/** One local analytics file per turn; provider counters restart with each
 * child. The history's ownership checks also cover this file's parent. */
export function prepareAiderSessionAnalytics(historyPath: string): string {
  assertAiderHistoryForTurn(historyPath);
  const path = aiderSessionAnalyticsPath(historyPath);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("aider analytics must be an owned regular file with mode 0600");
    }
    ftruncateSync(fd, 0);
  } finally { closeSync(fd); }
  return path;
}

export function readAiderSessionUsage(historyPath: string) {
  const read = readAiderHistoryDelta(aiderSessionAnalyticsPath(historyPath), 0);
  return read === null ? emptyUsage() : parseAiderAnalytics(read.text).usage;
}
