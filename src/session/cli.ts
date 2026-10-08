/**
 * `codemux session` (design §4.5, §4.6): the live-session CLI. One flag
 * surface shared by every session-capable agent, the same safety seams as
 * `run` (scode default, --pass-env validation, and run's autonomy mapping
 * except the claude family's narrower high, claude-session.ts), the
 * session-only floors and refusals, and the caller-stdin framing that feeds
 * the driver. Exit codes: 0 clean; 1 crash, codemux failure, or
 * --timeout expiry (session_ended reason "timeout"); 64 usage;
 * 66 unknown --resume id; 78 policy refusal (any resume guard, including
 * an untrusted registry); 143 signal.
 */

import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getAdapter, AGENT_IDS } from "../adapters/index.js";
import type { RunContext } from "../adapters/base.js";
import { AiderAdapter } from "../adapters/aider.js";
import { OpencodeAdapter, opencodeRealDataDir } from "../adapters/opencode.js";
import { assertAbsoluteClaudeConfigDir } from "../claude-family.js";
import {
  handleUnexpectedError,
  isScodeAvailable,
  parseAutonomyOption,
  parseEffortOption,
  parsePassthroughEnvOption,
  parseSandboxPolicyOverrides,
  parseTimeoutOption,
  parseToolsOption,
  resolveAutonomyForAdapter,
  resolveEffortForAdapter,
  assertHarnessSupported,
} from "../cli-runtime.js";
import { resolveModel } from "../config.js";
import {
  codexProviderSessionsParent,
  codexSessionProviderHomePath,
  createCodexSessionProviderHome,
  openCodexSessionProviderHome,
  readCodexMultiAgent,
  type CodexSessionProviderHome,
} from "../codex-provider.js";
import {
  providerIdentityBaseUrl,
  readProviderOverride,
  requireProviderOverride,
  type ProviderOverride,
} from "../provider-override.js";
import { resolveSandboxOptionsForAgent } from "../sandbox-policy.js";
import type { AgentId, CodemuxConfig, RunRequest } from "../types.js";
import { validateWorkingDirectory } from "../validation.js";
import {
  CODEX_SESSION_FLOOR,
  CODEX_THREAD_ID_PATTERN,
  buildCodexSessionCommand,
} from "./codex-session.js";
import { CodexSessionDriver } from "./codex-driver.js";
import {
  CLAUDE_SESSION_FLOOR,
  buildClaudeSessionCommand,
} from "./claude-session.js";
import { ZAI_SESSION_FLOOR } from "./zai-session.js";
import {
  AGY_CONVERSATION_ID_PATTERN,
  AGY_SESSION_FLOOR,
  buildAgySessionCommand,
} from "./agy-session.js";
import { AgySessionDriver } from "./agy-driver.js";
import {
  AIDER_SESSION_FLOOR,
  AIDER_SESSION_ID_PATTERN,
  aiderSessionHistoryPath,
} from "./aider-session.js";
import { AiderSessionDriver } from "./aider-driver.js";
import {
  OPENCODE_SESSION_FLOOR,
  OPENCODE_SESSION_ID_PATTERN,
} from "./opencode-session.js";
import { OpenCodeSessionDriver } from "./opencode-driver.js";
import { ClaudeSessionDriver } from "./driver.js";
import { MAX_INPUT_LINE_BYTES } from "./process.js";
import type { SessionFatal, SessionProcess } from "./process.js";
import {
  claimForResume,
  discardUnconfirmedRecord,
  lookupForResume,
  probeRegistryForStart,
  releaseSessionRecord,
  registryInside,
  sessionRegistryPath,
  type ResumeLookup,
  type ResumeProbe,
} from "./registry.js";
import { spawnSessionChild } from "./spawn.js";

/** The caller-stdin surface every driver exposes; frameCallerStdin is
 * driver-agnostic by design (§4.5). `handleCallerEnd` takes the read
 * error when the stream failed rather than ended. */
interface SessionDriver {
  /** Attaches the long-lived session child. Turn-per-process agents
   * (opencode, aider) have none — they spawn per caller input through
   * their spawnTurn closure instead. */
  attach?(proc: SessionProcess): void;
  run(): Promise<number>;
  handleHarnessLine(line: string): void;
  handleFatal(fatal: SessionFatal): void;
  handleCallerLine(line: string): void;
  handleCallerEnd(error?: unknown): void;
  /** The resume claim succeeded: the driver now owns the record and
   * releases it on every end path (review live20). */
  adoptResumeClaim(): void;
  dispose(): void;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Agents whose session drivers have landed (design §7). Each later step
 * widens this set; an agent outside it gets a clear usage refusal, never
 * a silent fallback to some other harness. */
interface SessionAgentSupport {
  floor: string;
  interrupt: boolean;
  /** The id shape --resume accepts for this agent (§4.5). */
  resumePattern: RegExp;
  resumeLabel: string;
  /** Whether --tools is accepted beyond the shared refusal of "none". */
  tools: boolean;
}

const SESSION_AGENTS: Readonly<Record<string, SessionAgentSupport>> = {
  claude: {
    floor: CLAUDE_SESSION_FLOOR,
    interrupt: true,
    resumePattern: UUID_PATTERN,
    resumeLabel: "UUID",
    tools: false,
  },
  codex: {
    floor: CODEX_SESSION_FLOOR,
    interrupt: true,
    resumePattern: CODEX_THREAD_ID_PATTERN,
    resumeLabel: "codex thread id",
    // --tools is refused outright: `none` has no verified carrier on any
    // harness (the shared refusal below), and `default` names no
    // selection a session needs to carry — accepting it silently would
    // be a flag that does nothing (design §4.7, amended).
    tools: false,
  },
  zai: {
    floor: ZAI_SESSION_FLOOR,
    interrupt: true,
    // The claude-family id shape: zai pins the same --session-id UUIDs
    // (same binary); a claude-created id matches the pattern but the
    // registry's agent match refuses it (§4.8).
    resumePattern: UUID_PATTERN,
    resumeLabel: "UUID",
    // The same binary, so the same --tools refusal as claude: no
    // verified carrier restores a tool selection for a resumed
    // session (§4.5).
    tools: false,
  },
  agy: {
    floor: AGY_SESSION_FLOOR,
    // No verified interrupt channel exists on agy (§3.4): --turn-timeout
    // is refused rather than pretending a turn can be ended mid-flight.
    interrupt: false,
    // No live conversation id was ever recorded (the fixture's frame
    // carries an empty one), so the pattern accepts the registry's own
    // id class — see agy-session.ts.
    resumePattern: AGY_CONVERSATION_ID_PATTERN,
    resumeLabel: "agy conversation id",
    // No tool-removal flag exists on agy, and none is needed: there is
    // no session-carried tool selection to restore.
    tools: false,
  },
  opencode: {
    floor: OPENCODE_SESSION_FLOOR,
    // A turn in flight is a process whose stdin already sits at EOF (the
    // prompt is the whole stdin stream): no verified channel reaches into
    // it, so --turn-timeout is refused like agy's (§3.4).
    interrupt: false,
    resumePattern: OPENCODE_SESSION_ID_PATTERN,
    resumeLabel: "opencode session id",
    tools: false,
  },
  aider: {
    floor: AIDER_SESSION_FLOOR,
    // Same shape as opencode's: one process per turn, stdin at EOF the
    // moment the canned negatives land (§3.4).
    interrupt: false,
    resumePattern: AIDER_SESSION_ID_PATTERN,
    resumeLabel: "UUID",
    tools: false,
  },
};

/** Usage/validation: nothing has started (design §4.6). */
function usageError(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(64);
}

/** A flag value one of run's shared validators refuses is usage too:
 * they throw plain errors, which the outer catch exits 1 as unexpected
 * (review live25: `--pass-env ","` and an effort or autonomy level the
 * agent lacks exited 1 where the header documents 64). */
function asUsage<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
  }
}

