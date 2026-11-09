import type { AgentId, AutonomyLevel } from "./types.js";
import { SESSION_AGENTS } from "./session/cli-agents.js";

/** What carries an autonomy level on a headless launch (design P4). A cell
 * is uniform in meaning whatever the class; the class says how the level
 * reaches the harness:
 * - `native`: a harness flag the adapter passes for this level;
 * - `default`: the harness's own default state already is the level, so no
 *   flag is needed;
 * - `stdin`: a stdin answer codemux feeds the child;
 * - `env`: an environment variable codemux sets;
 * - `scode`: no native headless carrier exists at the pinned version, so
 *   the sandbox boundary alone carries the level (a declared limitation,
 *   stated here and in docs/autonomy-and-sandboxing.md). */
export type AutonomyCarrier = "native" | "default" | "stdin" | "env" | "scode";

export interface AutonomyMapping {
  byLevel: Record<AutonomyLevel, string>;
  /** The carrier class per level (see AutonomyCarrier). `codemux autonomy`
   * and `codemux list --json` (autonomyCarrier) print this record. */
  carrier: Record<AutonomyLevel, AutonomyCarrier>;
  /** How the session mapping relates to the run mapping. Set for every
   * session agent; the claude family's differs by design. */
  sessions?: string;
  notes?: string;
}

