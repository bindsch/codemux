import { closeSync, constants, fstatSync, ftruncateSync, openSync } from "node:fs";
import { assertAiderHistoryForTurn } from "./aider-session.js";

/** The child has settled. Remove only its interrupted exchange so a resume
 * cannot replay an unanswered prompt. Earlier complete turns stay intact. */
export function rollbackAiderInterruptedTurn(historyPath: string, consumedBytes: number): void {
  if (!Number.isSafeInteger(consumedBytes) || consumedBytes < 0) {
    throw new Error("aider history offset must be a nonnegative safe integer");
  }
  assertAiderHistoryForTurn(historyPath);
  const fd = openSync(historyPath, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < consumedBytes || (stat.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("aider interrupted history changed before rollback");
    }
    ftruncateSync(fd, consumedBytes);
  } finally {
    closeSync(fd);
  }
}