function exitWithCode(code: number, message: string): never {
  console.error(`Error: ${message}`);
  process.exit(code);
}

/** The resume verdict's exit codes (§4.8): not found is 66; refused and
 * untrusted are 78. Untrusted is a policy refusal, not a missing entry:
 * the registry exists but codemux will not vouch from it. Its message
 * names the file, because an operator told the registry is unreadable
 * or corrupt needs the path to fix it. Unavailable (a busy lock, an I/O
 * error during the claim) judged nothing and may pass on a retry, so it
 * exits 1 like the same failure on a fresh session, never the policy
 * code a broker treats as permanent (review live22). */
function exitOnResumeRefusal(id: string, registryPath: string, lookup: ResumeLookup): void {
  if (lookup.outcome === "not_found") {
    exitWithCode(66, `no recorded session has the id ${id}`);
  }
  if (lookup.outcome === "untrusted") {
    exitWithCode(78, `cannot resume ${id}: ${lookup.reason} (registry: ${registryPath})`);
  }
  if (lookup.outcome === "refused") {
    exitWithCode(78, `cannot resume ${id}: ${lookup.reason}`);
  }
  if (lookup.outcome === "unavailable") {
    exitWithCode(1, `cannot resume ${id}: ${lookup.reason} (registry: ${registryPath})`);
  }
}

function parseOptionalTimeout(seconds: string | undefined, flag: string): number | null {
  if (seconds === undefined) return null;
  try {
    return parseTimeoutOption(seconds);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    usageError(detail.replace("--timeout", flag));
  }
}

/** The harness state home this session runs against (§4.5): the
 * pass-through redirect when one is active, else the default home.
 * `CLAUDE_CONFIG_DIR` reaches the child only via --pass-env, so the
 * redirect is honored here only when it is being passed through —
 * otherwise the child runs against the default home while the record
 * named a redirect the child never saw (an M4-class lie the resume
 * guards would then judge against). The whole claude family shares one
 * store — a zai session's transcripts live under the same `~/.claude`
 * (or `CLAUDE_CONFIG_DIR`) as a claude session's, because both run the
 * same binary against it; `~/.zai` holds only the API key. The
 * registry's agent match is what closes the shared-home replay hazard
 * (§4.8), not a separate path. */
export function claudeFamilyHarnessHome(passthroughEnv: string[]): string {
  const redirected = process.env.CLAUDE_CONFIG_DIR;
  if (passthroughEnv.includes("CLAUDE_CONFIG_DIR") && redirected !== undefined && redirected !== "") {
    return redirected;
  }
  return join(homedir(), ".claude");
}

/** The agy harness home (§4.5): agy keeps its state under
 * `~/.gemini/antigravity-cli` (conversations/, cache/ — confirmed on
 * disk against 1.2.14). No verified environment redirect exists for it,
 * so unlike the claude family and codex there is no passthrough variable
 * to honor; the recorded home is always the default one. */
function agyHarnessHome(): string {
  return join(homedir(), ".gemini", "antigravity-cli");
}

/** The opencode harness home (§4.5): the real OpenCode data directory,
 * where the native sessions and the login live (XDG_DATA_HOME honored
 * when the environment carries an absolute one, else
 * ~/.local/share/opencode — one rule shared with the adapter, so the
 * recorded home is the store a `--resume` actually reads). A provider
 * override does not move it: the override swaps the provider, not the
 * session database. */
function opencodeHarnessHome(): string {
  return opencodeRealDataDir(process.env);
}

/** The aider harness home (§4.5): ~/.aider. Aider has no environment
 * redirect for its state, and codemux keeps the per-session history
 * under this home (aider-session.ts), so the recorded home is always
 * the default one — override or not. */
function aiderHarnessHome(): string {
  return join(homedir(), ".aider");
}

/** The codex harness home (§4.5): CODEX_HOME reaches the child only via
 * --pass-env, and the recorded home must be the one the child really
 * uses — codex reads the variable without trimming, so a padded value is
 * refused rather than validated trimmed (the adapter's realCodexHome
 * rule, applied to the session boundary). */
function codexHarnessHome(passthroughEnv: string[]): string {
  const configured = process.env.CODEX_HOME;
  if (passthroughEnv.includes("CODEX_HOME") && configured !== undefined && configured !== "") {
    if (!isAbsolute(configured)) {
      usageError("CODEX_HOME must be an absolute path");
    }
    if (configured.trim() !== configured) {
      usageError(
        `CODEX_HOME must not be whitespace-padded when passed through; ` +
          `'${configured}' carries leading or trailing whitespace, and codex ` +
          "reads the variable without trimming, so the harness state would " +
          "live in a directory whose name still carries the padding"
      );
    }
    return configured;
  }
  return join(homedir(), ".codex");
}

/** The stdin-shaped surface frameCallerStdin attaches to — injectable so
 * tests can drive the framing without the process's own stdin. */
export interface FramedInput {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  once(event: "end", listener: () => void): unknown;
  once(event: "error", listener: (error: unknown) => void): unknown;
  removeListener(event: "data", listener: (chunk: Buffer) => void): unknown;
  removeListener(event: "end", listener: () => void): unknown;
  removeListener(event: "error", listener: (error: unknown) => void): unknown;
}

