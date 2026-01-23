import type { AgentId } from "../types.js";
import { BaseAdapter } from "./base.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { DroidAdapter } from "./droid.js";
import { GooseAdapter } from "./goose.js";
import { GeminiAdapter } from "./gemini.js";
import { OpencodeAdapter } from "./opencode.js";
import { QwenAdapter } from "./qwen.js";
import { ZaiAdapter } from "./zai.js";

const adapters: Record<AgentId, BaseAdapter> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
  droid: new DroidAdapter(),
  goose: new GooseAdapter(),
  gemini: new GeminiAdapter(),
  opencode: new OpencodeAdapter(),
  qwen: new QwenAdapter(),
  zai: new ZaiAdapter(),
};

export function getAdapter(id: AgentId): BaseAdapter {
  const adapter = adapters[id];
  if (!adapter) {
    throw new Error(`Unknown agent: ${id}`);
  }
  return adapter;
}

export function getAllAdapters(): BaseAdapter[] {
  return Object.values(adapters);
}

export function getAvailableAdapters(): BaseAdapter[] {
  return getAllAdapters().filter((a) => a.isAvailable());
}

export const AGENT_IDS: AgentId[] = [
  "claude",
  "codex",
  "droid",
  "goose",
  "gemini",
  "opencode",
  "qwen",
  "zai",
];

export { BaseAdapter };
