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
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getAdapter, AGENT_IDS } from "../adapters/index.js";
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
  assertNoAgyProjectExecutionConfig,
  assertNoCodexProjectExecutionConfig,
} from "../project-safety.js";
import { resolveSandboxOptionsForAgent } from "../sandbox-policy.js";
import type { AgentId, CodemuxConfig } from "../types.js";
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
  attach(proc: SessionProcess): void;
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

        // Provider overrides do not reach sessions in this release (review
        // live25): the session spawn skips the adapter's override wiring,
        // so a codex override ran against the operator's own ~/.codex
        // account with the provider key left in the child's environment,
        // and agents whose `run` refuses an override launched anyway. Any
        // set name under the agent's prefix refuses before anything else
        // is read: the override, a cap, and codex's MULTI_AGENT knob alike.
        // Blank counts as unset, the override module's own rule.
        const overridePrefix = `CODEMUX_${agentId.toUpperCase()}_PROVIDER_`;
        const overrideNames = Object.keys(process.env)
          .filter((name) => name.startsWith(overridePrefix) && (process.env[name]?.trim() ?? "") !== "")
          .sort();
        if (overrideNames.length > 0) {
          usageError(
            `provider overrides are refused for sessions in this release; ` +
              `unset ${overrideNames.join(", ")} to start a ${agentId} session ` +
              "(overrides reach sessions in the next release)"
          );
        }

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
        asUsage(() => assertAbsoluteClaudeConfigDir(passthroughEnv));
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

        const adapter = getAdapter(agentId);
        const caps = adapter.capabilities();
        const model = options.model
          ? asUsage(() => resolveModel(options.model, agentId, config))
          : undefined;
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

        const workdir = asUsage(() => validateWorkingDirectory(options.cwd)) ?? process.cwd();
        if (agentId === "agy") {
          // The same project-execution guard the run path applies: an
          // agy executable config in the tree changes what the harness
          // runs, sessions no less than runs.
          assertNoAgyProjectExecutionConfig(workdir);
        }
        if (agentId === "codex") {
          // The same guard run's validateRunRequest applies: a repository
          // `.codex/config.toml` or `.codex/rules/` decides MCP servers,
          // providers, and model wiring for an app-server spawned in
          // that directory — sessions no less than runs.
          assertNoCodexProjectExecutionConfig(workdir);
        }
        const registryPath = sessionRegistryPath();
        const harnessHome =
          agentId === "codex"
            ? codexHarnessHome(passthroughEnv)
            : agentId === "agy"
              ? agyHarnessHome()
              : claudeFamilyHarnessHome(passthroughEnv);
        // Resume: the id must match the agent's session id shape and the
        // registry must vouch for it, with every §4.8 guard passing
        // before anything spawns.
        let resumeId: string | undefined;
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
          hermetic: false,
        };
        if (options.resume !== undefined) {
          if (!sessionSupport.resumePattern.test(options.resume)) {
            usageError(
              `--resume expects a ${sessionSupport.resumeLabel} session id; '${options.resume}' is not one`
            );
          }
          exitOnResumeRefusal(
            options.resume,
            registryPath,
            lookupForResume(registryPath, options.resume, resumeProbe)
          );
          resumeId = options.resume;
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
        const argv =
          claudeBuilt !== null
            ? claudeBuilt.argv
            : agentId === "codex"
              ? buildCodexSessionCommand()
              : buildAgySessionCommand({
                  resumeConversationId: resumeId,
                  model,
                  autonomy,
                  effort,
                });

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
        const env = adapter.buildExecutionEnv(adapter.getEnv(), passthroughEnv);

        let driver: SessionDriver;
        let claudeDriver: ClaudeSessionDriver | null = null;
        if (agentId === "codex") {
          driver = new CodexSessionDriver({
            resumeThreadId: resumeId ?? null,
            autonomy,
            model,
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
          exitOnResumeRefusal(
            resumeId,
            registryPath,
            claimForResume(registryPath, resumeId, resumeProbe)
          );
          driver.adoptResumeClaim();
          ownedRecordId = resumeId;
        } else if (agentId === "agy") {
          // agy names a fresh conversation only in its first result, so
          // that turn runs before the record can exist; the registry is
          // proven writable first (review live22).
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
        let proc: SessionProcess;
        try {
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
          // reported like the drivers' (review live21).
          if (ownedRecordId !== null) {
            if (ownedRecordFresh) discardUnconfirmedRecord(registryPath, ownedRecordId);
            else releaseSessionRecord(registryPath, ownedRecordId);
          }
          throw error;
        }
        driver.attach(proc);
        const unframe = frameCallerStdin(driver);
        const code = await driver.run();
        unframe();
        driver.dispose();
        process.stdin.destroy();
        process.exitCode = code;
      } catch (error) {
        handleUnexpectedError(error);
      }
    });
}
