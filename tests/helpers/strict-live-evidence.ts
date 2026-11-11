import type { AgentId } from "../../src/types.js";

/** Excerpts of the 2026-11-11 macOS probes. Paths are generalized here;
 * scratch/report-strict.md retains exact commands, paths, and full logs.
 * A transport exit of zero is insufficient: the OK probe must answer OK.
 */
export const STRICT_LIVE_FAILURES: Partial<Record<AgentId, { code: number; stdout: string; stderr: string }>> = {
  codex: { code: 1, stdout: "", stderr: "Error: codex exited 0 with an empty answer" },
  claude: { code: 0, stdout: "UserPromptSubmit operation blocked by hook: external hook script: Operation not permitted", stderr: "" },
  zai: { code: 0, stdout: "UserPromptSubmit operation blocked by hook: external hook script: Operation not permitted", stderr: "" },
  kimi: { code: 1, stdout: "", stderr: "syscall: watch, code: EPERM, path: ~/.agents; Error: kimi exited 0 with an empty answer" },
  cursor: { code: 64, stdout: "", stderr: "cursor primary window has 8% left (< 10%) (not sent)" },
  copilot: { code: 64, stdout: "", stderr: "Copilot refuses repository executable configuration: <worktree>/.claude/settings.json" },
  agy: { code: 64, stdout: "", stderr: "strict sandbox cannot read env-wrapped executable ~/.local/bin/agy; scode has no read-only path grant" },
  opencode: { code: 64, stdout: "", stderr: "strict sandbox cannot read env-wrapped executable ~/.opencode/bin/opencode; scode has no read-only path grant" },
  cline: { code: 64, stdout: "", stderr: "strict sandbox cannot read env-wrapped executable <fixture>/cline; scode has no read-only path grant" },
  aider: { code: 71, stdout: "", stderr: "sandbox-exec: execvp() of '~/.local/pipx/venvs/aider-chat/bin/aider' failed: Operation not permitted" },
  openhands: { code: 71, stdout: "", stderr: "sandbox-exec: execvp() of '~/.local/share/uv/tools/openhands/bin/openhands' failed: Operation not permitted" },
  goose: { code: 1, stdout: "", stderr: "Failed to create session database directory: Os { code: 17, kind: AlreadyExists, message: File exists }" },
  droid: { code: 1, stdout: "", stderr: "droid reported 503 auth_unavailable: no auth available" },
  gemini: { code: 1, stdout: "", stderr: "Cannot read package config <worktree>/package.json: operation not permitted; ERR_INVALID_PACKAGE_CONFIG" },
  pi: { code: 1, stdout: "", stderr: "Cannot read package config <worktree>/package.json: operation not permitted; ERR_INVALID_PACKAGE_CONFIG" },
  qwen: { code: 1, stdout: "", stderr: "Cannot read package config <worktree>/package.json: operation not permitted; ERR_INVALID_PACKAGE_CONFIG" },
};

export function strictOkProbePassed(result: { code: number; stdout: string }): boolean {
  return result.code === 0 && result.stdout.trim() === "OK";
}
