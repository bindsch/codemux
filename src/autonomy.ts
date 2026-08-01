import type { AgentId, AutonomyLevel } from "./types.js";

export interface AutonomyMapping {
  byLevel: Record<AutonomyLevel, string>;
  notes?: string;
}

export const AUTONOMY_EQUIVALENCE: Record<AgentId, AutonomyMapping> = {
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
      "read-only": "--permission-mode plan",
      low: "--permission-mode manual",
      medium: "--permission-mode acceptEdits",
      high: "--dangerously-skip-permissions",
    },
    notes: "native 4-level mapping",
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
    notes: "agent is preferred; cursor-agent remains a compatibility fallback",
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
      medium: "--approval-mode auto_edit",
      high: "--approval-mode yolo",
    },
    notes: "uses Gemini approval modes",
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
    notes: "qwen-coder fallback requires the outer sandbox",
  },
  zai: {
    byLevel: {
      "read-only": "--permission-mode plan",
      low: "--permission-mode manual",
      medium: "--permission-mode acceptEdits",
      high: "--dangerously-skip-permissions",
    },
    notes: "claude-compatible mapping via z.ai endpoint",
  },
};
