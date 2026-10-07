import { AGENT_IDS, type AgentId } from "../types.js";
import { BaseAdapter } from "./base.js";
import { AgyAdapter } from "./agy.js";
import { AiderAdapter } from "./aider.js";
import { ClaudeAdapter } from "./claude.js";
import { ClineAdapter } from "./cline.js";
import { CodexAdapter } from "./codex.js";
import { CopilotAdapter } from "./copilot.js";
import { CursorAdapter } from "./cursor.js";
import { DroidAdapter } from "./droid.js";
import { GooseAdapter } from "./goose.js";
import { GeminiAdapter } from "./gemini.js";
import { KimiAdapter } from "./kimi.js";
import { OpenHandsAdapter } from "./openhands.js";
import { OpencodeAdapter } from "./opencode.js";
import { PiAdapter } from "./pi.js";
import { QwenAdapter } from "./qwen.js";
import { ZaiAdapter } from "./zai.js";

// The environment view an adapter is constructed against. The launch path
// passes nothing and gets process.env — the operator's shell, exported
// opt-ins and provider overrides included. Static diagnostics pass their
// own explicit view (verify an empty one), so an exported variable cannot
// change a static wiring result: every constructor that consumes a view is
// handed the factory's argument here.
type AdapterEnv = Record<string, string | undefined>;
type AdapterFactory = (env: AdapterEnv) => BaseAdapter;

const adapterFactories: Readonly<Record<AgentId, AdapterFactory>> = Object.freeze({
  agy: (env) => new AgyAdapter(env),
  aider: (env) => new AiderAdapter(env),
  claude: (env) => new ClaudeAdapter(env),
  cline: (env) => new ClineAdapter(env),
  codex: (env) => new CodexAdapter(env),
  copilot: (env) => new CopilotAdapter(env),
  cursor: (env) => new CursorAdapter(undefined, env),
  droid: (env) => new DroidAdapter(env),
  goose: (env) => new GooseAdapter(env),
  gemini: (env) => new GeminiAdapter(env),
  kimi: (env) => new KimiAdapter(env),
  openhands: (env) => new OpenHandsAdapter(env),
  opencode: (env) => new OpencodeAdapter(env),
  pi: (env) => new PiAdapter(env),
  qwen: (env) => new QwenAdapter(undefined, env),
  zai: (env) => new ZaiAdapter(env),
});

// Constructed per call, never cached: an adapter views the environment at
// the moment it is obtained, so a caller that passes its own view (verify)
// or a test that exports an opt-in mid-process is never answered from a
// stale module-load snapshot. Construction is spawn-free Bun.which work,
// so nothing here costs a process.
export function getAdapter(id: AgentId, env: AdapterEnv = process.env): BaseAdapter {
  const factory = adapterFactories[id];
  if (!factory) {
    throw new Error(`Unknown agent: ${id}`);
  }
  return factory(env);
}

export function getAllAdapters(): readonly BaseAdapter[] {
  return Object.values(adapterFactories).map((factory) => factory(process.env));
}

export function getAvailableAdapters(): readonly BaseAdapter[] {
  return getAllAdapters().filter((a) => a.isAvailable());
}

export { AGENT_IDS };

export { BaseAdapter };
