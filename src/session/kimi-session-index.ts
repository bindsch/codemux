import { join, resolve } from "node:path";
import { readBoundedKimiFile, MAX_KIMI_WIRE_BYTES } from "../kimi-wire-log.js";
import { KIMI_SESSION_ID_PATTERN } from "./kimi-session.js";

/** Kimi 2.5.2 SessionManager.appendSessionIndexEntry (bin/kimi byte
 * 95939371) flushes {sessionId, sessionDir, workDir} before a model turn.
 * This identifies an interrupted first turn before its closing hint exists. */
export function kimiSessionIds(brandHome: string, cwd: string): Set<string> {
  let source: string;
  try { source = readBoundedKimiFile(join(brandHome, "session_index.jsonl"), MAX_KIMI_WIRE_BYTES); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
  const ids = new Set<string>();
  for (const line of source.split(/\r?\n/).filter((entry) => entry.trim() !== "")) {
    const entry: unknown = JSON.parse(line);
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid Kimi session index record");
    const { sessionId, workDir } = entry as Record<string, unknown>;
    if (typeof sessionId !== "string" || !KIMI_SESSION_ID_PATTERN.test(sessionId) || typeof workDir !== "string") {
      throw new Error("invalid Kimi session index identity");
    }
    if (resolve(workDir) === resolve(cwd)) ids.add(sessionId);
  }
  return ids;
}

export function identifyKimiInterruptedSession(brandHome: string, cwd: string, before: ReadonlySet<string>): string | null {
  const created = [...kimiSessionIds(brandHome, cwd)].filter((id) => !before.has(id));
  if (created.length > 1) throw new Error("cannot identify the interrupted Kimi session: concurrent sessions created in this directory");
  return created[0] ?? null;
}
