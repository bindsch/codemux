import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyUsage } from "../../src/result-envelope.js";

export function tempEnv(extra: Record<string, string> = {}): {
  env: NodeJS.ProcessEnv;
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "codemux-call-log-test-"));
  return {
    env: { HOME: dir, ...extra },
    dir,
    cleanup: () => {
      try {
        chmodSync(dir, 0o755);
      } catch {
        // already gone
      }
    },
  };
}

export const BASE_RECORD = {
  ts: "2026-10-08T12:00:00.000Z",
  kind: "run" as const,
  agent: "claude" as const,
  model: null,
  model_effective: null,
  provider: "default",
  session_id: null,
  turn_id: null,
  autonomy: "read-only" as const,
  hermetic: false,
  sandboxed: false,
  exit_code: 0,
  finish: null,
  duration_ms: 5,
  cwd: "/tmp",
  usage: emptyUsage(),
  labels: null,
};
