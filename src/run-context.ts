import type { HermeticHome } from "./hermetic-home.js";
import type { StdoutSink } from "./process-runner.js";
import type { ExecutableCheck } from "./executable-security.js";
import type { ExperimentBridge } from "./experiment-bridge.js";
import type { ExperimentCodexRun } from "./experiment-codex-run.js";
import type { ExperimentKimiRun } from "./experiment-kimi-run.js";
import type { OpencodeExperimentRun } from "./opencode-experiment-run.js";
import type { GeminiExperimentRun } from "./gemini-experiment-run.js";
import type { PiExperimentRun } from "./pi-experiment-run.js";
import type { GooseExperimentRun } from "./goose-experiment-run.js";
import type { QwenExperimentRun } from "./qwen-experiment-run.js";
import type { ClineExperimentRun } from "./cline-experiment-run.js";
import type { ClaudeProjectConfigDir } from "./claude-project-config.js";
import type { CodexProviderHome } from "./codex-provider.js";
import type { AiderHistoryFile } from "./aider-history.js";
import type { AiderHermeticHome } from "./aider-hermetic.js";
import type { OpencodeHermeticHome } from "./opencode-hermetic.js";
import type { OpencodeProviderConfig } from "./opencode-provider.js";
import type { DroidProviderSettings } from "./droid-provider.js";
import type { DroidHermeticHome } from "./droid-hermetic.js";
import type { QwenEffortSettings } from "./qwen-effort.js";
import type { KimiNoToolsFile } from "./kimi-no-tools.js";
import type { KimiHermeticHome } from "./kimi-hermetic.js";
import type { GeminiHermeticHome } from "./gemini-hermetic.js";
import type { CopilotHermeticHome } from "./copilot-hermetic.js";
import type { GooseHermeticHome } from "./goose-hermetic.js";
import type { OpenhandsHermeticHome } from "./openhands-hermetic.js";
import type { OpenhandsTaskFile } from "./openhands-task-file.js";
import type { TrustedParentRecord } from "./safe-remove.js";
import type { PiProviderAgentDir } from "./pi-provider.js";

/**
 * One launch's per-run state: the scratch a run needs on disk between
 * prepareRun and processRunResult. The context is plain data the LAUNCHER
 * owns and threads through the lifecycle (buildRunCommand, getRunEnv,
 * processRunResult, cleanupRun), never a field on the adapter -- adapters
 * are singletons, so an adapter field would let one launch read or destroy
 * a concurrent launch's state. A rejected or failed launch cleans up only
 * the context it created, and two launches through the same request object
 * each carry their own.
 *
 * The optional members are one harness's per-run values each: a harness
 * that needs scratch of its own joins it here rather than growing adapter
 * state.
 */
