import type { AgentId } from "./types.js";
import { CLINE_INSTRUCTION_CHANNEL } from "./cline-isolation-probe.js";

/** Every adapter that advertises supportsHermetic. */
export type HermeticAgentId = Exclude<AgentId, "cursor">;

export const HERMETIC_CHECK_MARKER = "{{MARKER}}";

export interface InstructionCheckChannel {
  kind: "channel";
  location: "cwd" | "home";
  /** Relative filenames and their contents. The planter replaces {{MARKER}}. */
  files: Readonly<Record<string, string>>;
  control: { drop: "hermetic" | "no-custom-instructions" };
  /** Both runs receive the scratch home; the hermetic adapter overrides it. */
  homeEnv?: "HOME" | "GEMINI_CLI_HOME" | "COPILOT_HOME" | "XDG_CONFIG_HOME";
  /** These agents already have planters that preserve their login carriers. */
  custom?: "kimi" | "agy";
  evidence: string;
}

export type HermeticCheckChannel = InstructionCheckChannel | {
  kind: "limitation";
  reason: string;
  evidence: string;
};

const INSTRUCTIONS =
  `The code word is ${HERMETIC_CHECK_MARKER}. Begin every reply with this code word.\n`;

const CLAUDE_EVIDENCE =
  "Read 2026-11-09: @anthropic-ai/claude-code/package.json, version 2.1.317; " +
  "bin/claude.exe contains 'Start with all customizations (CLAUDE.md, skills, " +
  "installed plugins, hooks, MCP servers, custom commands and agents, output styles, " +
  "workflows, custom themes, keybindings, and more) disabled'. Its instructionFiles " +
  "text says 'claude-md-or-agents-md' is the default: AGENTS.md is a fallback " +
  "when the project has no CLAUDE.md. Z.AI uses this same executable.";

/** A control opens exactly the named instruction channel. A missing entry is a
 * type error; unsupported checks carry a reason instead of a false clean pass. */
