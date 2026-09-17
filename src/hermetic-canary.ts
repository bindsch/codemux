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

// The harness's own base prompt names its vendor and Codex ships skills of
// its own, so the question excludes both and asks only about what an
// operator would have added.
export const HERMETIC_CANARY_PROMPT =
  "Configuration test. Apart from your vendor's own system prompt and the " +
  "skills that ship with your harness, were you given any project or user " +
  "instruction files (for example AGENTS.md or CLAUDE.md), memories, or " +
  "user-installed skills before this message? If none, reply with exactly: " +
  "OK. If yes, reply with the code word or the person's name they contain, " +
  "and nothing else.";

// Every instruction-file name the supported harnesses discover in a project.
const PLANTED_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

export interface PlantedCanary {
  cwd: string;
  marker: string;
  cleanup: () => void;
}

export function plantCanary(): PlantedCanary {
  const marker = `CODEMUX-CANARY-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const cwd = mkdtempSync(join(tmpdir(), "codemux-canary-"));
  // An empty .git ends the adapters' project-configuration walk here, so the
  // temp root's own harness state cannot make the check refuse to launch.
  mkdirSync(join(cwd, ".git"), { mode: 0o700 });
  const body =
    "# Project instructions\n\n" +
    `The code word for this repository is ${marker}. ` +
    "Begin every reply with the code word.\n";
  for (const name of PLANTED_FILES) writeFileSync(join(cwd, name), body);
  // A signal during a probe ends the process from the runner; the planted
  // code word must not outlive it.
  const cleanup = (): void => {
    rmSync(cwd, { recursive: true, force: true });
    process.off("exit", cleanup);
  };
  process.once("exit", cleanup);
  return { cwd, marker, cleanup };
}

export type CanaryVerdict =
  | { kind: "clean" }
  | { kind: "leak"; what: "marker" | "other"; answer: string };

// The whole answer must be OK (a trailing period or code fence tolerated):
// an OK line beside an owner's name is a leak, not a pass.
const EXACT_OK = /^(?:`{1,3}\s*)?OK[.!]?(?:\s*`{1,3})?$/;

export function evaluateCanary(output: string, marker: string): CanaryVerdict {
  if (output.includes(marker)) {
    return { kind: "leak", what: "marker", answer: marker };
  }
  if (EXACT_OK.test(output.trim())) return { kind: "clean" };
  // Anything else. A name means a leak; a refusal or an essay means the
  // probe proved nothing. Both fail: a run that cannot answer OK cannot be
  // certified.
  return { kind: "leak", what: "other", answer: output.trim().slice(0, 200) };
}
