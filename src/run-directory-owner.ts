import { createHash } from "node:crypto";
import { pidProbeAlive, readProcessTable, type ProcessTable } from "./process-table.js";

/** Keep process identity in the name, outside the child-writable tree. */
function startToken(start: string): string {
  return createHash("sha256").update(start).digest("hex");
}

let ownPrefix: string | undefined;
export function runDirectoryPrefix(): string {
  if (ownPrefix !== undefined) return ownPrefix;
  const start = readProcessTable().get(process.pid)?.start;
  // A transient read failure must not disable identity for every later home.
  if (start === undefined) return `run-${process.pid}-`;
  ownPrefix = `run-${process.pid}-s${startToken(start)}-`;
  return ownPrefix;
}

/** One lazy process snapshot per sweep; legacy/unreadable identities stay conservative. */
export function runDirectoryOwnerCheck(): (entry: string, pid: number) => boolean {
  let table: ProcessTable | undefined;
  return (entry, pid) => {
    if (!pidProbeAlive(pid)) return false;
    const token = /^run-\d+-s([0-9a-f]{64})-/.exec(entry)?.[1];
    if (token === undefined) return true;
    table ??= readProcessTable();
    const start = table.get(pid)?.start;
    // Missing entries can reflect a failed or partial process-table read.
    return start === undefined || token === startToken(start);
  };
}
