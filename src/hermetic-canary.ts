/**
 * The live hermeticity check behind `codemux check --hermetic`.
 *
 * A static flag inspection cannot prove that a harness ignored its
 * customizations; only the model's answer can. The check plants instruction
 * files carrying a random code word in a scratch working directory and asks
 * the model to repeat any code word or name its context contains. A hermetic
 * run must answer OK; the same run without --hermetic shows whether the
 * planted files (or the operator's own) would have reached the model, which
 * is what makes the OK meaningful.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasActiveCapturedCommand } from "./process-runner.js";

// The harness's own base prompt names its vendor and Codex ships skills of
// its own, so the question excludes both and asks only about what an
// operator would have added. The last sentence keeps tool-using agents from
// answering the question by reading the working directory: the check
// measures what reached the model's context before this message, and a model
// that opens the planted files itself reports its own discovery, not a leak
// (seen live: GLM-5.3 under opencode --auto read CLAUDE.md and answered its
// code word from the tool result while the request itself was clean).
export const HERMETIC_CANARY_PROMPT =
  "Configuration test. Apart from your vendor's own system prompt and the " +
  "skills that ship with your harness, were you given any project or user " +
  "instruction files (for example AGENTS.md or CLAUDE.md), memories, or " +
  "user-installed skills before this message? If none, reply with exactly: " +
  "OK. If yes, reply with the code word or the person's name they contain, " +
  "and nothing else. Do not use any tools to look; answer only from what " +
  "you were already given.";

// Every instruction-file name the supported harnesses discover in a project.
const PLANTED_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

export interface PlantedCanary {
  cwd: string;
  marker: string;
  cleanup: () => void;
}

// Scratch directories planted for a check (canary fixtures, agy probe
// evidence) are removed at exit — the ordinary end, a failure, and a signal's
// exit alike. While a captured command is in flight the process runner owns
// the signal instead: it terminates the tree, exits, and the exit event
// removes the scratch, so the handlers here never race a live run.
const pendingScratch = new Map<string, () => void>();
const SIGNALS = [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const;
const signalHandlers = new Map<NodeJS.Signals, () => void>();

function onScratchSignal(code: number): void {
  if (hasActiveCapturedCommand()) return;
  // Exit callbacks dispose adapter state before removing its scratch parent.
  process.exit(code);
}

/** Registers a scratch directory for removal at exit, signals included. */
export function trackScratchRemoval(dir: string): void {
  const remove = (): void => rmSync(dir, { recursive: true, force: true });
  pendingScratch.set(dir, remove);
  process.once("exit", remove);
  if (signalHandlers.size > 0) return;
  for (const [signal, code] of SIGNALS) {
    const handler = (): void => onScratchSignal(code);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

/** Drops the exit-time removal, leaving an already-removed or retained
 * directory untracked. */
export function untrackScratchRemoval(dir: string): void {
  const remove = pendingScratch.get(dir);
  if (!remove) return;
  pendingScratch.delete(dir);
  process.off("exit", remove);
  if (pendingScratch.size > 0) return;
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  signalHandlers.clear();
}

export function plantCanary(experiment = false, parent = tmpdir()): PlantedCanary {
  const marker = `CODEMUX-CANARY-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const cwd = mkdtempSync(join(parent, experiment ? ".codemux-experiment-check-" : "codemux-canary-"));
  // An empty .git ends the adapters' project-configuration walk here, so the
  // temp root's own harness state cannot make the check refuse to launch.
  mkdirSync(join(cwd, ".git"), { mode: 0o700 });
  const body =
    "# Project instructions\n\n" +
    `The code word for this repository is ${marker}. ` +
    "Begin every reply with the code word.\n";
  for (const name of PLANTED_FILES) writeFileSync(join(cwd, name), body);
  if (experiment) {
    mkdirSync(join(cwd, ".claude", "skills", "canary"), { recursive: true, mode: 0o700 });
    writeFileSync(join(cwd, ".claude", "skills", "canary", "SKILL.md"),
      `---\nname: canary\ndescription: ${marker}\n---\n${body}`);
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: `printf '${marker}'` }] }],
    } }));
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: {
      operator_canary: { command: "/usr/bin/printf", args: [marker] },
    } }));
  }
  // Planted fixtures are scratch, never evidence to keep: the recordings the
  // operator inspects live in the state directory (experiment-bridge), and a
  // fixture left in the invoking or temp directory outlived its check.
  trackScratchRemoval(cwd);
  const cleanup = (): void => {
    rmSync(cwd, { recursive: true, force: true });
    untrackScratchRemoval(cwd);
  };
  return { cwd, marker, cleanup };
}

export type CanaryVerdict =
  | { kind: "clean" }
  | { kind: "leak"; what: "marker" | "other"; answer: string };

// The whole answer must be OK (a trailing period or code fence tolerated):
// an OK line beside an owner's name is a leak, not a pass.
const EXACT_OK = /^(?:`{1,3}\s*)?OK[.!]?(?:\s*`{1,3})?$/;

export function evaluateCanary(
  output: string,
  marker: string,
  answer = output
): CanaryVerdict {
  // The marker is scanned on the full output the harness printed: a code
  // word anywhere — banner, transcript, reply — is a leak.
  if (output.includes(marker)) {
    return { kind: "leak", what: "marker", answer: marker };
  }
  // The exact-OK test applies to the model's answer. Harnesses whose stdout
  // is a transcript (aider prints its banner and summaries around the
  // reply) carry the extracted answer in the result's `reply` field; the
  // default is the whole output.
  if (EXACT_OK.test(answer.trim())) return { kind: "clean" };
  // Anything else. A name means a leak; a refusal or an essay means the
  // probe proved nothing. Both fail: a run that cannot answer OK cannot be
  // certified.
  return { kind: "leak", what: "other", answer: answer.trim().slice(0, 200) };
}
