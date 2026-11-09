import { BaseAdapter, type RunContext } from "./base.js";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgyProbeMode } from "../agy-isolation-probe.js";
import { summarizeAgyStream } from "../agy-stream.js";
import { agyPrivateHomeEnvPrefix, sweepStaleHomes } from "./agy-homes.js";
import { createAgyProbeHome, ownedProbeHomes, PROBE_TOKEN, removeAgyProbeHome } from "./agy-probe-home.js";
import { agyKeychainHost, agyProbeRoots, insertAgyKeychainItem, prepareAgyPrivateKeychain, recoverAgyKeychainSearchList, verifyAgyKeychainSearchList } from "../agy-keychain.js";
import { assertNoAgyProjectExecutionConfig } from "../project-safety.js";
import { AGY_DENIED_ACTIONS, headlessMediumSettings, readAgyTokenForCopy } from "./agy-settings.js";
import { plantAgyPlaywrightMcpConfig } from "../agy-playwright-mcp.js";
import { refuseAgyExperiment } from "../agy-experiment-run.js";
import { UsageRefusalError, validateWorkingDirectory } from "../validation.js";
import { agyResult } from "../result-envelope.js";
import { agyPlainResult } from "../plain-unwrap.js";
import { withKeepEnvExemption, type SandboxOptions, type ScodeTrustLevel } from "../sandbox.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  RunResult,
  AdapterCapabilities,
 LaunchIntent } from "../types.js";
import { agyLoginState, loginHome, type LoginState } from "../harness-health.js";

const isolationProbes = new WeakMap<RunRequest, { mode: AgyProbeMode; operatorHome?: string }>();

/** Internal entry for check's isolation diagnostics only. */
export function markAgyIsolationProbe(request: RunRequest, mode: AgyProbeMode, operatorHome?: string): void {
  if (request.agent !== "agy" || !request.sandboxed || request.autonomy !== "read-only" ||
      request.hermetic || request.tools === "none" || request.experimentMcp) {
    throw new Error("agy isolation probes require a plain read-only scode request");
  }
  // Diagnostics write beside --cwd (round 341); without one they crash there.
  if (!request.cwd) throw new UsageRefusalError("agy isolation probes require an explicit --cwd for their diagnostics");
  isolationProbes.set(request, { mode, operatorHome });
}

/**
 * Google Antigravity CLI (`agy`), pinned against 1.2.14 -- the binary
 * installed while this adapter was written -- and the official docs
 * (https://antigravity.google/docs/cli/overview,
 * https://antigravity.google/docs/cli/headless).
 *
 * Flag forms are load-bearing here: agy pre-parses its enum flags
 * (`--effort`, `--mode`, `--input-format`, `--output-format`) and rejects
 * the space form outright (`--effort high` exits 2 with "flags provided
 * but not defined: -effort high"), so the adapter always emits
 * `--flag=value` for those. `--model` rides in the same single-token
 * form: the `=`-form is the one the live captures ran.
 *
 * The prompt rides stdin, never argv: print mode's stream-json input
 * reads one NDJSON message per line — `{"event":"user","message":{
 * "content":"<prompt>"}}` — and requires stream-json output (official
 * headless docs and the binary strings "stream input \"user\" message is
 * missing the \"message\" field" / "--input-format %s requires
 * --output-format %s", agy 1.5.3, read 2026-11-09). Closing stdin after
 * the one line ends the session after that turn, exit 0: one frame in,
 * one result event out, and no prompt is ever bounded by argv.
 *
 * An unrecognized `--mode` value only warns and continues with the
 * default mode, so this adapter must never emit a value outside
 * {plan, accept-edits} -- a typo would silently change autonomy rather
 * than fail the launch.
 *
 * A fourth mode, `--mode auto`, exists at 1.5.3 and is gated on a
 * terminal sandbox this host does not provide (binary strings, read
 * 2026-11-08); it is a carrier for no codemux level. Headless low is
 * that default mode itself: print mode soft-denies every tool
 * confirmation it cannot show and still exits 0, so the level needs no
 * flag.
 */