/** Frame the caller's stdin into lines for the driver. Blank lines are
 * framing whitespace; a line that is not valid UTF-8 is rejected as
 * malformed; a line over the input cap is rejected as malformed
 * input rather than buffered without limit — exactly once per physical
 * line, with the remainder discarded through the line's terminating
 * newline (it is part of the rejected line, not a new command).
 *
 * The buffer is a grow-on-demand array with a scan cursor, the same
 * shape as the harness-side framer (process.ts): rescanning from byte 0
 * and recopying the whole buffer on every chunk made a line near the cap
 * arriving in pipe-sized chunks quadratic (review live15, the framer
 * sibling). */
export function frameCallerStdin(
  driver: Pick<SessionDriver, "handleCallerLine" | "handleCallerEnd">,
  input: FramedInput = process.stdin
): () => void {
  let buffer = Buffer.alloc(64 * 1024);
  let length = 0;
  let searchFrom = 0;
  let discarding = false;
  const rejectOversize = (): void => {
    console.error(
      `codemux: an input line exceeded the ${MAX_INPUT_LINE_BYTES}-byte cap and was rejected`
    );
    driver.handleCallerLine("oversize");
  };
  // UTF-8 decoding is fatal-strict here too (design §4.2): a lossy decode
  // substituted U+FFFD for a bad byte, so a line carrying one was acked,
  // echoed, and forwarded with its text silently changed (review live20).
  // The line is rejected as malformed instead, like any unparseable one.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const deliverLine = (bytes: Buffer): void => {
    let line: string;
    try {
      line = decoder.decode(bytes).replace(/\r$/, "");
    } catch {
      console.error("codemux: an input line was not valid UTF-8 and was rejected");
      driver.handleCallerLine("invalid-utf8");
      return;
    }
    if (line.trim() !== "") driver.handleCallerLine(line);
  };
  const deliver = (): void => {
    while (length > 0) {
      const newline = buffer.subarray(0, length).indexOf(0x0a, searchFrom);
      if (newline === -1) break;
      // The cap applies to every complete line, not only to an
      // unterminated run: a line whose newline arrived in the same chunk
      // as the bytes that took it past the cap used to be delivered
      // (review live18).
      const oversize = newline > MAX_INPUT_LINE_BYTES;
      // A copy: the compaction below overwrites these bytes.
      const bytes = oversize ? null : Buffer.from(buffer.subarray(0, newline));
      buffer.copyWithin(0, newline + 1, length);
      length -= newline + 1;
      searchFrom = 0;
      if (bytes === null) {
        rejectOversize();
        continue;
      }
      deliverLine(bytes);
    }
    // The last scan covered [searchFrom, length) and found no newline;
    // the next chunk's scan starts where this one stopped.
    searchFrom = length;
  };
  const append = (chunk: Buffer): void => {
    if (length + chunk.length > buffer.length) {
      const grown = Buffer.alloc(Math.max(buffer.length * 2, length + chunk.length));
      buffer.copy(grown, 0, 0, length);
      buffer = grown;
    }
    buffer.set(chunk, length);
    length += chunk.length;
  };
  const onData = (chunk: Buffer): void => {
    if (discarding) {
      // Still inside the rejected oversized line: everything up to its
      // newline belongs to it, whatever it contains.
      const newline = chunk.indexOf(0x0a);
      if (newline === -1) return;
      discarding = false;
      length = 0;
      searchFrom = 0;
      append(chunk.subarray(newline + 1));
    } else {
      append(chunk);
    }
    deliver();
    if (length > MAX_INPUT_LINE_BYTES) {
      // What remains after delivery holds no newline: one unterminated
      // run past the cap. Reject the line once, then resync at its
      // newline — without the discard the remainder would re-accumulate
      // (a second rejection and input_seq for one line) or be parsed as a
      // command it never was, depending on chunk boundaries.
      length = 0;
      searchFrom = 0;
      discarding = true;
      rejectOversize();
    }
  };
  const onEnd = (): void => {
    input.removeListener("error", onError);
    if (!discarding) {
      deliver();
      const rest = Buffer.from(buffer.subarray(0, length));
      length = 0;
      if (rest.length > 0) deliverLine(rest);
    }
    driver.handleCallerEnd();
  };
  // A read error is not an end of input: the trailing partial line may be
  // a fragment, so it is not delivered, and the driver reports the error
  // as a failure instead of a clean close (review live17 — it used to run
  // the same handler as "end" and exit 0).
  const onError = (error: unknown): void => {
    input.removeListener("end", onEnd);
    length = 0;
    driver.handleCallerEnd(error ?? new Error("unknown read error"));
  };
  input.on("data", onData);
  input.once("end", onEnd);
  input.once("error", onError);
  return (): void => {
    input.removeListener("data", onData);
    input.removeListener("end", onEnd);
    input.removeListener("error", onError);
  };
}

