import type { AgentId, AutonomyLevel } from "./types.js";

export interface AutonomyMapping {
  byLevel: Record<AutonomyLevel, string>;
  notes?: string;
}

export const AUTONOMY_EQUIVALENCE: Record<AgentId, AutonomyMapping> = {
  claude: {
    byLevel: {
      "read-only": "default mode",
      low: "--permission-mode acceptEdits",
      medium: "--permission-mode dontAsk",
      high: "--dangerously-skip-permissions",
    },
    notes: "native 4-level mapping",
  },
  codex: {
    byLevel: {
      "read-only": "-s read-only",
      low: "-s read-only",
      medium: "-s workspace-write",
      high: "-s danger-full-access",
    },
    notes: "low maps to read-only; under --sandbox, scode enforces boundaries",
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
      "read-only": "--agent explore",
      low: "--agent explore",
      medium: "--agent build",
      high: "--agent build",
    },
    notes: "explore/build profiles only",
  },
  pi: {
    byLevel: {
      "read-only": "--tools read,grep,find,ls",
      low: "default tools",
      medium: "default tools",
      high: "default tools",
    },
    notes: "no dedicated approval-gate levels in pi CLI",
  },
  qwen: {
    byLevel: {
      "read-only": "--approval-mode plan",
      low: "--approval-mode default",
      medium: "--approval-mode auto-edit",
      high: "--approval-mode yolo",
    },
    notes: "qwen-coder fallback keeps legacy behavior",
  },
  zai: {
    byLevel: {
      "read-only": "default mode",
      low: "--permission-mode acceptEdits",
      medium: "--permission-mode dontAsk",
      high: "--dangerously-skip-permissions",
    },
    notes: "claude-compatible mapping via z.ai endpoint",
  },
};
