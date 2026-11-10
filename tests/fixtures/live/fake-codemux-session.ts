/**
 * A scenario-driven fake of the codemux session CLI for the hermetic
 * session canary (src/hermetic-session-canary.ts): it speaks the
 * codemux-live-session/1 JSONL grammar on stdin/stdout, reports a
 * per-session private home under $FAKE_CODEMUX_HOME_ROOT keyed by the
 * session id (created at session_started, removed by --final), and reads
 * the planted code word from whichever instruction file the canary
 * planted: the --cwd's AGENTS.md or CLAUDE.md, $KIMI_CODE_HOME/AGENTS.md,
 * $HOME/.gemini/GEMINI.md, $HOME/.claude/CLAUDE.md, or $HOME/.codex/AGENTS.md.
 * A claude or zai session never reads the cwd files (Claude Code sessions
 * load the user setting source only); its plain mode reads the CLAUDE.md of
 * a CLAUDE_CONFIG_DIR passed through with --pass-env instead. It models a harness that loads the
 * planted file in its plain mode (real codex loads project documents
 * from the cwd by default; round 413, item 1 — a plain session sends no
 * thread config, so the control's marker must reach it) and skips it in
 * a hermetic one (the thread config's project-doc keys). Every spawn
 * appends one JSON line (argv,
 * flags, session id, marker found) to $FAKE_CODEMUX_STATE for the test's
 * assertions. No harness binary and no provider is ever contacted.
 *
 *   clean (default) — hermetic sessions answer OK, the control reveals
 *                     the planted code word, --final removes the home
 *   leak            — the first hermetic session answers the code word
 *   config-leak     — the first hermetic session keeps the passed-through
 *                     CLAUDE_CONFIG_DIR and answers its code word
 *   clean-control   — the control answers OK too, so the canary proves
 *                     nothing
 *   resume-leak     — the resumed hermetic session answers the code word
 *   no-persist      — a hermetic session removes its private home at end
 *                     even without --final
 *   final-keeps-home — --final leaves the private home in place
 *   wrong-end       — the session ends reason "stdin-close" instead of
 *                     "shutdown"
 *   refuse          — exit 64 with a refusal before any event
 *   crash           — session_started, then exit 1 mid-turn
 *   hang            — session_started and the echoed question, then no
 *                     answer until the canary's deadline kills it
 *
 * Env knobs: FAKE_CODEMUX_SCENARIO (default "clean"), the private-home
 * root FAKE_CODEMUX_HOME_ROOT, the state file FAKE_CODEMUX_STATE, and
 * FAKE_CODEMUX_IGNORE_SIGTERM, which holds SIGTERM so only the canary
 * driver's SIGKILL timer can end the child.
 */

import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { harnessHomeCanarySkillPath } from "../../../src/hermetic-session-canary-home.js";
import type { AgentId } from "../../../src/types.js";

const argv = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(name);

const scenario = process.env.FAKE_CODEMUX_SCENARIO ?? "clean";
const cwd = value("--cwd") ?? process.cwd();
const resume = value("--resume");
const hermetic = has("--hermetic");
const harnessHome = value("--harness-home");
const final = has("--final");
const sessionId = harnessHome !== undefined && resume !== undefined && scenario === "caller-resume-different-id"
  ? "fake-session-changed" : resume ?? (harnessHome === undefined ? "fake-session-1" : "fake-caller-session");
const homeRoot = process.env.FAKE_CODEMUX_HOME_ROOT ?? "";
const stateFile = process.env.FAKE_CODEMUX_STATE;
const privateHome = harnessHome ?? (homeRoot === "" ? "" : join(homeRoot, sessionId));

let marker = "NO-MARKER";
// Claude Code sessions pass `--setting-sources user`, which never loads the
// cwd's instruction files; only the config directory's CLAUDE.md (a caller
// home, or the operator's ~/.claude) reaches the model. The fake models
// that, so a canary whose control relies on the cwd files fails here too.
const claudeFamily = value("-a") === "claude" || value("-a") === "zai";
// A passed-through CLAUDE_CONFIG_DIR is the plain session's config directory.
const passedConfigDir = (value("--pass-env") ?? "").split(",").includes("CLAUDE_CONFIG_DIR")
  ? process.env.CLAUDE_CONFIG_DIR : undefined;
const plantedPaths = [
  ...(claudeFamily ? [] : [join(cwd, "AGENTS.md"), join(cwd, "CLAUDE.md")]),
  ...(claudeFamily && passedConfigDir !== undefined && harnessHome === undefined ? [join(passedConfigDir, "CLAUDE.md")] : []),
  join(process.env.KIMI_CODE_HOME ?? "", "AGENTS.md"),
  join(process.env.HOME ?? "", ".gemini", "GEMINI.md"),
  join(process.env.HOME ?? "", ".claude", "CLAUDE.md"),
  join(process.env.HOME ?? "", ".codex", "AGENTS.md"),
];
const findMarker = (paths: readonly string[]): string | undefined => {
  for (const path of paths) {
    try {
      const found = /CODEMUX-(?:AGY-)?CANARY-[0-9A-Za-z-]+/.exec(readFileSync(path, "utf8"));
      if (found !== null) return found[0];
    } catch {
      // Not planted here; the next path may carry the code word.
    }
  }
  return undefined;
};
marker = findMarker(plantedPaths) ?? marker;
// A leaking hermetic session (the leak scenarios) is a broken harness that
// loads the planted cwd files whatever its setting sources say; under
// config-leak it keeps the passed-through operator config directory instead
// of swapping in its private one, and reads only that.
const leakedMarker = (scenario === "config-leak"
  ? findMarker(passedConfigDir === undefined ? [] : [join(passedConfigDir, "CLAUDE.md")])
  : findMarker([join(cwd, "AGENTS.md"), join(cwd, "CLAUDE.md")])) ?? marker;