export interface RunContext {
  /** Paths only: builders and cleanup must perform no artifact I/O. */
  printOnly?: boolean;
  /** Installed version from the compatibility probe; absent or null when unknown. */
  harnessVersion?: string | null;
  /** Agy private HOME for every sandboxed run; mode also selects native stream handling. */
  // printOnly: a --print-sandbox preparation that created no Keychain state,
  // so cleanup invokes no `security` command either.
  agyProbe?: { mode: string; home?: string; operatorHome?: string; diagnostic?: boolean; printOnly?: boolean };
  experimentBridge?: ExperimentBridge;
  experimentCodex?: ExperimentCodexRun;
  experimentKimi?: ExperimentKimiRun;
  experimentOpencode?: OpencodeExperimentRun;
  experimentGemini?: GeminiExperimentRun;
  experimentPi?: PiExperimentRun;
  /** Goose: this run's planted-config experiment host (src/goose-experiment-run.ts). */
  experimentGoose?: GooseExperimentRun;
  /** Qwen: this run's planted-config experiment host (src/qwen-experiment-run.ts). */
  experimentQwen?: QwenExperimentRun;
  /** Cline: the owned native plugin and final provider-request capture. */
  experimentCline?: ClineExperimentRun;
  /** Per-run experiment recording, independent of the harness transport. */
  experimentRecording?: string;
  /**
   * Claude/Z.AI: this run's private CLAUDE_CONFIG_DIR, when
   * --experiment-project-settings is set. Holds the generated
   * `.claude.json` (onboarding complete, the working directory trusted)
   * and, on a run that authenticates through the operator's Claude login,
   * an access-token-only credential copy. cleanupRun removes it.
   */
  claudeProjectConfigDir?: ClaudeProjectConfigDir;
  /**
   * Codex: this run's `--output-last-message` file, on every launch that can
   * have one (every `--json` launch — which is all of them — except an
   * untrusted sandbox's, which passes none). Read and removed in
   * processRunResult before either verdict runs. The plain verdict consults
   * it only for a completed messageless turn (round al29, plain-unwrap.ts's
   * CodexPlanFallbackRead); the envelope verdict reads it the same way and
   * fails a clean, completed, messageless turn whose named file is missing —
   * gated on `stream.turnCompleted` (round al30, result-envelope.ts), so a
   * truncated stream keeps its truncation verdict instead of blaming a file
   * for a turn that never finished.
   */
  lastMessagePath?: string;
  /**
   * Codex: the per-run scratch directory holding that file on a non-hermetic
   * run, created under `.codemux-scratch/` in the real CODEX_HOME in
   * prepareRun and removed in cleanupRun (a hermetic run keeps the file
   * inside its private home instead, which finalize removes; a run under an
   * untrusted sandbox has neither -- no fallback file at all).
   */
  lastMessageDir?: string;
  /**
   * Codex: the `.codemux-scratch` parent of lastMessageDir exactly as it was
   * when prepareRun made the directory, recorded for cleanupRun's
   * revalidation (src/safe-remove.ts, review round 104): the removal must
   * refuse a parent swapped for a symlink — or replaced by another
   * directory — instead of resolving the path elsewhere. Set together with
   * lastMessageDir or not at all.
   */
  lastMessageParentRecord?: TrustedParentRecord;
  /** Codex: this run's private home, on a hermetic run or the experiment
   * check's non-hermetic control (codex.ts prepareRun). */
  hermeticHome?: HermeticHome;
  /**
   * Codex: this run's private CODEX_HOME holding the provider override's
   * config.toml, when a provider override is configured on a non-hermetic
   * run. A hermetic override run carries the same config inside its private
   * hermetic home instead, which its own finalize removes; this field is
   * undefined there, so cleanupRun finalizes only what this launch created.
   */
  codexProviderHome?: CodexProviderHome;
  /**
   * Aider: this run's chat history file under `~/.aider/.codemux/`, from
   * which processRunResult extracts the reply (aider's stdout is a
   * transcript around it). Only a hermetic run creates it; plain runs keep
   * `--chat-history-file /dev/null` and write no history at all (h6
   * review), and cleanupRun removes it.
   */
  aiderHistoryFile?: AiderHistoryFile;
  /** Aider: this run's private HOME for a hermetic run, closing aider's own
   * home config layers beside the pinned flags (src/aider-hermetic.ts). */
  aiderHermeticHome?: AiderHermeticHome;
  /**
   * OpenCode: this run's private HOME for a hermetic run, redirecting the
   * XDG world while the real data directory keeps the login.
   */
  opencodeHermeticHome?: OpencodeHermeticHome;
  /**
   * OpenCode: this run's provider-override config file, when a provider
   * override is configured. Rides hermetic and plain runs alike.
   */
  opencodeProviderConfig?: OpencodeProviderConfig;
  /** OpenCode: the model this run launches with — the request's, else the
   * override's CODEMUX_OPENCODE_PROVIDER_MODEL (the adapter's own
   * selection). The --result-json envelope reports this, so an override
   * run without --model still records the model that ran (review round
   * 3, contracts-2 finding 5). */
  opencodeSelectedModel?: string;
  /** Droid: this run's private settings file, when a provider override is configured. */
  droidProviderSettings?: DroidProviderSettings;
  /** Droid: private HOME and brand home for a hermetic run. */
  droidHermeticHome?: DroidHermeticHome;
  /** Qwen: this run's system settings file, when the run asks for an effort tier. */
  qwenEffortSettings?: QwenEffortSettings;
  /** Kimi: this run's generated `tools: []` agent file, when the run asks for `--tools none`. */
  kimiNoToolsFile?: KimiNoToolsFile;
  /** Kimi: private HOME and brand home for a hermetic run. */
  kimiHermeticHome?: KimiHermeticHome;
  /** Gemini: private GEMINI_CLI_HOME for a hermetic or --tools none run. */
  geminiHermeticHome?: GeminiHermeticHome;
  /** Copilot: private COPILOT_HOME (the config directory) for a hermetic run. */
  copilotHermeticHome?: CopilotHermeticHome;
  /** Goose: private XDG root for a hermetic run. */
  gooseHermeticHome?: GooseHermeticHome;
  /** OpenHands: private HOME for a hermetic run. */
  openhandsHermeticHome?: OpenhandsHermeticHome;
  /** OpenHands: this run's task file carrying the prompt (`--file`). */
  openhandsTaskFile?: OpenhandsTaskFile;
  /** Kimi: the session wire log read before the private home is finalized. */
  kimiWireLogPath?: string;
  /** Pi: this run's private agent directory, when a provider override is
   * configured or the run is hermetic. */
  piProviderAgentDir?: PiProviderAgentDir;
  /**
   * An incremental stdout consumer the launcher feeds instead of capturing
   * stdout whole, for a harness whose stream carries more than the capture
   * bound allows (opencode's `--format json`: every tool's output rides the
   * event lines). The adapter's processRunResult reads the folded state —
   * the reply text and usage the sink kept — off the same object, so the
   * streamed and whole-capture paths cannot disagree.
   */
  stdoutSink?: StdoutSink;
  /**
   * Claude/Z.AI: this run's Playwright MCP executable check, recorded by
   * buildRunCommand when it trust-checked the binary and embedded it in
   * the `--mcp-config` JSON argument (review round 110). That path sits
   * inside one argument, so the command re-check never sees it; the
   * launcher hands this check to the spawn's re-stat instead. Null or
   * absent when the run built no Playwright arguments.
   */
  playwrightMcpCheck?: ExecutableCheck | null;
}
