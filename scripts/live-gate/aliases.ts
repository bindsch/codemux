/** The live gate's session-leak and model-alias helpers, split from
 * scripts/live-gate/run.ts: everything a probe verifies about a session
 * record or a model alias, none of the probe orchestration. run.ts imports
 * what its probes use; scripts/live-gate.ts re-exports the public names, so
 * importers keep their paths. */

import { readFileSync } from "node:fs";
import { getAvailableAdapters } from "../../src/adapters/index.js";
import { SESSION_AGENTS } from "../../src/session/cli.js";
import { sessionRegistryPath } from "../../src/session/registry.js";
import type { AgentId, CodemuxConfig } from "../../src/types.js";
import { harnessFacts, verifyResultEnvelope, type HarnessFacts } from "./probes.js";

export function sessionHarnessFacts(): HarnessFacts[] {
  return getAvailableAdapters().map((adapter) =>
    harnessFacts(adapter.id, adapter.capabilities(), SESSION_AGENTS[adapter.id] !== undefined));
}

/** A live session entry left behind after the probe session exited means the
 * registry leaked a live record; the probe's shutdown did not complete.
 * The probe's own record is identified by its session id (parsed from the
 * capture's `session_started` line) or its working directory — the probe's
 * own fresh directory, so a live entry there is its leak whatever id it
 * carries. With both known, either one names a leak: a candidate that
 * printed a wrong session id must not hide a live entry in the probe's
 * directory (review round 199). With only one of them, that one's rule
 * applies; without either it falls back to the old rule — any live entry
 * of the same agent since the probe started — which fails the probe on an
 * operator's parallel session of the same agent (review round 10,
 * contracts 8). */
export function liveSessionLeak(
  agent: AgentId,
  sinceMs: number,
  registryPath = sessionRegistryPath(),
  sessionId?: string,
  cwd?: string
): string | null {
  try {
    const file = JSON.parse(readFileSync(registryPath, "utf8")) as {
      sessions?: { id?: string; agent?: string; cwd?: string; ended?: string | null; created_at?: string }[];
    };
    const leaked = (file.sessions ?? []).filter((entry) => {
      if (entry.ended != null) return false;
      if (sessionId !== undefined && cwd !== undefined) {
        return entry.id === sessionId || entry.cwd === cwd;
      }
      if (sessionId !== undefined) return entry.id === sessionId;
      if (cwd !== undefined) return entry.cwd === cwd;
      return entry.agent === agent && Date.parse(entry.created_at ?? "") >= sinceMs;
    });
    return leaked.length > 0 ? `${leaked.length} live registry entr${leaked.length === 1 ? "y" : "ies"} left for ${agent}` : null;
  } catch (error) {
    // Only an absent registry file is nothing to check: this machine ran
    // the probe's session against no registry codemux can see. A registry
    // that exists but cannot be read or parsed fails the probe — reading
    // it as "no leak" would certify the end state the RELEASE-GATE
    // contract names (probe F: the entry must be removed or marked ended)
    // without ever looking at it (review round 16, contracts-2 1).
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    const reason = error instanceof Error ? error.message : String(error);
    return `could not read the live-session registry at ${registryPath}: ${reason}`;
  }
}

/** The alias probe I carries (audit D7): `worker` when the effective
 * config maps it for this harness, else the first alias that does. The
 * launched run resolves the alias through that same config, so the target
 * here is the target there. Null when no alias maps the harness — the cell
 * skips rather than run `-m` on a name nobody resolves. */
export function modelAliasFor(agent: AgentId, config: CodemuxConfig): { alias: string; model: string } | null {
  for (const alias of ["worker", "clerk", "judge"]) {
    const model = config.models[alias]?.[agent];
    if (model !== undefined) return { alias, model };
  }
  for (const [alias, mapping] of Object.entries(config.models)) {
    const model = mapping[agent];
    if (model !== undefined) return { alias, model };
  }
  return null;
}

/** Whether a reported model id names the alias's target. The envelope's
 * `codemux.model` is the served model when the provider names one, so
 * three shapes name the target: the same string; the target followed by
 * an eight-digit release date (`claude-sonnet-5-5-20261001`); and, for a
 * target that is one word of letters — a harness's own family name — an
 * id made of a vendor word, that family word, and numbers only (`sonnet`
 * is served as `claude-sonnet-5-5`; live gate, 2026-11-06). Nothing
 * looser: a target with a version in it must match exactly, so
 * `claude-sonnet-5` does not accept `claude-sonnet-5-high`;
 * `claude-opus-5-5` does not name `sonnet`; and a word that is not the
 * id's family, such as `high` in `claude-sonnet-5-high`, names nothing
 * (review rounds 180 and 184). */
export function modelNamesTarget(model: string, target: string): boolean {
  if (model === target) return true;
  if (target === "") return false;
  if (model.startsWith(`${target}-`) && /^\d{8}$/.test(model.slice(target.length + 1))) return true;
  if (!/^[A-Za-z]+$/.test(target)) return false;
  const [vendor, ...rest] = model.split("-");
  return /^[A-Za-z]+$/.test(vendor ?? "") && rest.includes(target) &&
    rest.every((word) => word === target || /^\d+$/.test(word));
}

/** Probe I's verification where the harness reports result JSON (audit
 * D7): probe C's envelope checks, plus `codemux.model` naming the alias's
 * target — an alias that quietly selects another model fails here. */
export function verifyAliasEnvelope(stdout: string, agent: AgentId, expectedModel: string): string | null {
  const base = verifyResultEnvelope(stdout, agent);
  if (base !== null) return base;
  const envelope = JSON.parse(stdout) as { codemux?: { model?: unknown } };
  const model = envelope.codemux?.model;
  if (typeof model !== "string" || !modelNamesTarget(model, expectedModel)) {
    return `result JSON's codemux.model is ${JSON.stringify(model) ?? "absent"}, not the alias's target ${JSON.stringify(expectedModel)}`;
  }
  return null;
}