let skillMarker = "NO-SKILL";
// Only the caller-home arm passes --harness-home
// (src/hermetic-session-canary-home.ts), and it always plants a private
// skill there first. The read is unconditional so a canary that forgot to
// plant it fails here with ENOENT, naming the real cause.
const callerArm = harnessHome !== undefined;
if (harnessHome !== undefined) {
  const skill = harnessHomeCanarySkillPath(value("-a") as Exclude<AgentId, "cline">, harnessHome);
  skillMarker = /CODEMUX-CANARY-[0-9A-F]{8}/.exec(readFileSync(skill, "utf8"))?.[0] ?? "NO-SKILL";
}

if (stateFile !== undefined) {
  appendFileSync(
    stateFile,
    `${JSON.stringify({ argv, hermetic, harnessHome, operatorHome: process.env.HOME,
      resume: resume ?? null, final, sessionId, marker, skillMarker })}\n`
  );
}

if (process.env.FAKE_CODEMUX_IGNORE_SIGTERM !== undefined) {
  // The kill-escalation test: hold SIGTERM so the deadline's first signal
  // does not end the fake; only the driver's SIGKILL timer can.
  process.on("SIGTERM", () => {});
}

/** What each scenario changes about an otherwise well-formed session. */
let firstHermeticAnswer = "OK";
let controlAnswer = "marker";
let resumedAnswer = "OK";
let persistAfterSession = true;
let finalRemovesHome = true;
let endReason = "shutdown";
let refuseBeforeEvents = false;
let crashMidTurn = false;
let hangAfterEcho = false;
switch (scenario) {
  case "clean":
    break;
  case "leak":
  case "config-leak":
    firstHermeticAnswer = "marker";
    break;
  case "clean-control":
    controlAnswer = "OK";
    break;
  case "resume-leak":
    resumedAnswer = "marker";
    break;
  case "no-persist":
    persistAfterSession = false;
    break;
  case "final-keeps-home":
    finalRemovesHome = false;
    break;
  case "wrong-end":
    endReason = "stdin-close";
    break;
  case "refuse":
    refuseBeforeEvents = true;
    break;
  case "crash":
    crashMidTurn = true;
    break;
  case "hang":
    hangAfterEcho = true;
    break;
}

if (refuseBeforeEvents) {
  process.stderr.write(
    "Error: --hermetic is refused for sessions in this release: no verified hermetic canary covers a persistent, resumable session\n"
  );
  process.exit(64);
}

if (hermetic && privateHome !== "") {
  // Only a hermetic session gets a private home; the control runs as the
  // operator's own codemux would, on the operator's state.
  mkdirSync(privateHome, { recursive: true });
}

const emit = (fields: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ session_id: sessionId, ...fields })}\n`);
};

emit(
  (hermetic || harnessHome !== undefined) && privateHome !== ""
    ? { type: "session_started", private_home:
      (scenario === "caller-first-wrong-home" && callerArm) ||
      (scenario === "caller-resume-different-home" && callerArm && resume !== undefined) ||
      (scenario === "resume-home-swap" && hermetic && resume !== undefined)
        ? `${privateHome}-other` : privateHome }
    : { type: "session_started" }
);

let ended = false;
const endSession = (): void => {
  if (ended) return;
  ended = true;
  const removeHome = harnessHome === undefined
    ? !persistAfterSession || (final && finalRemovesHome)
    : final && scenario === "caller-final-removes-home";
  if (removeHome && privateHome !== "") {
    rmSync(privateHome, { recursive: true, force: true });
  }
  emit({ type: "session_ended", reason: endReason, exit_code: 0 });
  setTimeout(() => process.exit(0), 50);
};

process.stdin.setEncoding("utf8");
let pending = "";
process.stdin.on("data", (chunk: string) => {
  pending += chunk;
  for (;;) {
    const newline = pending.indexOf("\n");
    if (newline === -1) break;
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof frame !== "object" || frame === null) continue;
    const type = (frame as Record<string, unknown>)["type"];
    if (type === "shutdown") {
      endSession();
      continue;
    }
    if (type !== "user") continue;
    emit({ type: "user_message", input_seq: 1, text: "question received" });
    if (hangAfterEcho) continue;
    if (crashMidTurn) {
      process.stderr.write("Error: the harness child died mid-turn\n");
      process.exit(1);
    }
    if (callerArm && scenario === "caller-crash") {
      process.stderr.write("synthetic caller child failed\n");
      process.exit(1);
    }
    let wanted = hermetic ? (resume === undefined ? firstHermeticAnswer : resumedAnswer) : controlAnswer;
    if (callerArm) {
      wanted = scenario === "caller-missing-skill" ? "NONE" : skillMarker;
      if (scenario === "caller-first-leak" || (scenario === "caller-resume-leak" && resume !== undefined)) wanted = "marker";
      if (scenario === "caller-skill-banner-only") {
        emit({ type: "diagnostic", text: skillMarker });
        wanted = "NONE";
      }
    }
    emit({ type: "assistant_message", text: wanted !== "marker" ? wanted : hermetic ? leakedMarker : marker });
    emit({ type: "turn_completed", finish: "end" });
  }
});
process.stdin.on("end", () => {
  if (hangAfterEcho) {
    // The hung session answers nothing on any carrier; stay alive until
    // the canary's deadline kills the tree.
    setInterval(() => {}, 60_000);
    return;
  }
  endSession();
});
