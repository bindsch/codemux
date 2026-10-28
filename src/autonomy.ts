import type { AgentId, AutonomyLevel } from "./types.js";

export interface AutonomyMapping {
  byLevel: Record<AutonomyLevel, string>;
  notes?: string;
}

export const AUTONOMY_EQUIVALENCE: Record<AgentId, AutonomyMapping> = {
  agy: {
    byLevel: {
      "read-only": "--mode=plan + required scode",
      low: "default prompting (headless soft-denies tools it cannot ask about)",
      medium: "--mode=accept-edits + permissions.allow command(*) (headless)",
      high: "--dangerously-skip-permissions",
    },
    notes:
      "headless approval requests that cannot be shown are soft-denied while the run still exits 0, " +
      "so every level below high rests on scode; an unrecognized --mode value only warns and continues",
  },
  aider: {
    byLevel: {
      "read-only": "--dry-run",
      low: "decline headless confirmations",
      medium: "--yes-always",
      high: "--yes-always",
    },
    notes: "TUI low remains interactive; medium/high share auto-confirm mode",
  },
  claude: {
    byLevel: {
      "read-only": "--permission-mode plan + --allowedTools WebSearch WebFetch (headless)",
      low: "--permission-mode manual + --allowedTools WebSearch WebFetch (headless)",
      medium: "--permission-mode acceptEdits + --allowedTools Edit(//<launch dir>/**) Bash WebSearch WebFetch (headless)",
      high: "--dangerously-skip-permissions + --allowedTools Edit Write NotebookEdit Bash WebSearch WebFetch (headless)",
    },
    notes: "native 4-level mapping; grants restore edits, shell commands, and the web tools under the CLAUDE_CODE_SUBPROCESS_ENV_SCRUB hardening (claude >= 2.1.25x force-resets the requested mode to default, which denies every prompting tool headless)",
  },
  cline: {
    byLevel: {
      "read-only": "--plan",
      low: "--auto-approve false",
      medium: "--auto-approve true",
      high: "--auto-approve true",
    },
    notes: "medium/high share Cline's auto-approve mode",
  },
  codex: {
    byLevel: {
      "read-only": "-s read-only -a never",
      low: "-s workspace-write -a untrusted",
      medium: "-s workspace-write -a never",
      high: "-s danger-full-access -a never",
    },
    notes: "read-only also uses -a never; under --sandbox, scode enforces boundaries",
  },
  copilot: {
    byLevel: {
      "read-only": "--plan",
      low: "--allow-tool read",
      medium: "--allow-all-tools",
      high: "--allow-all",
    },
    notes: "high also allows all paths and URLs",
  },
  cursor: {
    byLevel: {
      "read-only": "--mode plan + required scode --ro",
      low: "default approvals",
      medium: "--auto-review",
      high: "--force",
    },
    notes:
      "cursor-agent is the standalone entry; agent is its alias; the desktop cursor agent entry needs the CODEMUX_CURSOR_ENTRY opt-in",
  },
  droid: {
    byLevel: {
      "read-only": "default mode",
      low: "--auto low",
      medium: "--auto medium",
      high: "--auto high",
    },
    notes: "native 4-level mapping",
  },
  goose: {
    byLevel: {
      "read-only": "GOOSE_MODE=chat",
      low: "GOOSE_MODE=approve",
      medium: "GOOSE_MODE=smart_approve",
      high: "GOOSE_MODE=auto",
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
    notes: "medium/high share yolo; medium requires scode for edits and shell commands",
  },
  kimi: {
    byLevel: {
      "read-only": "--plan",
      low: "default (prompts before each tool call)",
      medium: "--yolo",
      high: "--auto",
    },
    notes: "interactive only: --prompt rejects all three, so headless autonomy rests on scode",
  },
  openhands: {
    byLevel: {
      "read-only": "default always-ask",
      low: "default always-ask",
      medium: "default always-ask",
      high: "--always-approve",
    },
    notes: "--headless auto-approves, so headless autonomy rests on scode; --llm-approve is never emitted",
  },
  opencode: {
    byLevel: {
      "read-only": "--agent plan",
      low: "--agent build",
      medium: "--agent build",
      high: "--agent build --auto",
    },
    notes: "read-only requires scode because plan may write plan artifacts",
  },
  pi: {
    byLevel: {
      "read-only": "--no-extensions --tools read,grep,find,ls",
      low: "--no-extensions --tools read,grep,find,ls,edit,write",
      medium: "default tools",
      high: "default tools",
    },
    notes: "read-only/low disable extensions and restrict tools; medium/high use defaults",
  },
  qwen: {
    byLevel: {
      "read-only": "--approval-mode plan",
      low: "--approval-mode default",
      medium: "--approval-mode auto",
      high: "--approval-mode yolo",
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
    notes: "claude-compatible mapping via z.ai endpoint; grants counter the scrub-var permission hardening (edits, shell commands, and the web tools)",
  },
};
