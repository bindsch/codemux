import type { HermeticHome } from "./hermetic-home.js";
import type { StdoutSink } from "./process-runner.js";
import type { ExperimentBridge } from "./experiment-bridge.js";
import type { CodexProviderHome } from "./codex-provider.js";
import type { AiderHistoryFile } from "./aider-history.js";
import type { OpencodeHermeticHome } from "./opencode-hermetic.js";
import type { OpencodeProviderConfig } from "./opencode-provider.js";
import type { DroidProviderSettings } from "./droid-provider.js";
import type { KimiNoToolsFile } from "./kimi-no-tools.js";
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
  /** Agy private HOME for every sandboxed run; mode also selects native stream handling. */
  agyProbe?: { mode: string; home?: string; operatorHome?: string; diagnostic?: boolean };
  experimentBridge?: ExperimentBridge;
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
   * have no switch; src/aider-history.ts, docs/HERMETIC.md), so nothing
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
  /** Droid: this run's private settings file, when a provider override is configured. */
  droidProviderSettings?: DroidProviderSettings;
  /** Kimi: this run's generated `tools: []` agent file, when the run asks for `--tools none`. */
  kimiNoToolsFile?: KimiNoToolsFile;
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