export function registerSessionCommand(
  program: Command,
  config: CodemuxConfig,
  requireValidConfig: () => void
): void {
  program
    .command("session")
    .description("Start or resume a live agent session (JSONL events on stdout, JSONL input on stdin)")
    .option("-a, --agent <agent>", "Agent to use", config.defaultAgent)
    .option("-m, --model <model>", "Model to use (supports aliases)")
    .option("--resume <id>", "Resume a recorded session id")
    .option("--auto <level>", "Autonomy level: read-only, low, medium, high", "read-only")
    .option("--effort <level>", "Reasoning effort: none, minimal, low, medium, high, xhigh, max, ultra")
    .option("--cwd <path>", "Working directory")
    .option("--timeout <seconds>", "Absolute cap on the whole session (default: none)")
    .option("--turn-timeout <seconds>", "Per-turn cap; expiry interrupts the turn and continues, a second expiry ends the session (default: none)")
    .option("--permission-timeout <seconds>", "How long a permission request waits before codemux answers deny", "300")
    .option("--shutdown-grace <seconds>", "How long the harness gets to answer the end before SIGTERM, and again to exit before the kill", "10")
    .option("--no-author-prefix", "Do not prefix harness-bound text with [author]")
    .option("--tools <selection>", "Tool selection (refused for sessions in this release)")
    .option("--enable-playwright-mcp", "Enable the local Playwright MCP inside the sandbox (claude/zai; requires --sandbox)")
    .option("--pass-env <names>", "Pass comma-separated sensitive environment names")
    .option("--hermetic", "Refused for sessions in this release")
    .option("-s, --sandbox", "Run in sandbox (default; requires scode)", true)
    .option("--no-sandbox", "Run without the scode boundary (autonomy below high is unavailable)")
    .option("--sandbox-trust <level>", "scode trust override: trusted, standard, untrusted")
    .option("--sandbox-no-net", "Pass --no-net to scode when sandboxed")
    .option("--sandbox-scrub-env", "Pass --scrub-env to scode when sandboxed")
    .action(async (options) => {
      // Session-scoped state the CATCH below must reach: block-scoped
      // locals inside the try are invisible in its catch clause (a
      // sibling scope), so these live outside both — the codex override
      // session home, abandoned on any exit that never reached the
      // spawn (review D5, correctness 3), and whether that spawn began.
      let codexSessionHome: CodexSessionProviderHome | null = null;
      const spawnBegan = { value: false };
      try {
        requireValidConfig();
        const agentId = options.agent as AgentId;
        if (!AGENT_IDS.includes(agentId)) {
          console.error(`Error: Unknown agent '${agentId}'`);
          console.error(`Available agents: ${AGENT_IDS.join(", ")}`);
          process.exit(64);
        }
        const sessionSupport = SESSION_AGENTS[agentId];
        if (sessionSupport === undefined) {
          usageError(
            `sessions are not implemented for '${agentId}' in this release`
          );
        }

        // Provider overrides reach session spawns exactly as run spawns:
        // every session-capable harness `run` can point at a custom
        // provider, its session can too, through the same adapter seams
        // (readProviderOverride here; the adapter's env/config wiring
        // below). The adapter's own validateRunRequest — the uniform gate
        // every session agent passes through below — refuses an override
        // an agent cannot carry, zai and agy, with the run path's message
        // verbatim, so the two paths cannot drift.
        const adapter = getAdapter(agentId);
        const caps = adapter.capabilities();
        const override = readProviderOverride(agentId);

        const requestedAutonomy = parseAutonomyOption(options.auto) ?? "read-only";
        const requestedEffort = parseEffortOption(options.effort);
        const tools = parseToolsOption(options.tools);
        if (tools === "none") {
          usageError(
            "--tools none is refused for sessions: no verified carrier " +
              "restores the tools for a resumed session on any harness " +
              "(see docs/HARNESS-COMPATIBILITY.md)"
          );
        }
        if (tools !== undefined && !sessionSupport.tools) {
          usageError(
            `--tools is not implemented for '${agentId}' sessions in this release`
          );
        }
        // Run's validation verbatim (§4.5 flag matching): the carrier is
        // the sandbox-scoped --mcp-config, and only the claude family
        // has a verified one. --hermetic and --tools none are already
        // refused above, so their playwright combinations cannot occur.
        const enablePlaywrightMcp = Boolean(options.enablePlaywrightMcp);
        if (enablePlaywrightMcp && !options.sandbox) {
          usageError("--enable-playwright-mcp requires --sandbox");
        }
        if (enablePlaywrightMcp && agentId !== "claude" && agentId !== "zai") {
          usageError("--enable-playwright-mcp is supported only by claude and zai");
        }
        const passthroughEnv = asUsage(() => parsePassthroughEnvOption(options.passEnv));
        // CLAUDE_CONFIG_DIR reaches only a claude-family session's child
        // (claude and zai share the one store, claudeFamilyHarnessHome),
        // so only they validate it — the CODEX_HOME rule below, mirrored:
        // the refusals (a relative or padded value) must not end a
        // codex/agy/opencode/aider session over a variable its harness
        // never reads (review D8, correctness 2, same-class audit). The
        // run path has always been scoped this way: the check lives in
        // the claude and zai adapters' validateRunRequest, never in the
        // shared launcher.
        if (agentId === "claude" || agentId === "zai") {
          asUsage(() => assertAbsoluteClaudeConfigDir(passthroughEnv));
        }
        if (options.hermetic) {
          usageError(
            "--hermetic is refused for sessions in this release: no verified " +
              "hermetic canary covers a persistent, resumable session (see docs/HERMETIC.md)"
          );
        }
        const sandboxPolicyOverrides = asUsage(() =>
          parseSandboxPolicyOverrides({
            sandbox: Boolean(options.sandbox),
            sandboxTrust: options.sandboxTrust,
            sandboxNoNet: Boolean(options.sandboxNoNet),
            sandboxScrubEnv: Boolean(options.sandboxScrubEnv),
          })
        );
        const sandboxOptions = options.sandbox
          ? resolveSandboxOptionsForAgent(agentId, requestedAutonomy, sandboxPolicyOverrides)
          : undefined;
        const sandboxTrust = sandboxOptions?.trust ?? "standard";
        // The containment flags the registry records and the resume guard
        // compares (§4.8): only meaningful inside scode, so they are read
        // off the resolved sandbox options, not the raw argv.
        const sandboxNoNet = sandboxOptions?.noNet === true;
        const sandboxScrubEnv = sandboxOptions?.scrubEnv === true;
        if (sandboxTrust === "untrusted") {
          usageError(
            "--sandbox-trust untrusted is refused for sessions: an untrusted " +
              "sandbox denies harness state, which a persistent session must " +
              "write (transcripts, rollouts)"
          );
        }
        const sessionTimeoutMs = parseOptionalTimeout(options.timeout, "--timeout");
        const turnTimeoutMs = parseOptionalTimeout(options.turnTimeout, "--turn-timeout");
        if (turnTimeoutMs !== null && !sessionSupport.interrupt) {
          usageError("--turn-timeout requires an agent whose sessions support interrupt");
        }
        // The same funnel as --timeout/--turn-timeout above: a malformed
        // value is usage (exit 64), never an unhandled throw into the
        // outer catch's exit 1 (review live5).
        const permissionTimeoutMs =
          parseOptionalTimeout(options.permissionTimeout, "--permission-timeout") ?? 300_000;
        const shutdownGraceMs =
          parseOptionalTimeout(options.shutdownGrace, "--shutdown-grace") ?? 10_000;

        const model = options.model
          ? asUsage(() => resolveModel(options.model, agentId, config))
          : override?.model;
        if (model && !caps.supportsModel) {
          usageError(`${agentId} does not support model selection`);
        }
        const autonomy = asUsage(() => resolveAutonomyForAdapter(agentId, caps, requestedAutonomy));
        // The ceiling grants no MCP tool at medium or high, and read-only
        // allows no tool use, so every Playwright call would be denied
        // `autonomy_escalation` at those levels; only low, where the caller
        // answers each request, can use the server (review live25).
        if (enablePlaywrightMcp && autonomy !== "low") {
          usageError(
            "--enable-playwright-mcp requires --auto low for sessions: the session " +
              "ceiling grants no MCP tool at medium or high, and read-only allows no tool use"
          );
        }
        if (
          adapter.requiresSandboxForAutonomy(autonomy) &&
          !options.sandbox
        ) {
          usageError(
            `${agentId} cannot enforce '${autonomy}' autonomy without --sandbox`
          );
        }
        const effort = asUsage(() => resolveEffortForAdapter(agentId, caps, requestedEffort));
        if (agentId === "codex" && effort === "none") {
          // run carries `none` as a config override; the session's one
          // verified carrier is turn/start's `effort`, which has no audited
          // `none`, so the level was accepted and then never sent (review
          // live25). Refused rather than silently replaced by the default.
          usageError(
            "--effort none is not carried by codex sessions in this release; " +
              "omit --effort to use the model's default"
          );
        }

        const workdir = asUsage(() => validateWorkingDirectory(options.cwd)) ?? process.cwd();
        // Run's own validation gate, verbatim, for every session agent:
        // the placeholder request carries the launch values this session
        // will use, so every per-adapter rule that judges agent, model,
        // autonomy, effort, cwd, or the environment holds for sessions
        // with zero drift from `run` — the provider-override contract
        // (the model requirement, the cap refusals, zai/agy's refusal)
        // and the project-execution guards (agy, codex, aider, opencode).
        // The argv prompt bound is the one rule the placeholder cannot
        // carry: its prompt is a constant, never a turn's text, so the
        // session enforces that bound per turn at the driver instead —
        // aider's text_too_long check before the ack (review D1, 2.3).
        // The project-execution guards are the one rule the start-time
        // call alone cannot carry for the turn-per-process agents: turn N
        // may write the very config turn N+1 reloads, so spawnTurn
        // re-runs this gate before every turn it spawns (review D2,
        // security 1).
        // The plain throw is run's own failure class here too (its CLI
        // maps validateRunRequest failures to exit 1), except a
        // UsageRefusalError, which maps to 64 on both paths (review D10:
        // the aider slash-command rule refuses as usage); asUsage stays
        // for the flag validators alone (review live25). Pure validation,
        // so it runs before the environment probes below.
        const runLike: RunRequest = {
          agent: agentId,
          prompt: "codemux session",
          model,
          autonomy,
          effort,
          cwd: workdir,
          passthroughEnv,
          sandboxed: Boolean(options.sandbox),
          hermetic: false,
        };
        adapter.validateRunRequest(runLike);

        if (!adapter.isAvailable()) {
          console.error(`Error: ${agentId} is not installed`);
          console.error(`Please install '${adapter.binaryName}' and try again`);
          process.exit(1);
        }
        if (options.sandbox && !isScodeAvailable()) {
          console.error("Error: scode is not installed (required for --sandbox)");
          console.error("Install scode and ensure its executable is on PATH");
          process.exit(1);
        }

        const registryPath = sessionRegistryPath();
        // CODEX_HOME reaches only a codex session's child, so only codex
        // validates it: codexHarnessHome's refusals (a relative or padded
        // value) must not end a claude/zai/agy/opencode/aider session over
        // a variable its harness never reads (review D8, correctness 2).
        // Computed at the first codex arm below, at most once.
        let realCodexHome: string | null = null;
        const codexHome = (): string =>
          (realCodexHome ??= codexHarnessHome(passthroughEnv));
        // The validated override a codex session's provider home is built
        // from — requireProviderOverride is the adapters' own gate, the
        // same refusal validateRunRequest already ran above. The home's
        // path is needed before anything spawns because it feeds the
        // resume guards: an override session resumes only under the same
        // endpoint AND session id's home (§4.8).
        const codexOverride =
          agentId === "codex" && override !== null
            ? requireProviderOverride("codex", override, [
                "baseUrl",
                "apiKey",
              ]) as ProviderOverride & { baseUrl: string; apiKey: string }
            : null;
        // Resume: the id must match the agent's session id shape (the
        // registry check follows); extracted here because a codex override
        // resume's harness home is keyed by it.
        let resumeId: string | undefined;
        if (options.resume !== undefined) {
          if (!sessionSupport.resumePattern.test(options.resume)) {
            usageError(
              `--resume expects a ${sessionSupport.resumeLabel} session id; '${options.resume}' is not one`
            );
          }
          resumeId = options.resume;
        }
        // The harness state home (§4.8). A codex override session's home
        // is keyed per session id (review D1, security: no directory is
        // shared across sessions — a naming rule, not an access
        // boundary; the shared parent stays child-writable, review D5,
        // security, stated in full at codexSessionProviderHomePath). A
        // resume computes its key from the id the registry recorded; a
        // fresh session learns its id only at thread/start, long after
        // the spawn env needs a home, so its start-time harness_home is
        // the `.codemux-provider` parent every final path sits under —
        // a conservative containment cover, while the record itself
        // gets the true keyed path (harnessHomeFor) once the id exists.
        const harnessHome =
          agentId === "codex"
            ? codexOverride !== null
              ? resumeId !== undefined
                ? codexSessionProviderHomePath(codexHome(), codexOverride.baseUrl, resumeId)
                : codexProviderSessionsParent(codexHome())
              : codexHome()
            : agentId === "agy"
              ? agyHarnessHome()
              : agentId === "opencode"
                ? opencodeHarnessHome()
                : agentId === "aider"
                  ? aiderHarnessHome()
                  : claudeFamilyHarnessHome(passthroughEnv);
        // The provider identity every record carries and the resume guard
        // pins (review D3, security): the override's base URL, or null for
        // the operator's own login — recorded and compared in the
        // IDENTITY form (query and fragment stripped, review D10,
        // security: a gateway key can ride the query, and the value goes
        // to disk and into refusal messages). validateRunRequest above
        // refused every half-configured override the four override-capable
        // session agents accept (zai and agy refuse overrides outright),
        // so a non-null override here always carries its base URL.
        const providerBaseUrl =
          override?.baseUrl !== undefined
            ? providerIdentityBaseUrl(override.baseUrl)
            : null;
        const resumeProbe: ResumeProbe = {
          agent: agentId,
          harnessHome,
          autonomy,
          sandboxed: Boolean(options.sandbox),
          sandboxTrust,
          sandboxNoNet,
          sandboxScrubEnv,
          cwd: workdir,
          passEnv: passthroughEnv,
          playwrightMcp: enablePlaywrightMcp,
          providerBaseUrl,
          hermetic: false,
        };
        if (resumeId !== undefined) {
          exitOnResumeRefusal(
            resumeId,
            registryPath,
            lookupForResume(registryPath, resumeId, resumeProbe)
          );
        }

        // Design §4.8 rule 2, the start-time half: the registry the
        // resume guards rest on must not sit inside a directory the
        // child can write — the cwd and the harness home are the
        // writable set codemux can compute for a session (sessions
        // expose no --add-dir). On the default paths this refuses every
        // `--cwd ~` session. A resume is judged first: the registry's
        // own containment guard (rule 3) refuses it 78 like every other
        // resume guard, and this 64 is the fresh session's refusal
        // (review live23: it ran first and made rule 3 unreachable).
        if (registryInside(registryPath, workdir) || registryInside(registryPath, harnessHome)) {
          usageError(
            `the session registry (${registryPath}) sits inside the working ` +
              "directory or harness home, where the harness could rewrite it; " +
              "choose a --cwd outside the registry's path"
          );
        }

        // The claude-family identity for this session: zai rides the same
        // driver, parser, and argv, differing only in the registry and
        // session_started agent the driver records.
        const claudeFamilyAgent: "claude" | "zai" =
          agentId === "zai" ? "zai" : "claude";
        const claudeBuilt = agentId === "claude" || agentId === "zai"
          ? buildClaudeSessionCommand({
              agent: claudeFamilyAgent,
              resumeId,
              model,
              autonomy,
              effort,
              cwd: workdir,
              // Run parity for --enable-playwright-mcp (§4.5): the same
              // sandbox-scoped carrier, in run's argv position.
              sandboxed: Boolean(options.sandbox),
              enablePlaywrightMcp,
            })
          : null;
        // Turn-per-process agents (opencode, aider) have no session-long
        // child: their driver spawns one process per caller input, so
        // there is no argv to build here.
        const turnPerProcess = agentId === "opencode" || agentId === "aider";

        // The session floor, above the run contract (§4.3): the resume
        // ladder's reasoning and the permission carrier are only audited
        // down to this build.
        await assertHarnessSupported(
          agentId,
          adapter.binaryName,
          options.cwd,
          undefined,
          autonomy,
          Boolean(options.sandbox),
          passthroughEnv,
          sessionSupport.floor
        );

        adapter.beforeLaunch();
        if (options.sandbox) {
          adapter.prepareSandbox({ sandboxTrust, passthroughEnv });
        }
        // A codex override session's CODEX_HOME (review D1): created only
        // after every refusing step, and its config.toml written only
        // after the resume claim (prepareConfig, inside the spawn block
        // below — review D5, correctness 3), so a session that never
        // spawns writes nothing. FRESH runs in one
        // `run-<pid>-<random>` directory (the run-path shape, so a
        // codemux that dies mid-session leaves it to the same stale
        // sweep) moved onto its session-keyed path at an orderly
        // resumable end; RESUMED opens the recorded key, its config.toml
        // rewritten atomically (the earlier session's child could write
        // that directory) — and a key that is missing or untrusted is
        // refused outright, never silently remade as an empty home
        // (review D2, correctness-2 2). One home holds one session's
        // threads and config — nothing is shared across sessions. The
        // driver settles it at the end path (a settlement that cannot
        // reach the key drops the resumable verdict; a resumed home is
        // never removed there, review D3 — its state predates this
        // process); a spawn that throws abandons it below.
        codexSessionHome =
          agentId === "codex" && codexOverride !== null
            ? resumeId !== undefined
              ? openCodexSessionProviderHome(
                  codexHome(),
                  codexOverride,
                  // validateRunRequest refused an override without a model
                  // (codex's own modelFor), so the config always carries
                  // one.
                  model as string,
                  readCodexMultiAgent(),
                  resumeId
                )
              : createCodexSessionProviderHome(
                  codexHome(),
                  codexOverride,
                  model as string,
                  readCodexMultiAgent()
                )
            : null;
        const argv =
          claudeBuilt !== null
            ? claudeBuilt.argv
            : agentId === "codex"
              ? buildCodexSessionCommand(
                  // The override launch: CODEX_HOME pointed at the
                  // session's provider home — the live run-shaped one for
                  // a fresh session, the session-keyed one for a resume —
                  // through the same env(1) shape the run path spawns with.
                  codexSessionHome !== null
                    ? [`CODEX_HOME=${codexSessionHome.codexHome}`]
                    : undefined
                )
              : agentId === "agy"
                ? buildAgySessionCommand({
                    resumeConversationId: resumeId,
                    model,
                    autonomy,
                    effort,
                  })
                : null;
        // The run context, exactly as run's launch path builds one
        // (launch.ts). Codex under an override carries the SESSION's
        // provider home: a getRunEnv shape requirement (the adapter
        // refuses an override launch whose home was not prepared) and the
        // seam that keeps the key off argv. Its finalize is a no-op by
        // design: the home is per-SESSION state, settled by the driver at
        // the end path (kept on a resumable end; a fresh one removed
        // otherwise, a resumed one never — review D3), so no run-scoped
        // cleanup may own its lifetime.
        const runContext: RunContext | undefined =
          codexSessionHome !== null
            ? {
                codexProviderHome: {
                  codexHome: codexSessionHome.codexHome,
                  finalize: () => {},
                },
              }
            : undefined;
        // The long-lived children spawn below, so their env is assembled
        // now; the turn-per-process agents assemble each turn's env at its
        // own turn (spawnTurn), after every startup refusal — a session
        // that never starts writes nothing, opencode's provider config in
        // particular.
        const env = turnPerProcess
          ? null
          : adapter.buildExecutionEnv(adapter.getRunEnv(runLike, runContext), passthroughEnv);

        // The wire models for the turn-per-process agents, through the
        // adapters' public seam (wireModelFor): exactly what
        // buildRunCommand would pass — openai/-prefixed for aider,
        // codemux/-prefixed for opencode under an override — so session
        // turns and runs cannot drift.
        const opencodeWireModel =
          agentId === "opencode" && adapter instanceof OpencodeAdapter
            ? adapter.wireModelFor(model)
            : undefined;
        const aiderWireModel =
          agentId === "aider" && adapter instanceof AiderAdapter
            ? adapter.wireModelFor(model)
            : undefined;

        let driver: SessionDriver;
        let claudeDriver: ClaudeSessionDriver | null = null;
        let aiderDriver: AiderSessionDriver | null = null;
        let aiderSessionId: string | null = null;
        // Holder (not a bare let): the assignment happens inside the
        // spawnTurn closure, which TypeScript's flow analysis cannot see
        // at the cleanup site below.
        const turnState: {
          launch: {
            env: Record<string, string>;
            context: RunContext | undefined;
          } | null;
        } = { launch: null };
        const spawnTurn = (turnArgv: string[]): Promise<SessionProcess> => {
          // Re-run the adapter's validation gate before EVERY turn
          // (review D2, security 1): the turn-per-process agents (opencode,
          // aider) reload project config in each fresh process, and turn N
          // may have written `opencode.json` or `.aider.model.settings.yml`
          // granting reach the recorded autonomy does not. `run` checks the
          // tree right before the only process it launches; this is that
          // same moment per turn. Pure validation, so the throw reaches the
          // drivers' existing spawn-failure path: a fatal codemux error
          // carrying the guard's message, and the session ends rather than
          // spawn a process the tree would have refused.
          adapter.validateRunRequest(runLike);
          if (agentId === "opencode") {
            // A FRESH provider config before every turn (review D3,
            // security 2): the config file lives in the opencode data
            // directory, which the sandboxed child can write, and each
            // turn is a new process that reloads it through
            // OPENCODE_CONFIG — a config cached at the first turn let
            // turn N's child rewrite what turn N+1 ran with (permissions,
            // MCP servers). The run path never shares the file across
            // processes, and neither does a session now: one file per
            // turn process, each in its own fresh unguessable directory.
            // Turns serialize (a second input is refused while one runs),
            // so the previous turn's process has exited by the time a
            // next turn spawns: its context is finalized right here,
            // which also keeps exactly one exit listener registered; the
            // live one dies with the session below. If prepareRun throws,
            // the finally below cleans the previous context again —
            // cleanupRun is idempotent — and nothing leaks.
            const previous = turnState.launch?.context;
            if (previous !== undefined) adapter.cleanupRun(previous);
            const context = adapter.prepareRun(runLike);
            turnState.launch = {
              env: adapter.buildExecutionEnv(
                adapter.getRunEnv(runLike, context),
                passthroughEnv
              ),
              context,
            };
          } else if (turnState.launch === null) {
            // Run's launch order in miniature (launch.ts): prepareRun,
            // then getRunEnv, then the built environment. Aider's override
            // rides environment variables alone (OPENAI_API_BASE /
            // OPENAI_API_KEY) — nothing on disk to refresh — so its env is
            // built once and cached.
            turnState.launch = {
              env: adapter.buildExecutionEnv(
                adapter.getRunEnv(runLike, undefined),
                passthroughEnv
              ),
              context: undefined,
            };
          }
          return spawnSessionChild(turnArgv, turnState.launch.env, {
            cwd: workdir,
            sandboxed: Boolean(options.sandbox),
            autonomy: requestedAutonomy,
            sandboxOptions,
            graceMs: shutdownGraceMs,
            envOmissions: adapter.getEnvOmissions(),
          }, {
            onLine: (line) => driver.handleHarnessLine(line),
            onFatal: (fatal) => driver.handleFatal(fatal),
          });
        };
        if (agentId === "codex") {
          driver = new CodexSessionDriver({
            resumeThreadId: resumeId ?? null,
            autonomy,
            model,
            // Under an override the session home's config.toml owns model
            // selection (the run path's never-`-m` rule), so thread/start
            // and thread/resume carry none; `model` stays the reported
            // one.
            wireModel: codexOverride !== null ? null : undefined,
            effort,
            cwd: workdir,
            sandboxed: Boolean(options.sandbox),
            sandboxTrust,
            sandboxNoNet,
            sandboxScrubEnv,
            passEnv: passthroughEnv,
            authorPrefix: Boolean(options.authorPrefix),
            permissionTimeoutMs,
            turnTimeoutMs,
            sessionTimeoutMs,
            registryPath,
            harnessHome,
            providerBaseUrl,
            // The override session's recorded home names the thread id —
            // the session-keyed path a resume computes — which the
            // harness only mints at thread/start, after the spawn.
            harnessHomeFor:
              codexOverride !== null
                ? (id) =>
                    codexSessionProviderHomePath(codexHome(), codexOverride.baseUrl, id)
                : undefined,
            // The home's end-of-session settlement: keep on a resumable
            // end (renamed onto the key when it started run-shaped);
            // remove otherwise — except a resumed home, which settlement
            // never removes (review D3).
            settleSessionHome: codexSessionHome?.settle,
          });
        } else if (agentId === "agy") {
          driver = new AgySessionDriver({
            resumeConversationId: resumeId ?? null,
            autonomy,
            model,
            cwd: workdir,
            sandboxed: Boolean(options.sandbox),
            sandboxTrust,
            sandboxNoNet,
            sandboxScrubEnv,
            passEnv: passthroughEnv,
            authorPrefix: Boolean(options.authorPrefix),
            sessionTimeoutMs,
            registryPath,
            harnessHome,
            providerBaseUrl,
          });
        } else if (agentId === "opencode") {
          driver = new OpenCodeSessionDriver({
            resumeSessionId: resumeId ?? null,
            autonomy,
            model: opencodeWireModel,
            effort,
            cwd: workdir,
            hermetic: false,
            sandboxed: Boolean(options.sandbox),
            sandboxTrust,
            sandboxNoNet,
            sandboxScrubEnv,
            passEnv: passthroughEnv,
            authorPrefix: Boolean(options.authorPrefix),
            sessionTimeoutMs,
            registryPath,
            harnessHome,
            providerBaseUrl,
            spawnTurn,
          });
        } else if (agentId === "aider") {
          // Codemux owns the identity: aider has no session id of its own,
          // so one is minted here and the per-session history directory is
          // keyed by it (aider-session.ts).
          aiderSessionId = resumeId ?? randomUUID();
          driver = aiderDriver = new AiderSessionDriver({
            sessionId: aiderSessionId,
            resume: resumeId !== undefined,
            autonomy,
            model: aiderWireModel,
            // Under an override the weak model rides the same endpoint
            // (aider's ChatSummary runs through it); without one aider
            // picks its own default, exactly as the run path leaves it.
            weakModel: override !== null ? aiderWireModel : undefined,
            effort,
            historyPath: aiderSessionHistoryPath(harnessHome, aiderSessionId),
            cwd: workdir,
            hermetic: false,
            sandboxed: Boolean(options.sandbox),
            sandboxTrust,
            sandboxNoNet,
            sandboxScrubEnv,
            passEnv: passthroughEnv,
            authorPrefix: Boolean(options.authorPrefix),
            sessionTimeoutMs,
            registryPath,
            harnessHome,
            providerBaseUrl,
            spawnTurn,
          });
        } else if (claudeBuilt !== null) {
          driver = claudeDriver = new ClaudeSessionDriver({
            agent: claudeFamilyAgent,
            sessionId: resumeId ?? claudeBuilt.sessionId,
            autonomy,
            model,
            cwd: workdir,
            sandboxed: Boolean(options.sandbox),
            sandboxTrust,
            sandboxNoNet,
            sandboxScrubEnv,
            passEnv: passthroughEnv,
            playwrightMcp: enablePlaywrightMcp,
            authorPrefix: Boolean(options.authorPrefix),
            permissionTimeoutMs,
            turnTimeoutMs,
            sessionTimeoutMs,
            registryPath,
            harnessHome,
            providerBaseUrl,
          });
        } else {
          // Unreachable: every agent either built a claude-family
          // command above or matched a branch already.
          throw new Error(`no session driver for '${agentId}'`);
        }
        // The record this process owns before the spawn, released here if
        // the spawn throws: a resume's claim or a fresh claude-family
        // start record.
        let ownedRecordId: string | null = null;
        let ownedRecordFresh = false;
        if (resumeId !== undefined) {
          // The ownership claim, under the writer lock and before the
          // spawn (review live19): the lookup above read without the
          // lock, and a concurrent resume of the same id must be refused
          // before its harness can act on any caller input.
          const claimed = claimForResume(registryPath, resumeId, resumeProbe);
          if (claimed.outcome !== "ok") {
            // The refusal exits below and must not strand this
            // process's session home on the way out (review D5,
            // correctness 3): a codex override resume's home is the
            // resumed one, whose abandon is the designed no-op — its
            // state predates this process (review D3) — so the call is
            // what keeps the path honest should that ever change.
            codexSessionHome?.abandon();
          }
          exitOnResumeRefusal(resumeId, registryPath, claimed);
          driver.adoptResumeClaim();
          ownedRecordId = resumeId;
        } else if (agentId === "agy" || agentId === "opencode") {
          // agy and opencode name a fresh conversation only in their
          // first turn's output, so that turn runs before the record can
          // exist; the registry is proven writable first (review live22).
          const probe = probeRegistryForStart(registryPath);
          if (!probe.ok) {
            exitWithCode(1, `cannot record the session in the registry: ${probe.error} (registry: ${registryPath})`);
          }
        }
        if (claudeDriver !== null && claudeBuilt !== null) {
          // A claude-family session is recorded before the spawn, fresh
          // or resumed (review live22): its init frame follows the
          // caller's first input, so recording there let that turn run
          // untracked when the write failed (§4.8: an untracked live
          // session must not run). codemux chose the id, or the claim
          // above vouched for it, so nothing waits on the harness.
          const failure = claudeDriver.recordBeforeSpawn();
          if (failure !== null) {
            if (ownedRecordId !== null) releaseSessionRecord(registryPath, ownedRecordId);
            exitWithCode(1, `cannot record the session in the registry: ${failure} (registry: ${registryPath})`);
          }
          if (ownedRecordId === null) {
            ownedRecordId = claudeBuilt.sessionId;
            ownedRecordFresh = true;
          }
        }
        if (aiderDriver !== null && aiderSessionId !== null) {
          // The same pre-spawn record for the other codemux-owned
          // identity: the fresh session's history file and the start
          // record are in place before anything spawns; a resume rewrites
          // only the record, never the history.
          const failure = aiderDriver.recordBeforeSpawn();
          if (failure !== null) {
            if (ownedRecordId !== null) releaseSessionRecord(registryPath, ownedRecordId);
            // A fresh session's history directory was just created ahead
            // of this record; with the record failed, nothing points at
            // it, so remove it now rather than orphan it to the 28-day
            // sweep (review D2, correctness-2 3). No-op on a resume.
            aiderDriver.removeFreshHistory();
            exitWithCode(1, `cannot record the session in the registry: ${failure} (registry: ${registryPath})`);
          }
          if (ownedRecordId === null) {
            ownedRecordId = aiderSessionId;
            ownedRecordFresh = true;
          }
        }
        let proc: SessionProcess | null = null;
        if (argv !== null && env !== null) {
          spawnBegan.value = true;
          try {
            // The session home's config.toml, written only now — after
            // the claim, before anything spawns (review D5, correctness
            // 3): a racing second resume refused `session_busy` above
            // never rewrote the live session's config. A throw here
            // takes the catch's abandon-and-release path like any spawn
            // failure.
            codexSessionHome?.prepareConfig();
            proc = await spawnSessionChild(argv, env, {
              cwd: workdir,
              sandboxed: Boolean(options.sandbox),
              autonomy: requestedAutonomy,
              sandboxOptions,
              graceMs: shutdownGraceMs,
              envOmissions: adapter.getEnvOmissions(),
            }, {
              onLine: (line) => driver.handleHarnessLine(line),
              onFatal: (fatal) => driver.handleFatal(fatal),
            });
          } catch (error) {
            // No driver end path runs for a spawn that threw, so the claim
            // is released here; otherwise it stays open under this pid
            // until the process dies (review live20). A lost release is
            // reported like the drivers' (review live21). A codex override
            // session's home is abandoned the same way: a fresh one's bare
            // home is removed, a resumed one's is left to the sweep — its
            // state predates this process (review D1).
            codexSessionHome?.abandon();
            if (ownedRecordId !== null) {
              if (ownedRecordFresh) discardUnconfirmedRecord(registryPath, ownedRecordId);
              else releaseSessionRecord(registryPath, ownedRecordId);
            }
            throw error;
          }
          driver.attach?.(proc);
        }
        const unframe = frameCallerStdin(driver);
        let code: number;
        try {
          code = await driver.run();
        } finally {
          // What the latest turn's env assembly left live (opencode's
          // current provider config; earlier turns' were finalized at the
          // next turn's spawn) dies with the session. The codex session
          // home never rode turnState: the driver's end path settled it
          // (kept on a resumable end; a fresh one removed otherwise, a
          // resumed one never — review D3) before run() resolved.
          adapter.cleanupRun(turnState.launch?.context);
        }
        unframe();
        driver.dispose();
        process.stdin.destroy();
        process.exitCode = code;
      } catch (error) {
        // An unexpected exit that never reached the spawn must not
        // strand a fresh codex override home either (review D5,
        // correctness 3) — abandoned here, not orphaned to the
        // stale-run sweep. Once the spawn began, the home's lifetime
        // belongs to the inner catch and the driver's end path: a
        // settled home's abandon is a no-op, and a live child's
        // CODEX_HOME is never deleted under it from here.
        if (!spawnBegan.value) codexSessionHome?.abandon();
        handleUnexpectedError(error);
      }
    });
}