export const AUTONOMY_EQUIVALENCE: Record<AgentId, AutonomyMapping> = {
  agy: {
    byLevel: {
      "read-only": "--mode=plan + required scode",
      low: "default (print mode soft-denies every action that would ask; exit 0)",
      medium: "--mode=accept-edits + permissions.allow command(*) (headless)",
      high: "--dangerously-skip-permissions",
    },
    carrier: {
      "read-only": "native",
      low: "default",
      medium: "native",
      high: "native",
    },
    sessions: "same flags as run",
    notes:
      "headless approval requests that cannot be shown are soft-denied while the run still exits 0, " +
      "so the low level rests on print mode's default; an unrecognized --mode value only warns and continues",
  },
  aider: {
    byLevel: {
      "read-only": "--dry-run",
      low: "decline headless confirmations",
      medium: "--yes-always",
      high: "--yes-always",
    },
    carrier: {
      "read-only": "native",
      low: "stdin",
      medium: "native",
      high: "native",
    },
    sessions: "same flags as run (stdin negatives at read-only and low, --yes-always at medium and high)",
    notes: "TUI low remains interactive; medium/high share auto-confirm mode",
  },
  claude: {
    byLevel: {
      "read-only": "--permission-mode plan + --allowedTools WebSearch WebFetch (headless)",
      low: "--permission-mode manual + --allowedTools WebSearch WebFetch (headless)",
      medium: "--permission-mode acceptEdits + --allowedTools Edit(//<launch dir>/**) Bash WebSearch WebFetch (headless)",
      high: "--dangerously-skip-permissions + --allowedTools Edit Write NotebookEdit Bash WebSearch WebFetch (headless)",
    },
    carrier: {
      "read-only": "native",
      low: "native",
      medium: "native",
      high: "native",
    },
    sessions:
      "session mapping differs by design: no web grants, medium keeps only the scoped edit grant, " +
      "and high is --permission-mode default plus --allowedTools Edit Write NotebookEdit Bash " +
      "so the ceiling still answers every tool call",
    notes: "native 4-level mapping; grants restore edits, shell commands, and the web tools under the CLAUDE_CODE_SUBPROCESS_ENV_SCRUB hardening (claude >= 2.1.25x force-resets the requested mode to default, which denies every prompting tool headless)",
  },
  cline: {
    byLevel: {
      "read-only": "--plan",
      low: "--auto-approve false",
      medium: "--auto-approve true",
      high: "--auto-approve true",
    },
    carrier: {
      "read-only": "native",
      low: "native",
      medium: "native",
      high: "native",
    },
    notes: "medium/high share Cline's auto-approve mode",
  },
  codex: {
    byLevel: {
      "read-only": '-s read-only -c approval_policy="never"',
      low: '-s workspace-write -c approval_policy="untrusted"',
      medium: '-s workspace-write -c approval_policy="never"',
      high: '-s danger-full-access -c approval_policy="never"',
    },
    carrier: {
      "read-only": "scode",
      low: "scode",
      medium: "scode",
      high: "scode",
    },
    sessions:
      "sandboxed sessions pass the bypass pair like run; unsandboxed low/medium sessions keep " +
      "native read-only with on-request approvals",
    notes:
      'run mapping: the approval policy uses the -c config override, not -a (codex\'s root parser drops -a before "exec", and "untrusted" was never a valid -a value); ' +
      "under --sandbox, scode enforces run boundaries; low/medium sessions use native read-only with on-request approvals, including inside scode; " +
      "the carrier describes the default sandboxed launch, where the bypass flag leaves scode the only boundary — an unsandboxed launch passes this row's flags natively",
  },
  copilot: {
    byLevel: {
      "read-only": "--plan",
      low: "--allow-tool read",
      medium: "--allow-all-tools",
      high: "--allow-all",
    },
    carrier: {
      "read-only": "native",
      low: "native",
      medium: "native",
      high: "native",
    },
    notes: "high also allows all paths and URLs",
  },
  cursor: {
    byLevel: {
      "read-only": "--mode plan + required scode",
      low: "default approvals (print mode rejects a command that needs approval)",
      medium: "--auto-review",
      high: "--force",
    },
    carrier: {
      "read-only": "native",
      low: "default",
      medium: "native",
      high: "native",
    },
    notes:
      "cursor-agent is the standalone entry; agent is its alias; the desktop cursor agent entry needs the CODEMUX_CURSOR_ENTRY opt-in",
  },
  droid: {
    byLevel: {
      "read-only": "default (droid exec read-only mode: no execution without --auto)",
      low: "--auto low",
      medium: "--auto medium",
      high: "--auto high",
    },
    carrier: {
      "read-only": "default",
      low: "native",
      medium: "native",
      high: "native",
    },
    notes: "the 0.221.0 default is read-only mode; low/medium/high pass the native --auto values",
  },
  goose: {
    byLevel: {
      "read-only": "GOOSE_MODE=chat",
      low: "GOOSE_MODE=approve",
      medium: "GOOSE_MODE=smart_approve",
      high: "GOOSE_MODE=auto",
    },
    carrier: {
      "read-only": "env",
      low: "env",
      medium: "env",
      high: "env",
    },
    notes: "mapped via env wrapper",
  },
  gemini: {
    byLevel: {
      "read-only": "--approval-mode plan",
      low: "--approval-mode default",
      medium: "--approval-mode yolo",
      high: "--approval-mode yolo",
    },
    carrier: {
      "read-only": "native",
      low: "native",
      medium: "native",
      high: "native",
    },
    notes: "medium/high share yolo; medium requires scode for edits and shell commands",
  },
  kimi: {
    byLevel: {
      "read-only": "--plan",
      low: "default (prompts before each tool call)",
      medium: "--yolo",
      high: "--auto",
    },
    carrier: {
      "read-only": "scode",
      low: "scode",
      medium: "scode",
      high: "scode",
    },
    sessions: "sessions pass no autonomy flags, like headless runs",
    notes:
      "interactive only: --prompt rejects --plan, --yolo, --auto and the hidden yolo aliases --yes and --auto-approve (2.5.2), so headless autonomy rests on scode",
  },
  openhands: {
    byLevel: {
      "read-only": "default always-ask",
      low: "default always-ask",
      medium: "default always-ask",
      high: "--always-approve",
    },
    carrier: {
      "read-only": "scode",
      low: "scode",
      medium: "scode",
      high: "default",
    },
    notes:
      "--headless auto-approves (textual_app.py selects NeverConfirm whenever --headless is set, 1.16.0), so headless autonomy rests on scode; " +
      "--llm-approve is never emitted; high is the headless default state",
  },
  opencode: {
    byLevel: {
      "read-only": "--agent plan",
      low: "--agent build",
      medium: "--agent build",
      high: "--agent build --auto",
    },
    carrier: {
      "read-only": "native",
      low: "native",
      medium: "native",
      high: "native",
    },
    sessions: "same flags as run",
    notes: "read-only requires scode because plan may write plan artifacts",
  },
  pi: {
    byLevel: {
      "read-only": "--no-extensions --tools read,grep,find,ls",
      low: "--no-extensions --tools read,grep,find,ls,edit,write",
      medium: "default tools",
      high: "default tools",
    },
    carrier: {
      "read-only": "native",
      low: "native",
      medium: "scode",
      high: "scode",
    },
    notes:
      "read-only/low disable extensions and restrict tools; medium/high use defaults; " +
      "pi has no approval gate at 0.85.1 (--no-approve ignores project-local files), so medium and high are one native state and scode carries the boundary",
  },
  qwen: {
    byLevel: {
      "read-only": "--approval-mode plan",
      low: "--approval-mode default",
      medium: "--approval-mode auto",
      high: "--approval-mode yolo",
    },
    carrier: {
      "read-only": "native",
      low: "native",
      medium: "native",
      high: "native",
    },
    notes: "auto can approve shell commands headless after classifier review; qwen-coder fallback requires the outer sandbox",
  },
  zai: {
    byLevel: {
      "read-only": "--permission-mode plan + --allowedTools WebSearch WebFetch (headless)",
      low: "--permission-mode manual + --allowedTools WebSearch WebFetch (headless)",
      medium: "--permission-mode acceptEdits + --allowedTools Edit(//<launch dir>/**) Bash WebSearch WebFetch (headless)",
      high: "--dangerously-skip-permissions + --allowedTools Edit Write NotebookEdit Bash WebSearch WebFetch (headless)",
    },
    carrier: {
      "read-only": "native",
      low: "native",
      medium: "native",
      high: "native",
    },
    sessions:
      "session mapping differs by design: no web grants, medium keeps only the scoped edit grant, " +
      "and high is --permission-mode default plus --allowedTools Edit Write NotebookEdit Bash " +
      "so the ceiling still answers every tool call",
    notes: "claude-compatible mapping via z.ai endpoint; grants counter the scrub-var permission hardening (edits, shell commands, and the web tools)",
  },
};

// Keep the published session approval fact tied to the driver declaration.
for (const [agent, support] of Object.entries(SESSION_AGENTS)) {
  const mapping = AUTONOMY_EQUIVALENCE[agent as AgentId];
  const approval = support.approvals === "ask"
    ? "sessions: approval requests use permission_request and permission_decision (alias: permission_response)"
    : `sessions: ${support.approvalsNote}`;
  mapping.notes = [mapping.notes, approval].filter(Boolean).join("; ");
}
