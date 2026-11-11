import { limitation } from "./features.js";

const test = "tests/sandbox-strict-live-evidence.test.ts";
const hookReason = "Strict does not grant operator hook programs outside the project or harness state. A blocked UserPromptSubmit hook can prevent the model call. Hermetic headless runs passed the live OK probe; ordinary runs with external hooks did not. Hermetic Codex and Z.AI sessions also answered OK in Round 3; Claude sessions remain untested because of quota. TUI has fixture coverage only.";
const hookEvidence = "2026-11-11, scode 0.6.5 on macOS: an external agentstat hook script was denied with Operation not permitted; its Python loader exited 2. Codex 0.166.0 returned a zero-token turn and no last message. Claude Code 2.1.317 (including Z.AI) reported UserPromptSubmit operation blocked by hook. Matching hermetic runs returned OK. Codex source hooks/src/events/user_prompt_submit.rs treats exit 2 as a block; exec/src/event_processor_with_jsonl_output.rs drops HookCompleted events.";

export const STRICT_LIMITATIONS = {
  agy: limitation(
    "Strict refuses env-wrapped executables outside scode's system read grants with exit 64, at every wrapper depth. It never uses a writable --allow for executable code. A system installation can avoid this limitation.",
    "2026-11-11, scode 0.6.5 --help: --allow PATH Request recursive access (subject to policy precedence; repeatable); --ro Mount project directory read-only. No read-only path grant exists. A non-agent strict cat of ~/.local/bin/agy failed with Operation not permitted; the installed wrapped launch is refused before spawn.",
    "strict sandbox cannot read env-wrapped executable", test),
  opencode: limitation(
    "Ordinary strict launches of ~/.opencode/bin/opencode are refused because the .opencode runtime-state grant would make the executable writable. Strict also refuses nested env-wrapped executables outside scode's system read grants. Hermetic private state remains allowed beneath launcher isolation blocks, but scode cannot grant the installed home-directory binary read-only access.",
    "2026-11-11, scode 0.6.5 --help lists only --allow PATH Request recursive access and --ro for the project. The installed hermetic session preview names ~/.opencode/bin/opencode and exits 64. Nested-wrapper and isolation-order regressions cover the refusal without a writable binary grant.",
    "strict sandbox cannot read env-wrapped executable", test),
  cline: limitation(
    "Cline sessions use an env wrapper. Strict refuses installations outside scode's system read grants instead of making the executable writable. Cline is not installed locally, so no live strict support is claimed.",
    "2026-11-11, scode 0.6.5 --help: --allow PATH Request recursive access; --ro applies only to the project. A fixture-backed Cline session outside system roots exits 64 naming its env-wrapped executable. No installed Cline binary was probed.",
    "strict sandbox cannot read env-wrapped executable", test),
  aider: limitation(
    "The installed Python launcher cannot start under strict; interpreter and package dependencies outside system roots are not automatically granted. Other modes have fixture coverage only.",
    "2026-11-11, default-model probe with scode 0.6.5: sandbox-exec execvp of ~/.local/pipx/venvs/aider-chat/bin/aider failed: Operation not permitted; exit 71. No OK answer.",
    "Operation not permitted", test),
  openhands: limitation(
    "The installed Python launcher cannot start under strict; interpreter and package dependencies outside system roots are not automatically granted. Other modes have fixture coverage only.",
    "2026-11-11, default-model probe with scode 0.6.5: sandbox-exec execvp of ~/.local/share/uv/tools/openhands/bin/openhands failed: Operation not permitted; exit 71. No OK answer.",
    "Operation not permitted", test),
  goose: limitation(
    "The installed Goose cannot initialize its state database under strict. No additional state grant has been certified; other modes have fixture coverage only.",
    "2026-11-11, default-model probe with scode 0.6.5: logging at ~/.local/state/goose/logs failed with File exists, then session_manager.rs:930 panicked creating the session database directory; exit 1. No OK answer.",
    "Failed to create session database directory", test),
  droid: limitation(
    "Local validation limitation: the default-model probe failed on upstream authentication. No strict runtime success is claimed; this is not a demonstrated sandbox denial.",
    "2026-11-11, Droid 0.221.0 default-model strict probe: HTTP 503 auth_unavailable for claude-fable-5-1, exit 1. No denied filesystem path or OK answer.",
    "auth_unavailable", test),
  gemini: nodePackageLimitation(),
  pi: nodePackageLimitation(),
  qwen: nodePackageLimitation(),
  codex: limitation(hookReason, hookEvidence, "codex exited 0 with an empty answer", test),
  claude: limitation(hookReason, hookEvidence, "UserPromptSubmit operation blocked by hook", test),
  zai: limitation(hookReason, hookEvidence, "UserPromptSubmit operation blocked by hook", test),
  kimi: limitation(
    "Kimi 2.5.2 watches the shared .agents directory outside its scode state grant and aborts under strict. The path is deliberately not reopened without a passing live probe. A later probe was refused by the account quota gate.",
    "2026-11-11, installed Kimi 2.5.2 with scode 0.6.5: watch on ~/.agents raised EPERM; codemux exited 1 with an empty answer. The next clerk probe stopped before launch at 0% remaining quota. The installed main.cjs stack names Actor.start and syscall watch.",
    "EPERM", test),
  cursor: limitation(
    "Local validation limitation: the default-model probe is held by the configured 10% quota reserve. No live strict support is claimed; this is an environment prerequisite, not a demonstrated sandbox defect.",
    "2026-11-11, cmx quota precheck reported 8.49% primary remaining and did not send the default-model probe. No sandbox was started, so there is no denied path.",
    "primary window has 8% left", test),
  copilot: limitation(
    "Local validation limitation: the default-model probe is refused because an ancestor repository carries executable configuration. No live strict support is claimed.",
    "2026-11-11, default-model strict probe from the worktree's scratch directory: exit 64, Copilot refuses repository executable configuration at the worktree's .claude/settings.json. No sandbox was started, so there is no denied path.",
    "Copilot refuses repository executable configuration", test),
};

function nodePackageLimitation() {
  return limitation(
    "The installed Node harness cannot read an ancestor package.json outside the strict probe project. No broad ancestor grant is added; other modes have fixture coverage only.",
    "2026-11-11, default-model strict probe under the codemux worktree with scode 0.6.5 and Node 26.12.1: Cannot read package config at the worktree's package.json: operation not permitted; ERR_INVALID_PACKAGE_CONFIG, exit 1. No OK answer.",
    "ERR_INVALID_PACKAGE_CONFIG", test);
}
