import { join } from "node:path";
import type { BaseAdapter, RunContext } from "../adapters/base.js";
import { readUtf8FileBounded } from "../file-io.js";
import { parseCopilotUsageMetrics, readCopilotUsageFile, type CopilotRunContext } from "../copilot-usage.js";
import type { ResultUsageBlock, RunRequest } from "../types.js";
import { COPILOT_DRIVER_PROFILE } from "./copilot-driver.js";
import { COPILOT_SESSION_ID_PATTERN } from "./copilot-session.js";
import type { TurnAgentProfile } from "./turn-driver-types.js";

/** The latest completed native session snapshot is the baseline for a
 * resumed process. Copilot 1.0.85/1.0.103 persist session.shutdown with
 * modelMetrics (generated/session-events.d.ts ShutdownData), while the
 * stdout filter suppresses that event. Missing history is not zero usage. */
export function readCopilotSessionBaseline(home: string, id: string): ResultUsageBlock {
  if (!COPILOT_SESSION_ID_PATTERN.test(id)) throw new Error("invalid Copilot session id");
  const text = readUtf8FileBounded(join(home, "session-state", id, "events.jsonl"), {
    label: "Copilot session usage baseline", maxBytes: 32 * 1024 * 1024, noFollow: true,
  });
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index]!.trim() === "") continue;
    const event: unknown = JSON.parse(lines[index]!);
    if (typeof event !== "object" || event === null) continue;
    const value = event as { type?: unknown; data?: unknown };
    if (value.type === "session.shutdown") return parseCopilotUsageMetrics(value.data);
  }
  throw new Error("Copilot resume has no completed usage snapshot; refusing to count old tokens as new");
}

export function copilotUsageDelta(
  next: ResultUsageBlock,
  previous: ResultUsageBlock | null
): ResultUsageBlock {
  if (previous === null) return next;
  const difference = (key: "input_tokens" | "output_tokens" | "cached_input_tokens" | "total_tokens") => {
    const after = next[key];
    const before = previous[key];
    if (after === null || before === null || after < before) {
      throw new Error("Copilot cumulative usage is incomplete or decreased across turns");
    }
    return after - before;
  };
  return {
    input_tokens: difference("input_tokens"), output_tokens: difference("output_tokens"),
    cached_input_tokens: difference("cached_input_tokens"), total_tokens: difference("total_tokens"),
    cost_usd: null,
  };
}

/** Launcher integration is prepared in w3-copilot-shared.patch. A profile
 * is per session; every command uses that turn's adapter-owned artifacts.
 * The launcher must prepare resultJson:true and retain its executable check. */
export function createCopilotSessionProfile(input: {
  adapter: BaseAdapter;
  request: RunRequest;
  harnessHome: string;
  context(): RunContext | undefined;
}): TurnAgentProfile {
  let previous: ResultUsageBlock | null = null;
  return {
    ...COPILOT_DRIVER_PROFILE,
    buildTurnCommand(turn) {
      if (turn.sessionId === null) throw new Error("Copilot session identity is missing");
      if (!turn.firstTurn && previous === null) {
        previous = readCopilotSessionBaseline(turn.hermeticHome ?? input.harnessHome, turn.sessionId);
      }
      const context: CopilotRunContext = { ...input.context() };
      if (turn.hermeticHome !== null) {
        context.copilotHermeticHome = { home: turn.hermeticHome, finalize() {} };
      }
      const argv = input.adapter.buildRunCommand({
        ...input.request, resultJson: true, prompt: turn.text,
        model: turn.model, effort: turn.effort, autonomy: turn.autonomy,
      }, context);
      // Preserve this build's nested executable identity for the spawn recheck.
      const owner = input.context();
      if (owner !== undefined) owner.playwrightMcpCheck = context.playwrightMcpCheck;
      argv.push(turn.firstTurn ? "--session-id" : "--resume", turn.sessionId);
      return argv;
    },
    parseTurnOutput(stdout, id) {
      const verdict = COPILOT_DRIVER_PROFILE.parseTurnOutput!(stdout, id);
      try {
        const file = (input.context() as CopilotRunContext | undefined)?.copilotUsageFile;
        if (file === undefined) throw new Error("Copilot usage artifact was not prepared");
        const cumulative = readCopilotUsageFile(file);
        verdict.usage = copilotUsageDelta(cumulative, previous);
        previous = cumulative;
      } catch (error) {
        verdict.failed = true;
        verdict.failureReason ??= error instanceof Error ? error.message : String(error);
      }
      return verdict;
    },
  };
}
