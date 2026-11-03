import type { HermeticHome } from "./hermetic-home.js";
import type { StdoutSink } from "./process-runner.js";
import type { ExperimentBridge } from "./experiment-bridge.js";
import type { ExperimentCodexRun } from "./experiment-codex-run.js";
import type { ExperimentKimiRun } from "./experiment-kimi-run.js";
import type { ClaudeProjectConfigDir } from "./claude-project-config.js";
import type { CodexProviderHome } from "./codex-provider.js";
import type { AiderHistoryFile } from "./aider-history.js";
import type { OpencodeHermeticHome } from "./opencode-hermetic.js";
import type { OpencodeProviderConfig } from "./opencode-provider.js";
import type { DroidProviderSettings } from "./droid-provider.js";
import type { KimiNoToolsFile } from "./kimi-no-tools.js";
import type { KimiHermeticHome } from "./kimi-hermetic.js";
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
  /** Installed version from the compatibility probe; absent or null when unknown. */
  harnessVersion?: string | null;
  /** Agy private HOME for every sandboxed run; mode also selects native stream handling. */
  // printOnly: a --print-sandbox preparation that created no Keychain state,
  // so cleanup invokes no `security` command either.
  agyProbe?: { mode: string; home?: string; operatorHome?: string; diagnostic?: boolean; printOnly?: boolean };
  experimentBridge?: ExperimentBridge;
  experimentCodex?: ExperimentCodexRun;
  experimentKimi?: ExperimentKimiRun;
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
  /** Codex: this run's private hermetic home, when the run is hermetic. */
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
   * review), and cleanupRun removes it. The hermetic check that would
   * consume the extraction is refused for now (aider's own config layers
   * have no switch; src/aider-history.ts, docs/isolation.md), so nothing
   * reads it today.
   */
  aiderHistoryFile?: AiderHistoryFile;
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
  /** Kimi: this run's generated `tools: []` agent file, when the run asks for `--tools none`. */
  kimiNoToolsFile?: KimiNoToolsFile;
  /** Kimi: private HOME and brand home for a hermetic run. */
  kimiHermeticHome?: KimiHermeticHome;
  /** Kimi: the session wire log read before the private home is finalized. */
  kimiWireLogPath?: string;
  /** Pi: this run's private agent directory, when a provider override is configured. */
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
}