export class AgyAdapter extends BaseAdapter {
  // The environment the adapter sees is the one its factory was handed:
  // `verify` passes only PATH so an exported override cannot
  // change its rows, and a run passes the real one.
  constructor(environment: NodeJS.ProcessEnv = process.env) {
    super(environment);
  }
  readonly id: AgentId = "agy";
  readonly binaryName = "agy";

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      // 1.2.14's help lists low|medium|high|xhigh|max; the docs table names
      // only low/medium/high. The binary is the contract, so all five are
      // accepted and the docs gap is recorded in the ledger.
      supportsEffort: true,
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
      // Every run emits the documented result envelope (status/response/
      // usage) inside its terminal stream result event; result-envelope.ts.
      supportsResultJson: true,
      // VERIFIED on the Round 11 tree with agy 1.3.3 and scode 0.6.0.
      supportsHermetic: true,
      supportsToolSelection: true,
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--mode=plan"];
      case "low":
        // Default prompting. Headless turns unverifiable approvals into
        // soft denials and still exits 0, so the boundary is scode's.
        return [];
      case "medium":
        return ["--mode=accept-edits"];
      case "high":
        return ["--dangerously-skip-permissions"];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return [`--effort=${level}`]; // `=` form; see the class comment
  }

  override prepareRun(request: RunRequest, sandboxTrust?: ScodeTrustLevel, sandboxOptions: SandboxOptions = {}, launch: LaunchIntent = {}): RunContext {
    if (request.experimentMcp !== undefined) refuseAgyExperiment();
    const probe = isolationProbes.get(request);
    const mode = probe?.mode ?? (request.tools === "none" ? "tools" : request.hermetic ? "hermetic" : undefined);
    const operatorHome = probe?.operatorHome ?? this.environment.HOME ?? homedir();
    const recoveryEnvironment = { ...this.environment, HOME: operatorHome };
    const roots = agyProbeRoots(recoveryEnvironment);
    const printOnly = launch.printOnly === true;
    if (!printOnly) { // a print-only launch repairs and sweeps nothing
      recoverAgyKeychainSearchList(recoveryEnvironment, request.cwd);
      for (const root of roots) sweepStaleHomes(root); }
    if (!request.sandboxed) return {};
    const context: RunContext = { agyProbe: { mode: mode ?? "plain", diagnostic: Boolean(probe),
      operatorHome, printOnly } };
    const prepared = this.preparePrivateHome(context, operatorHome,
      !probe && !request.hermetic && request.tools !== "none", request,
      { ...sandboxOptions, trust: sandboxTrust ?? sandboxOptions.trust });
    // After preparePrivateHome returns, the share-state symlink pass has
    // finished, so the planted config cannot collide with an operator's
    // own .gemini/config entry (wx refuses a reused home loudly).
    if (request.enablePlaywrightMcp && prepared.agyProbe?.home) {
      const planted = plantAgyPlaywrightMcpConfig(prepared.agyProbe.home, {
        pathEnv: this.executionPathEnv(),
        forbiddenRoot: request.cwd ?? process.cwd(),
      });
      prepared.playwrightMcpCheck = planted.check;
    }
    return prepared;
  }

  /** Prepare a private Keychain, then select API key, file token, or Keychain login. */
  private preparePrivateHome(context: RunContext, realHome: string, shareState: boolean,
    request: RunRequest, sandboxOptions: SandboxOptions): RunContext {
    // Creation registers the home as this context's own before anything
    // can fail afterward, so the catch below always owns its full cleanup
    // (agy-probe-home.ts keeps the descriptor-verified lifecycle).
    const home = createAgyProbeHome(context, realHome).home;
    try {
      if (context.agyProbe!.printOnly) return context; // print-only: the HOME path for the argv, no Keychain, no login
      const keychainPassword = prepareAgyPrivateKeychain(home, this.environment, request.cwd);
      const token = join(agyKeychainHost.home(), PROBE_TOKEN);
      const injectedEnv = { ...this.getEnv(), ...this.getRunEnv(request, context) };
      const environment = this.buildExecutionEnv(injectedEnv, request.passthroughEnv);
      const policy = withKeepEnvExemption(sandboxOptions, injectedEnv, this.providerOverrideActive());
      const scrubbing = policy.scrubEnv === true || policy.trust === "untrusted";
      const hasApiKey = ["GEMINI_API_KEY", "GOOGLE_API_KEY"].some((name) =>
        environment[name] && (!scrubbing || policy.keepEnv?.includes(name)));
      // The token is read once, up front: one non-following open, typed and
      // sized on the descriptor (readAgyTokenForCopy; review round 169). Null
      // is "no file token" (the Keychain path); an empty file is a token.
      // Bytes are copied as read, never decoded (review round 170).
      const fileToken = hasApiKey ? null : readAgyTokenForCopy(token);
      if (!hasApiKey && fileToken === null) {
        insertAgyKeychainItem(home, this.environment, keychainPassword, request.cwd);
      }
      const state = join(home, ".gemini", "antigravity-cli");
      mkdirSync(state, { recursive: true, mode: 0o700 });
      // Copy only the file fallback: refreshes stay in this private home,
      // nothing is written back to the real store, and cleanup removes the
      // 0600 copy or reports its path. The macOS login is mirrored
      // separately, never linked to the real Keychain.
      if (fileToken !== null) {
        writeFileSync(join(state, "antigravity-oauth-token"), fileToken, { flag: "wx", mode: 0o600 });
      }
      if (shareState) {
        const grantCommands = request.autonomy === "medium";
        // Share entries individually; an unused token must never become a link.
        for (const [relative, excluded] of [[".gemini", "antigravity-cli"],
          [".gemini/antigravity-cli", "antigravity-oauth-token"]] as const) {
          const source = join(realHome, relative);
          if (!existsSync(source)) continue;
          for (const name of readdirSync(source)) {
            if (name === excluded || name === ".codemux-isolation-probes") continue;
            if (grantCommands && relative === ".gemini/antigravity-cli" && name === "settings.json") continue;
            symlinkSync(join(source, name), join(home, relative, name));
          }
        }
        if (grantCommands) writeFileSync(join(state, "settings.json"),
          headlessMediumSettings(join(realHome, ".gemini/antigravity-cli/settings.json")), { flag: "wx", mode: 0o600 });
        return context;
      }
      if (context.agyProbe!.mode === "tools") writeFileSync(join(state, "settings.json"), JSON.stringify({
        permissions: { deny: AGY_DENIED_ACTIONS.map((action) => `${action}(*)`) },
      }), { mode: 0o600 });
      if (context.agyProbe!.mode === "control") {
        // Copy only the planted control channels, never the operator's configuration.
        for (const name of ["GEMINI.md", "antigravity-cli/settings.json"]) {
          const source = join(realHome, ".gemini", name);
          if (existsSync(source)) writeFileSync(join(home, ".gemini", name), readFileSync(source), { mode: 0o600 });
        }
      }
      return context;
    } catch (error) {
      // The home is registered, so cleanupRunSync owns the last attempt
      // there can be: the context never reaches the launcher, so nothing
      // else would retry or close what a failed removal keeps open
      // (review round 139).
      try { this.cleanupRunSync(context, true); }
      catch (cleanupError) {
        if (error instanceof Error) error.message += `; cleanup failed: ${String(cleanupError)}`;
      }
      throw error;
    }
  }

  /** True from the preparation of a private home until its cleanup
   * finished: a failed removal keeps the descriptors for another attempt. */
  override cleanupRetryPending(context?: RunContext): boolean {
    const owned = context ? ownedProbeHomes.get(context) : undefined;
    return owned !== undefined && owned.finished !== true;
  }

  /** `atExit` marks the process-exit backstop's call: the last attempt
   * there can be, so the validation descriptors are closed even when the
   * removal failed and the cleanup stays retryable for no one. The
   * probe home is removed after the search list is restored. */
  override cleanupRunSync(context?: RunContext, atExit = false): void {
    const probe = context?.agyProbe;
    if (!probe?.home) return;
    const owned = ownedProbeHomes.get(context!);
    if (!owned || probe.home !== owned.home || dirname(probe.home) !== owned.parent) {
      throw new Error("refusing cleanup of an unowned agy probe home");
    }
    if (owned.finished) {
      if (owned.cleanupError) throw owned.cleanupError;
      return;
    }
    let searchError: unknown;
    if (!probe.printOnly) { // print-only created no Keychain state: nothing to repair
      try {
        const recoveryEnvironment = { ...this.environment, HOME: probe.operatorHome ?? this.environment.HOME };
        recoverAgyKeychainSearchList(recoveryEnvironment);
        verifyAgyKeychainSearchList(recoveryEnvironment);
      }
      catch (error) { searchError = error; }
    }
    // The removal keeps its descriptors on every failure a retry could
    // still act on (review round 137: a transient rmSync failure used to
    // close them and cache the error forever).
    removeAgyProbeHome(owned, searchError, atExit);
  }

  buildRunCommand(request: RunRequest, context?: RunContext): string[] {
    // Slash commands and skills are prompt text to codemux, not a command
    // surface, so print mode never expands them.
    const cmd = ["agy", "--disable-slash-commands"];
    const mode = isolationProbes.get(request)?.mode;

    if (request.model) {
      cmd.push(`--model=${request.model}`);
    }
    if (request.effort) {
      cmd.push(...this.mapEffort(request.effort));
    }
    if (mode === "tools-control") {
      cmd.push("--dangerously-skip-permissions");
    } else if (request.tools === "none") {
      cmd.push("--mode=plan");
    } else if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }
    // Every run is a stream run — the stdin prompt carrier requires it —
    // and the terminal result event carries the same envelope `--result-json`
    // re-emits with the codemux block (a plain run unwraps it back to the
    // response text, plain-unwrap.ts).
    cmd.push("--output-format=stream-json", "--input-format=stream-json");

    // Static verify builds argv without writing state (the run launcher
    // calls prepareRun first); HOME changes only after scode establishes
    // the real user's boundary.
    const home = context?.agyProbe?.home ?? context?.agyProbe?.operatorHome ??
      (request.sandboxed ? join(this.environment.HOME ?? homedir(), ".gemini/.codemux-isolation-probes/unprepared") : undefined);
    return home ? [...agyPrivateHomeEnvPrefix(home), ...cmd] : cmd;
  }

  /** The prompt as one stream-json user frame on stdin (the class
   * comment's carrier); promptInArgv's default keys on this, so the argv
   * prompt guards never apply. */
  override getStdinInput(request: RunRequest): string | null {
    return `${JSON.stringify({ event: "user", message: { content: request.prompt } })}\n`;
  }

  override getRunEnv(request: RunRequest, context?: RunContext): Record<string, string> {
    const mode = isolationProbes.get(request)?.mode;
    if ((request.hermetic || request.tools === "none" || mode === "hermetic" || mode === "tools") &&
        !context?.agyProbe?.home) {
      throw new Error("agy isolation home was not prepared before launch");
    }
    return {};
  }

  override processRunResult(result: RunResult, request: RunRequest, context?: RunContext): RunResult {
    const probe = context?.agyProbe;
    if (probe?.diagnostic && request.cwd) {
      writeFileSync(join(request.cwd, "..", "native-events.jsonl"), result.stdout, { mode: 0o600 });
      writeFileSync(join(request.cwd, "..", "native-stderr.txt"), result.stderr, { mode: 0o600 });
    }
    // Every run is a stream run, so every run extracts the terminal
    // envelope from the last result event; an absent event becomes invalid
    // JSON-shaped output and fails there.
    let envelope = "{}";
    for (const line of result.stdout.split("\n").reverse()) {
      let frame: unknown;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame !== null && typeof frame === "object" && !Array.isArray(frame) &&
          (frame as { event?: unknown }).event === "result") {
        envelope = JSON.stringify((frame as { result?: unknown }).result ?? {});
        break;
      }
    }
    const summary = summarizeAgyStream(result.stdout);
    let normalized = request.resultJson
      ? agyResult({ ...result, stdout: envelope }, request)
      : agyPlainResult({ ...result, stdout: envelope });
    if (summary.malformed || (request.tools === "none" && summary.possibleToolActivity)) {
      const reason = summary.malformed ? "malformed native event stream" :
        `--tools none forbids attempted actions: ${summary.attemptedActions.join(", ")}`;
      normalized = { ...normalized, success: false, exitCode: result.exitCode || 1,
        stderr: `${normalized.stderr}\ncodemux: agy ${reason}\n` };
    }
    return { ...normalized, scanSurface: result.stdout,
      stdout: probe?.diagnostic ? result.stdout : normalized.stdout };
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    const isolated = request.hermetic || request.tools === "none";
    if (isolated && !request.sandboxed) {
      // The isolation boundary is scode's, not a harness flag: the launch
      // blocks the operator's real ~/.gemini and re-allows only the private
      // home. Without scode a private HOME is a claim the launch cannot
      // deliver, at any autonomy.
      throw new UsageRefusalError(
        "agy isolation requires scode (--sandbox) at every autonomy: without it the operator's real agy state stays reachable"
      );
    }
    // The Playwright carrier plants the server in the run's private probe
    // home (src/agy-playwright-mcp.ts), which only a sandboxed launch
    // mints — without scode there is no per-run channel, and the flag
    // must fail rather than silently attach nothing (the shared CLI's
    // wording, so a programmatic caller meets the same rule).
    if (request.enablePlaywrightMcp && !request.sandboxed) {
      throw new UsageRefusalError("--enable-playwright-mcp requires --sandbox");
    }
    if (request.hermetic || isolationProbes.get(request)?.mode === "hermetic") {
      if (!request.cwd) throw new UsageRefusalError("agy --hermetic requires an explicit --cwd owned by this run");
      let directory = validateWorkingDirectory(request.cwd)!;
      while (true) {
        for (const name of ["GEMINI.md", "AGENTS.md", ".agents"]) {
          const path = join(directory, name);
          if (lstatSync(path, { throwIfNoEntry: false })) {
            throw new UsageRefusalError(`agy --hermetic requires a clean working directory owned by this run; offending path: ${path}`);
          }
        }
        if (existsSync(join(directory, ".git")) || dirname(directory) === directory) break;
        directory = dirname(directory);
      }
    }
    assertNoAgyProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
  }

  override validateTuiRequest(
    model?: string,
    cwd?: string,
    autonomy: AutonomyLevel = "read-only",
    effort?: ReasoningEffort,
    passthroughEnv: readonly string[] = [],
    enablePlaywrightMcp = false
  ): void {
    super.validateTuiRequest(model, cwd, autonomy, effort, passthroughEnv, enablePlaywrightMcp);
    assertNoAgyProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    const cmd = ["agy"];
    if (model) {
      cmd.push(`--model=${model}`);
    }
    if (effort) {
      cmd.push(...this.mapEffort(effort));
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }

  /** The agy login read: the file token under ~/.gemini, or an API key. */
  override loginState(): LoginState {
    return agyLoginState(loginHome(this.environment), this.environment);
  }
}
