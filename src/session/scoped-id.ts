import { randomUUID } from "node:crypto";
import type { AgentId } from "../types.js";

// Goose uses a database-local day/counter. Cline uses milliseconds plus
// only five random characters. Neither is a globally unique registry key.
const SCOPED_AGENTS = new Set<AgentId>(["goose", "cline"]);
const PREFIX = /^(goose|cline)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}--(.+)$/;

export function scopedSessionId(agent: AgentId, nativeId: string): string {
  return SCOPED_AGENTS.has(agent) ? `${agent}-${randomUUID()}--${nativeId}` : nativeId;
}

/** Legacy native IDs remain resumable through their existing registry entry. */
export function nativeSessionId(agent: AgentId, id: string): string {
  const match = PREFIX.exec(id);
  return match?.[1] === agent ? match[2]! : id;
}

export function scopedResumePattern(agent: AgentId, native: RegExp): RegExp {
  if (!SCOPED_AGENTS.has(agent)) return native;
  const prefix = `${agent}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}--`;
  const body = native.source.replaceAll("(?=^", "(?=").replaceAll("(?:^", "(?:").replace(/^\^/, "");
  return new RegExp(`^(?:${prefix})?(?:${body})$`, native.flags);
}
