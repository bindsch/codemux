import { BaseAdapter, type RunContext } from "./base.js";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { AgyProbeMode } from "../agy-isolation-probe.js";
import { summarizeAgyStream } from "../agy-stream.js";
import { AGY_MIRROR_PATH, agyKeychainHost, agyProbeRoots, buildAgyKeychainMirror, recoverAgyKeychainSearchList, verifyAgyKeychainSearchList } from "../agy-keychain.js";
import { assertNoAgyProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
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
} from "../types.js";

const isolationProbes = new WeakMap<RunRequest, { mode: AgyProbeMode; operatorHome?: string }>();
const ownedProbeHomes = new WeakMap<RunContext, {
  home: string; parent: string; parentDev: number; parentIno: number;
  homeDev: number; homeIno: number; marker: string;
  parentFd: number; homeFd: number; finished?: boolean; cleanupError?: Error;
}>();
const PROBE_MARKER = ".codemux-probe-owner";
const PROBE_PID = ".codemux-probe-pid";
const PROBE_TOKEN = ".gemini/antigravity-cli/antigravity-oauth-token";

/** Remove only identified private homes whose owner is known to have exited. */
function sweepStaleHomes(root: string): void {
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat) return;
  if (!rootStat.isDirectory()) throw new Error("agy probe home root must be a directory, not a symlink");
  if (rootStat.uid !== process.getuid?.() || realpathSync(root) !== root) {
    throw new Error("agy probe sweep root must be canonical and user-owned");
  }
  for (const name of readdirSync(root)) {
    if (!name.startsWith("run-")) continue;
    try {
      const home = join(root, name);
      const identity = lstatSync(home, { throwIfNoEntry: false });
      if (!identity?.isDirectory() || identity.uid !== rootStat.uid) continue;
      const marker = join(home, PROBE_MARKER);
      if (!lstatSync(marker, { throwIfNoEntry: false })?.isFile() ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(readFileSync(marker, "utf8"))) continue;
      const pidPath = join(home, PROBE_PID);
      if (!lstatSync(pidPath, { throwIfNoEntry: false })?.isFile()) continue;
      const owner = readFileSync(pidPath, "utf8");
      if (!/^[1-9]\d*$/.test(owner) || !Number.isSafeInteger(Number(owner))) continue;
      try { process.kill(Number(owner), 0); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
      // Never follow a replacement introduced during the owner check.
      if (sameDirectory(root, rootStat) && sameDirectory(home, identity)) rmSync(home, { recursive: true, force: true });
    } catch (error) {
      // Another launch or normal cleanup may have removed this entry already.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function sameDirectory(path: string, identity: Stats): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return Boolean(stat?.isDirectory() && stat.dev === identity.dev && stat.ino === identity.ino);
}

function findDirectory(parent: string, identity: Stats): string | undefined {
  return readdirSync(parent).map((name) => join(parent, name)).find((path) => sameDirectory(path, identity));
}
/** Internal entry for check's isolation diagnostics only. */
export function markAgyIsolationProbe(request: RunRequest, mode: AgyProbeMode, operatorHome?: string): void {
  if (request.agent !== "agy" || !request.sandboxed || request.autonomy !== "read-only" ||
      request.hermetic || request.tools === "none" || request.experimentMcp) {
    throw new Error("agy isolation probes require a plain read-only scode request");
  }
  isolationProbes.set(request, { mode, operatorHome });
}

const AGY_DENIED_ACTIONS = ["read_file", "write_file", "read_url", "execute_url", "command", "unsandboxed", "mcp"];

function headlessMediumSettings(path: string): string {
  let settings: unknown = {};
  try { if (existsSync(path)) settings = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`cannot read agy settings: ${path}`); }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`invalid agy settings object: ${path}`);
  }
  const config = settings as Record<string, unknown>;
  const permissions = config.permissions ?? {};
  if (typeof permissions !== "object" || Array.isArray(permissions)) {
    throw new Error(`invalid agy settings permissions: ${path}`);
  }
  const rules = permissions as Record<string, unknown>;
  const allow = rules.allow ?? [];
  if (!Array.isArray(allow) || allow.some((rule) => typeof rule !== "string")) {
    throw new Error(`invalid agy settings permissions.allow: ${path}`);
  }
  return JSON.stringify({ ...config, permissions: { ...rules, allow: [...new Set([...allow, "command(*)"])] } });
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
 * `--flag=value` for those. `--model` rides in the same single-token form:
 * its space form was never exercised against the pinned 1.2.14 while its
 * sibling value flags reject theirs, and the `=`-form is the one the live
 * captures ran. The prompt rides in argv as `--print=<prompt>` (verified
 * to parse; keeps a leading-dash prompt inside the option), which leaves
 * stdin closed and lets BaseAdapter's argv prompt guards apply.
 *
 * An unrecognized `--mode` value only warns and continues with the
 * default mode, so this adapter must never emit a value outside
 * {plan, accept-edits} -- a typo would silently change autonomy rather
 * than fail the launch.
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
      // 1.2.14's help lists low|medium|high|xhigh|max; the official docs
      // table names only low/medium/high. The binary is the contract, so
      // all five are accepted and the docs gap is recorded in the ledger.
      supportsEffort: true,
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
      // --output-format=json (the `=` form the class comment requires)
      // prints the documented result envelope (status/response/usage);
      // see result-envelope.ts.
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
    // `=` form; see the class comment.
    return [`--effort=${level}`];
  }

  override prepareRun(request: RunRequest, sandboxTrust?: ScodeTrustLevel, sandboxOptions: SandboxOptions = {}): RunContext {
    const probe = isolationProbes.get(request);
    const mode = probe?.mode ?? (request.tools === "none" ? "tools" : request.hermetic ? "hermetic" : undefined);
    const operatorHome = probe?.operatorHome ?? this.environment.HOME ?? homedir();
    const recoveryEnvironment = { ...this.environment, HOME: operatorHome };
    const roots = agyProbeRoots(recoveryEnvironment);
    recoverAgyKeychainSearchList(recoveryEnvironment, request.cwd);
    for (const root of roots) sweepStaleHomes(root);
    if (!request.sandboxed) return {};
    const context: RunContext = { agyProbe: { mode: mode ?? "plain", diagnostic: Boolean(probe),
      operatorHome: probe?.operatorHome } };
    return this.preparePrivateHome(context, operatorHome,
      !probe && !request.hermetic && request.tools !== "none", request,
      { ...sandboxOptions, trust: sandboxTrust ?? sandboxOptions.trust });
  }

  /** Select API key, file token, then Keychain before constructing a mirror. */
  private preparePrivateHome(context: RunContext, realHome: string, shareState: boolean,
    request: RunRequest, sandboxOptions: SandboxOptions): RunContext {
    if (!isAbsolute(realHome)) throw new Error("agy probe HOME must be absolute");
    let root = join(realHome, ".gemini", ".codemux-isolation-probes");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (lstatSync(root).isSymbolicLink()) throw new Error("agy probe home root cannot be a symlink");
    root = realpathSync(root);
    const parentFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let home: string | undefined;
    let homeFd: number | undefined;
    try {
      const parentStat = fstatSync(parentFd);
      home = mkdtempSync(join(root, "run-"));
      homeFd = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const homeStat = fstatSync(homeFd);
      const marker = randomUUID();
      writeFileSync(join(home, PROBE_PID), String(process.pid), { flag: "wx", mode: 0o600 });
      writeFileSync(join(home, PROBE_MARKER), marker, { flag: "wx", mode: 0o600 });
      ownedProbeHomes.set(context, { home, parent: root, parentDev: parentStat.dev, parentIno: parentStat.ino,
        homeDev: homeStat.dev, homeIno: homeStat.ino, marker, parentFd, homeFd });
      context.agyProbe!.home = home;
      const token = join(agyKeychainHost.home(), PROBE_TOKEN);
      const injectedEnv = { ...this.getEnv(), ...this.getRunEnv(request, context) };
      const environment = this.buildExecutionEnv(injectedEnv, request.passthroughEnv);
      const policy = withKeepEnvExemption(sandboxOptions, injectedEnv, this.providerOverrideActive());
      const scrubbing = policy.scrubEnv === true || policy.trust === "untrusted";
      const hasApiKey = ["GEMINI_API_KEY", "GOOGLE_API_KEY"].some((name) =>
        environment[name] && (!scrubbing || policy.keepEnv?.includes(name)));
      const fileToken = hasApiKey ? undefined : lstatSync(token, { throwIfNoEntry: false });
      if (fileToken && !fileToken.isFile()) throw new Error("agy probe token must be a regular file");
      if (!hasApiKey && !fileToken) {
        buildAgyKeychainMirror(home, this.environment, request.cwd);
      }
      const state = join(home, ".gemini", "antigravity-cli");
      mkdirSync(state, { recursive: true, mode: 0o700 });
      // Copy only the file fallback. Refreshes stay in this private home;
      // nothing is written back to the real store. The 0600 copy lasts for
      // this run only: cleanup removes it or reports its path and fails.
      // The macOS login is mirrored separately, never linked to the real Keychain.
      if (fileToken) {
        writeFileSync(join(state, "antigravity-oauth-token"), readFileSync(token), { flag: "wx", mode: 0o600 });
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
      if (context.agyProbe!.home) {
        try { this.cleanupRun(context); }
        catch (cleanupError) {
          if (error instanceof Error) error.message += `; cleanup failed: ${String(cleanupError)}`;
        }
      }
      else {
        try { if (home) rmSync(home, { recursive: true }); }
        finally {
          try { if (homeFd !== undefined) closeSync(homeFd); }
          finally { closeSync(parentFd); }
        }
      }
      throw error;
    }
  }

  override cleanupRunSync(context?: RunContext): void {
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
    let homePath = owned.home;
    let searchError: unknown;
    try {
      const recoveryEnvironment = { ...this.environment, HOME: context?.agyProbe?.operatorHome ?? this.environment.HOME };
      recoverAgyKeychainSearchList(recoveryEnvironment);
      verifyAgyKeychainSearchList(recoveryEnvironment);
    }
    catch (error) { searchError = error; }
    try {
      const parent = fstatSync(owned.parentFd);
      const home = fstatSync(owned.homeFd);
      if (!parent.isDirectory() || parent.dev !== owned.parentDev || parent.ino !== owned.parentIno ||
          !home.isDirectory() || home.dev !== owned.homeDev || home.ino !== owned.homeIno) {
        throw new Error("refusing cleanup of a replaced agy probe home or parent");
      }
      let parentPath = owned.parent;
      if (!lstatSync(parentPath, { throwIfNoEntry: false })) {
        parentPath = findDirectory(dirname(parentPath), parent) ?? "";
      }
      if (!parentPath || !sameDirectory(parentPath, parent) || realpathSync(parentPath) !== parentPath) {
        throw new Error("refusing cleanup of a replaced agy probe parent or one that cannot be found");
      }
      if (!lstatSync(owned.home, { throwIfNoEntry: false })) {
        homePath = findDirectory(parentPath, home) ?? "";
      }
      if (!homePath || !sameDirectory(homePath, home)) {
        throw new Error("refusing cleanup of a replaced agy probe home or one that cannot be found");
      }
      const markerPath = join(homePath, PROBE_MARKER);
      if (!lstatSync(markerPath).isFile() || readFileSync(markerPath, "utf8") !== owned.marker) {
        throw new Error("refusing cleanup of a replaced agy probe home or parent");
      }
      rmSync(homePath, { recursive: true });
      if (searchError) throw searchError;
    } catch (error) {
      owned.cleanupError = new Error(`agy probe cleanup failed: ${error instanceof Error ? error.message : String(error)}; ` +
        (searchError && error !== searchError ? `${String(searchError)}; ` : "") +
        `token copy may remain at ${join(homePath || owned.home, PROBE_TOKEN)} ` +
        `or keychain mirror at ${join(homePath || owned.home, AGY_MIRROR_PATH)} ` +
        `(home device ${owned.homeDev}, inode ${owned.homeIno})`);
      throw owned.cleanupError;
    } finally {
      owned.finished = true;
      try { closeSync(owned.homeFd); }
      finally { closeSync(owned.parentFd); }
    }
  }

  buildRunCommand(request: RunRequest, context?: RunContext): string[] {
    // Slash commands and skills are prompt text to codemux, not a command
    // surface, so print mode never expands them.
    const cmd = ["agy", "--disable-slash-commands"];
    const mode = isolationProbes.get(request)?.mode;
    const isolated = mode === "hermetic" || mode === "tools" || request.hermetic || request.tools === "none";

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
    // Always the result envelope, plain runs included: `--result-json`
    // re-emits it with the codemux block appended; a plain run unwraps it
    // back to the response text (plain-unwrap.ts) so stdout keeps its
    // contract while the call ledger gets the usage.
    cmd.push(mode || isolated ? "--output-format=stream-json" : "--output-format=json");

    cmd.push(`--print=${request.prompt}`);
    // Static verify builds argv without writing state. The run launcher
    // calls prepareRun before building an actual launch command.
    const home = context?.agyProbe?.home ?? context?.agyProbe?.operatorHome ??
      (request.sandboxed ? join(this.environment.HOME ?? homedir(), ".gemini/.codemux-isolation-probes/unprepared") : undefined);
    // HOME changes only after scode establishes the real user's boundary.
    return home ? ["env", `HOME=${home}`, `XDG_CONFIG_HOME=${join(home, ".config")}`,
      `XDG_CACHE_HOME=${join(home, ".cache")}`, `XDG_DATA_HOME=${join(home, ".local/share")}`,
      `XDG_STATE_HOME=${join(home, ".local/state")}`, ...cmd] : cmd;
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
    if (context?.agyProbe && context.agyProbe.mode !== "plain") {
      if (context.agyProbe.diagnostic) {
        writeFileSync(join(request.cwd!, "..", "native-events.jsonl"), result.stdout, { mode: 0o600 });
        writeFileSync(join(request.cwd!, "..", "native-stderr.txt"), result.stderr, { mode: 0o600 });
      }
      // Extract the terminal envelope, then use ordinary result handling.
      // An absent event becomes invalid JSON-shaped output and fails there.
      let envelope = "{}";
      for (const line of result.stdout.split("\n").reverse()) {
        if (!line.trim()) continue;
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
        stdout: context.agyProbe.diagnostic ? result.stdout : normalized.stdout };
    }
    if (request.resultJson) return agyResult(result, request);
    // A plain run: the same envelope, unwrapped back to the response text.
    // Stdout that is not JSON passes through verbatim with the run
    // unchanged (plain-unwrap.ts's escape hatch); JSON that is not the
    // envelope fails with nothing on stdout.
    return agyPlainResult(result);
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    const isolated = request.hermetic || request.tools === "none";
    if (isolated && (!request.sandboxed || request.autonomy !== "read-only")) {
      throw new Error("agy isolation requires read-only scode (--auto read-only)");
    }
    if (request.hermetic || isolationProbes.get(request)?.mode === "hermetic") {
      if (!request.cwd) throw new Error("agy --hermetic requires an explicit --cwd owned by this run");
      let directory = validateWorkingDirectory(request.cwd)!;
      while (true) {
        for (const name of ["GEMINI.md", "AGENTS.md", ".agents"]) {
          const path = join(directory, name);
          if (lstatSync(path, { throwIfNoEntry: false })) {
            throw new Error(`agy --hermetic requires a clean working directory owned by this run; offending path: ${path}`);
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
}