export const HERMETIC_CHECK_CHANNELS = {
  cline: CLINE_INSTRUCTION_CHANNEL,
  claude: {
    kind: "channel", location: "cwd",
    files: { "AGENTS.md": INSTRUCTIONS, "CLAUDE.md": INSTRUCTIONS },
    control: { drop: "hermetic" }, evidence: CLAUDE_EVIDENCE,
  },
  zai: {
    kind: "channel", location: "cwd",
    files: { "AGENTS.md": INSTRUCTIONS, "CLAUDE.md": INSTRUCTIONS },
    control: { drop: "hermetic" }, evidence: CLAUDE_EVIDENCE,
  },
  codex: {
    kind: "channel", location: "cwd", files: { "AGENTS.md": INSTRUCTIONS },
    control: { drop: "hermetic" },
    evidence: "Read 2026-11-09: Caskroom/codex/0.166.0/bin/codex contains " +
      "'core/src/agents_md.rs', 'AGENTS.override.md', 'AGENTS.md', and " +
      "'ignoring project_doc_fallback_filenames entry that is not a filename'. " +
      "The native instruction precedence names AGENTS.override.md, AGENTS.md, " +
      "then configured fallback filenames; CLAUDE.md is not a default candidate.",
  },
  kimi: {
    kind: "channel", location: "home", custom: "kimi",
    files: { ".kimi-code/AGENTS.md": INSTRUCTIONS, ".agents/AGENTS.md": INSTRUCTIONS },
    control: { drop: "hermetic" },
    evidence: "Read 2026-11-09: .kimi-code/bin/kimi contains " +
      "'version: optionalBuildString(\"2.5.2\")', " +
      "'await collect(personalFs, join$104(brandDir, \"AGENTS.md\"))', and " +
      "'candidates: [join$104(realHome, \".agents\", \"AGENTS.md\"), " +
      "join$104(realHome, \".agents\", \"agents.md\")]'. " +
      "The brand root resolves KIMI_CODE_HOME before .kimi-code. The existing " +
      "plantKimiCanary plants both personal instruction files with a clean cwd.",
  },
  agy: {
    kind: "channel", location: "home", custom: "agy", homeEnv: "HOME",
    files: { ".gemini/GEMINI.md": INSTRUCTIONS }, control: { drop: "hermetic" },
    evidence: "Read 2026-11-09: .local/bin/agy contains version '1.5.3', " +
      "'Directory-Based Rules (`GEMINI.md` / `AGENTS.md`)', and " +
      "'Fixed global rules being added to the agent\u0027s context more than once " +
      "when ~/.gemini/GEMINI.md, ~/.gemini/AGENTS.md, or their ~/.gemini/config/ " +
      "counterparts are symlinks to the same file' (Markdown backticks omitted). " +
      "src/agy-isolation-probe.ts plantAgyCanary already plants .gemini/GEMINI.md " +
      "under its scratch operator HOME, plus a separate MCP marker; the " +
      "hermetic/control pair keeps its clean working directory.",
  },
  opencode: {
    kind: "channel", location: "cwd", files: { "AGENTS.md": INSTRUCTIONS },
    control: { drop: "hermetic" },
    evidence: "Read 2026-11-09: .opencode/bin/opencode contains " +
      "'var Oe=\"1.19.5\",gs=\"latest\"', " +
      "'targets:[\"AGENTS.md\"]', and " +
      "'f=[\"AGENTS.md\",...!r.disableClaudeCodePrompt?[\"CLAUDE.md\"]:[]'. " +
      "AGENTS.md is the primary project instruction file; CLAUDE.md is a " +
      "compatibility candidate. Hermetic launch disables project discovery.",
  },
  aider: {
    kind: "channel", location: "home", homeEnv: "HOME",
    files: {
      ".aider.conf.yml": "read: [~/.aider/canary.md]\n",
      ".aider/canary.md": INSTRUCTIONS,
    },
    control: { drop: "hermetic" },
    evidence: "Read 2026-11-09: aider_chat-0.86.2.dist-info/METADATA says " +
      "'Version: 0.86.2'. aider/main.py:476 appends " +
      "'Path.home() / conf_fname', where conf_fname is '.aider.conf.yml'; " +
      "main.py:682-683 processes 'for fn in args.read or []' through " +
      "'Path(fn).expanduser().resolve()'. aider/args.py:736 defines '--read'. " +
      "configargparse.py (1.7.1):1212-1216 opens all default_config_files " +
      "before adding the explicit --config file; :920 iterates " +
      "'reversed(config_streams)'. An empty --config does not erase the home read key. " +
      "The home config loads the named instruction file; AGENTS.md and " +
      "CLAUDE.md alone are not this channel. Both runs keep a clean cwd.",
  },
  copilot: {
    kind: "channel", location: "home", homeEnv: "COPILOT_HOME",
    files: { "copilot-instructions.md": INSTRUCTIONS },
    control: { drop: "no-custom-instructions" },
    evidence: "Read 2026-11-09: .cache/copilot/pkg/darwin-arm64/1.0.85/app.js:1547 " +
      "lists '$HOME/.copilot/copilot-instructions.md'; app.js:189 resolves " +
      "'process.env.COPILOT_HOME' before the default .copilot directory. " +
      "app.js:2820 says 'Disabled for this session by --no-custom-instructions.' " +
      "The scratch COPILOT_HOME is shared by the two hermetic requests; " +
      "only the control removes --no-custom-instructions.",
  },
  droid: {
    kind: "channel", location: "home", homeEnv: "HOME",
    files: { ".factory/AGENTS.md": INSTRUCTIONS }, control: { drop: "hermetic" },
    evidence: "Read 2026-11-09: .local/bin/droid embeds " +
      "'name:\"@factory/cli\",version:\"0.221.0\"' and " +
      "'Bb=[\"CLAUDE.md\",\"Claude.md\",\"AGENTS.md\",\"Agents.md\",\"agents.md\"]'. " +
      "The guideline resolver's tU() includes '.factory', '.agents', '.agent'; " +
      "E() joins these to homeDir and marks them 'isPersonal:!0'. " +
      "dK calls C(Bb,e,\"Agents.md\"). A project AGENTS.md would reach both runs, " +
      "so this check plants only the home instruction file.",
  },
  gemini: {
    kind: "channel", location: "home", homeEnv: "GEMINI_CLI_HOME",
    files: { ".gemini/GEMINI.md": INSTRUCTIONS }, control: { drop: "hermetic" },
    evidence: "Read 2026-11-09: @google/gemini-cli/package.json says 0.60.0. " +
      "bundle/chunk-VCAJDPDX.js:251984 homedir() reads " +
      "'process.env[\"GEMINI_CLI_HOME\"]'; :253172 getGlobalGeminiDir() returns " +
      "'path4.join(homeDir, GEMINI_DIR)', with GEMINI_DIR='.gemini'; :253523 " +
      "getGlobalMemoryFilePath() joins that directory and getCurrentGeminiMdFilename(). " +
      "bundle/chunk-CMLALLX3.js:66240 defaults to '[\"GEMINI.md\"]'. " +
      "Both runs keep a clean cwd and the same planted home.",
  },
  goose: {
    kind: "channel", location: "home", homeEnv: "XDG_CONFIG_HOME",
    files: { "goose/.goosehints": INSTRUCTIONS }, control: { drop: "hermetic" },
    evidence: "Read 2026-11-09: .local/bin/goose contains 'goose/1.50.1', " +
      "'crates/goose/src/hints/load_hints.rs', 'CONTEXT_FILE_NAMES.goosehints', " +
      "'### Global Hints', and 'These are my global goose hints.'. " +
      "Tagged v1.50.1 source crates/goose/src/hints/load_hints.rs:223-226 " +
      "maps global names through 'Paths::in_config_dir(name)'; " +
      "crates/goose/src/config/paths.rs selects the goose application config root " +
      "with etcetera choose_app_strategy (XDG on Linux and macOS). " +
      "Both runs keep a clean cwd; hermetic launch replaces XDG_CONFIG_HOME.",
  },
  openhands: {
    kind: "channel", location: "home", homeEnv: "HOME",
    files: {
      ".openhands/microagents/canary.md":
        "---\nname: codemux-canary\n---\n" + INSTRUCTIONS,
    },
    control: { drop: "hermetic" },
    evidence: "Read 2026-11-09: openhands-1.16.0.dist-info/METADATA says " +
      "'Version: 1.16.0'. openhands_cli/stores/agent_store.py:418 sets " +
      "'load_user_skills=True'; openhands/sdk/skills/skill.py:722-726 " +
      "USER_SKILLS_DIRS includes 'Path.home() / \".openhands\" / \"microagents\"'. " +
      "skill.py:476-481 makes a legacy skill with no triggers 'trigger=None'; " +
      ":119 describes 'Full content in <REPO_CONTEXT>, always active'. " +
      "Both runs keep a clean cwd and differ only in hermetic HOME isolation.",
  },
  pi: {
    kind: "channel", location: "cwd",
    files: { "AGENTS.md": INSTRUCTIONS, "CLAUDE.md": INSTRUCTIONS },
    control: { drop: "hermetic" },
    evidence: "Read 2026-11-09: @earendil-works/pi-coding-agent/package.json " +
      "says 0.85.1. dist/core/resource-loader.js:33 declares " +
      "'const candidates = [\"AGENTS.override.md\", \"AGENTS.md\", \"AGENTS.MD\", " +
      "\"CLAUDE.md\", \"CLAUDE.MD\"]'. Hermetic launch passes --no-context-files; " +
      "the control reopens AGENTS.md discovery.",
  },
  qwen: {
    kind: "limitation",
    reason: "Qwen 0.24.0's --safe-mode disables context files, hooks, " +
      "extensions, skills, and MCP servers as one block, with no flag that " +
      "reopens instruction-file discovery alone, and a paired check needs a " +
      "control run with the channel open; codemux never launches qwen outside " +
      "safe mode (it IS the isolation claim), so no control run exists",
    evidence: "Read 2026-11-09: @qwen-code/qwen-code/package.json says 0.24.0. " +
      "chunks/chunk-BSIOCNDK.js:75-78 describes safe-mode: 'Disable all " +
      "customizations (context files, hooks, extensions, skills, MCP servers) " +
      "for troubleshooting.' — one block, no partial reopen flag anywhere in " +
      "the option table. chunks/chunk-25FMWESU.js:5749 sets " +
      "'DEFAULT_CONTEXT_FILENAME = \"QWEN.md\"'. src/adapters/qwen.ts " +
      "unconditionally includes --safe-mode in run and interactive commands.",
  },
} as const satisfies Record<HermeticAgentId, HermeticCheckChannel>;
