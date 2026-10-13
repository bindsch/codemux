import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { BaseAdapter, type RunContext } from "./base.js";
import {
  assertTrustedDirectory,
  createCodexHermeticHome,
  prepareRunDirParent,
} from "../hermetic-home.js";
import {
  assertNoCodexStoreKnob,
  CODEX_MULTI_AGENT_ENV,
  CODEX_PROVIDER_KEY_ENV,
  readCodexMultiAgent,
  writeCodexProviderConfig,
  writeCodexProviderConfigInto,
} from "../codex-provider.js";
import {
  assertProviderCap,
  readProviderOverride,
  requireProviderOverride,
  type ProviderOverride,
} from "../provider-override.js";
import {
  assertNoCodexProjectExecutionConfig,
  assertNoCodexProjectSkills,
} from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import { readUtf8FileBounded } from "../file-io.js";
import { appendDiagnostic, codexResult } from "../result-envelope.js";
import {
  CodexPlainFold,
  codexPlainStreamResult,
  type CodexPlanFallbackRead,
} from "../plain-unwrap.js";
import type { ScodeTrustLevel } from "../sandbox.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  RunResult,
  AdapterCapabilities,
} from "../types.js";

// Hermetic runs get a private HOME and CODEX_HOME (see hermetic-home.ts),
// which removes everything Codex reads from disk. These overrides remove what
// the working directory and the account would still contribute. A feature key
// Codex no longer knows only logs a warning, so a removed key cannot break a
// launch.
const CODEX_HERMETIC_FLAGS = [
  // The login is the linked auth.json; the Keychain entry is keyed by the
  // real CODEX_HOME path and would not be found from the private one.
  "-c", 'cli_auth_credentials_store="file"',
  // A zero budget skips AGENTS.md discovery entirely (agents_md.rs).
  "-c", "project_doc_max_bytes=0",
  "-c", "project_doc_fallback_filenames=[]",
  // Account-level app connectors add instructions and tools of their own.
  "-c", "include_apps_instructions=false",
  "--disable", "apps",
  "--disable", "plugins",
  "--disable", "remote_plugin",
  "--disable", "recommended_plugins",
  "--disable", "hooks",
  "--disable", "memories",
  "--disable", "goals",
  "--disable", "skill_mcp_dependency_install",
  // The shell snapshot sources the operator's shell profile.
  "--disable", "shell_snapshot",
  // Not disabled: Codex's bundled system skills (imagegen, openai-docs,
  // plugin-creator, skill-creator, skill-installer at 0.154), which it
  // extracts into any home. They ship with the harness, like its base
  // prompt. `skip_host_skill_discovery` does not remove them and only
  // adds an under-development warning.
] as const;

// `--tools none`: every tool Codex 0.154 registers that reaches the machine,
// the network, or another agent, except `apply_patch`, which Codex ties to
// the model rather than to a feature (tools/spec_plan.rs). The adapter
// therefore accepts `--tools none` only at read-only autonomy, where the
// sandbox denies writes to the working directory (locations scode keeps
// writable, such as harness state and temp, remain reachable). The plan
// tool remains; it has no effect outside the conversation.
const CODEX_NO_TOOLS_FLAGS = [
  "--disable", "shell_tool",
  "--disable", "unified_exec",
  "--disable", "view_image",
  "--disable", "multi_agent",
  "--disable", "multi_agent_v2",
  "--disable", "browser_use",
  "--disable", "computer_use",
  "--disable", "image_generation",
  "--disable", "tool_suggest",
  // The top-level mode; a boolean `tools.web_search` is silently dropped.
  "-c", 'web_search="disabled"',
  "-c", "tools.view_image=false",
] as const;

// The --output-last-message file holds model output, so it gets the same
// bound a prompt file gets: 16 MiB, generous for a reply and small enough
// that a runaway file cannot exhaust the read.
const MAX_FINAL_MESSAGE_BYTES = 16 * 1024 * 1024;

// The file's name inside its per-run directory (or the private hermetic
// home): the directory gives the run its uniqueness, so the file itself
// needs none.
const LAST_MESSAGE_BASENAME = "last-message";

// Where a plain run's per-run fallback directory lives: inside the real
// CODEX_HOME, harness state scode keeps writable on every platform (its
// Linux sandbox mounts a fresh /tmp that would hide a temp-root file from
// the parent). The private hermetic home follows the same rule for the
// same reason (see hermetic-home.ts).
const SCRATCH_PARENT_DIR_NAME = ".codemux-scratch";

/** What reading a run's --output-last-message file produced (round al18,
 * the classes redrawn in round al26): `absent` is no file named for this
 * run (an untrusted sandbox launch passes none); `empty` is a named file
 * read and holding nothing — upstream's own spelling of a messageless
 * turn (handle_last_message writes an empty file and warns); `text` is a
 * named file read and holding the message, VERBATIM, whatever it ends
 * with (round al26, correctness minor: codex's writer is
 * `fs::write(path, message)`, no newline added, so a message ending in
 * one keeps it and the reply prints it the way human mode's println!
 * does); `missing` is a named file that is not there — upstream writes
 * SOMETHING for every completed turn, so an absent file is a write codex
 * only logged (round al26, correctness major: the writer's failure path
 * is an eprintln) or a sabotaged path, never a message that never
 * existed; and `unreadable` is a file codemux could not safely read (a
 * permission error, an oversized or non-UTF-8 file, a refused symlink or
 * directory). The classes stay distinct because both verdicts turn on
 * them: on the envelope path an unreadable file fails the run outright
 * (finalMessageReadFailure) rather than arriving as the absent-message
 * null, and a missing one fails it naming the absent file; on the plain
 * path (round al29) the read maps into CodexPlanFallbackRead and the
 * ONE bounded verdict arm turns on it — `text`/`empty` to text, `missing`
 * to absent, `unreadable` carried whole, and `absent` (no file named:
 * the untrusted launch) meaning the arm never fires. */
type FinalMessageRead =
  | { outcome: "absent" }
  | { outcome: "empty" }
  | { outcome: "text"; text: string }
  | { outcome: "missing" }
  | { outcome: "unreadable"; error: string };

/** The failed run a --output-last-message file that could not be read
 * produces (round al18): the read error rides stderr, the exit is nonzero,
 * and the run reports failure. Round al29 scoped it to the --result-json
 * branch alone: that path applies it BEFORE its verdict builds its result
 * (round al20), so it goes through the same failure normalization as every
 * other failed run — the envelope serializes a null result and null usage.
 * The plain path never calls it: the fallback there is the bounded thunk
 * (CodexPlanFallbackRead) the verdict consults only for a completed turn
 * with no message anywhere, so a stream that carried the reply still
 * prints it and the unreadable file changes nothing — the read failure
 * loses the file's message, not the run's. */
function finalMessageReadFailure(result: RunResult, error: string): RunResult {
  return {
    ...result,
    stderr: appendDiagnostic(
      result.stderr,
      `codemux: could not read codex's --output-last-message file: ${error}`
    ),
    exitCode: result.exitCode === 0 ? 1 : result.exitCode,
    success: false,
  };
}

export class CodexAdapter extends BaseAdapter {
  readonly id: AgentId = "codex";
  readonly binaryName = "codex";

  // Seams so tests can point the real CODEX_HOME at a scratch directory.
  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    private readonly homeDirectory?: string
  ) {
    super(environment);
  }

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
      supportsHermetic: true,
      supportsToolSelection: true,
      // `codex exec --json` prints its events as JSONL, which processRunResult
      // reduces to the result envelope.
      supportsResultJson: true,
      supportsProviderOverride: true,
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    // The sandbox flag is shared state between the root and exec parsers, so
    // it lands wherever it is placed (cli/src/main.rs copies SharedCliOptions
    // into the exec CLI, and the exec parser accepts it after `exec` too, for
    // fresh runs and `exec resume` alike). The approval policy is not:
    // `-a` before `exec` is parsed by the root and then dropped -- the exec
    // handoff copies only SharedCliOptions -- `exec` has no `-a` of its own,
    // and at 0.159.x `-a` accepts only on-request and never anyway (so the
    // old `-a untrusted` was an invalid value). The config override is the
    // one channel that reaches every mode (exec, exec resume, and the TUI),
    // which is also how mapEffort already passes effort.
    switch (level) {
      case "read-only":
        return ["-s", "read-only", "-c", 'approval_policy="never"'];
      case "low":
        return ["-s", "workspace-write", "-c", 'approval_policy="untrusted"'];
      case "medium":
        return ["-s", "workspace-write", "-c", 'approval_policy="never"'];
      case "high":
        return ["-s", "danger-full-access", "-c", 'approval_policy="never"'];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return ["-c", `model_reasoning_effort="${level}"`];
  }

  /**
   * The real CODEX_HOME whose login a hermetic run may use: the same one a
   * plain run of this request sees. The sanitized child environment drops
   * CODEX_HOME unless the operator passes it through with --pass-env, in
   * which case both kinds of run use that profile. The check and the return
   * read the value exactly as the child receives it: codex does not trim
   * CODEX_HOME, so a padded value is relative at launch and validating a
   * trimmed copy would wave it through (the round10 CLAUDE_CONFIG_DIR
   * finding's rule, applied to this sibling boundary). An absolute value
   * with surrounding whitespace is refused too: codex keeps the padding, so
   * the harness state would land in a directory whose name still carries it
   * (the round13 doc-drift finding -- the checks now match what the docs
   * already promised).
   */
  private realCodexHome(request: RunRequest): string {
    const passedThrough = request.passthroughEnv?.includes("CODEX_HOME") ?? false;
    const configured = this.environment.CODEX_HOME;
    if (passedThrough && configured) {
      if (!isAbsolute(configured)) {
        throw new Error("CODEX_HOME must be an absolute path");
      }
      if (configured.trim() !== configured) {
        throw new Error(
          `CODEX_HOME must not be whitespace-padded when passed through; ` +
            `'${configured}' carries leading or trailing whitespace, and ` +
            "codex reads the variable without trimming, so the harness state " +
            "would live in a directory whose name still carries the padding"
        );
      }
      return configured;
    }
    return join(this.effectiveHome(), ".codex");
  }

  /** The user home a run sees: the seam, else $HOME, else the account home. */
  private effectiveHome(): string {
    if (this.homeDirectory !== undefined && !isAbsolute(this.homeDirectory)) {
      throw new Error("Codex home directory must be an absolute path");
    }
    const home = this.homeDirectory ?? this.environment.HOME;
    return home && isAbsolute(home) ? home : homedir();
  }

  /**
   * The provider override, validated: a base URL and a key routed through a
   * private per-run CODEX_HOME (codex-provider.ts), plus the model the
   * endpoint serves. The output-token cap is refused — no release Codemux
   * supports reads one — while the context cap rides `model_context_window`
   * in the same config.toml. The multi-agent knob rides that config too, so
   * it is validated here as well: every launch path (validateRunRequest
   * through modelFor, the TUI check, prepareRun's writers) fails loudly on
   * a value that is not on/off or on a knob set without an override.
   */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    // Refused before EVERY override check — the multi-agent knob's
    // included (round al21, contracts-2 minor 2: the call sat below
    // assertMultiAgentKnob, so a malformed multi-agent override masked
    // it and the "fires with or without an override" guarantee below did
    // not hold) — so it fires with or without an override, well-formed
    // or not: the knob names a key no supported release has, so even the
    // "on" reading would be a silent no-op on a real override run.
    assertNoCodexStoreKnob(this.environment);
    const override = readProviderOverride("codex", this.environment);
    this.assertMultiAgentKnob(override);
    if (override === null) return null;
    assertProviderCap(
      "codex",
      override,
      "maxOutputTokens",
      "no release Codemux supports reads a model_max_output_tokens key — the " +
        "0.160 config reference lists model_context_window but no output cap, " +
        "and the key never existed in the source through 0.160"
    );
    return requireProviderOverride("codex", override, [
      "baseUrl",
      "apiKey",
    ]) as ProviderOverride & { baseUrl: string; apiKey: string };
  }

  /**
   * The multi-agent knob (codex-provider.ts) rides the config.toml the
   * override owns, so a knob set without an override fails loudly — exactly
   * like a token cap without one — instead of sitting silently on a plain
   * run's operator config, which codemux never writes. The value check
   * (on/off) happens inside readCodexMultiAgent and fires on every path
   * that reaches this method, override or not.
   */
  private assertMultiAgentKnob(override: ProviderOverride | null): void {
    const setting = readCodexMultiAgent(this.environment);
    if (setting === null || override !== null) return;
    throw new Error(
      `${CODEX_MULTI_AGENT_ENV} is set but no provider override is; the ` +
        "knob rides the override's own config.toml, so also set " +
        "CODEMUX_CODEX_PROVIDER_BASE_URL, CODEMUX_CODEX_PROVIDER_API_KEY " +
        "and CODEMUX_CODEX_PROVIDER_MODEL"
    );
  }

  /**
   * The model an override run uses: the request's, else the override's. With
   * an override one must exist — the config.toml pins `model`, and falling
   * back to Codex's built-in default would hit the operator's endpoint with
   * an OpenAI catalog name it may not serve.
   */
  private modelFor(model: string | undefined): string | undefined {
    const override = this.validatedProvider();
    const resolved = model ?? override?.model;
    if (resolved === undefined && override !== null) {
      throw new Error(
        "codex needs a model for the provider override; pass --model or set CODEMUX_CODEX_PROVIDER_MODEL"
      );
    }
    return resolved;
  }

  override getEnvOmissions(): readonly string[] {
    // With an override the provider key is the credential, so the operator's
    // own Codex/OpenAI keys stay out of the child environment: a stray
    // CODEX_API_KEY would hand the run a second, operator-funded
    // authentication path codemux never chose. Without one, both keep
    // forwarding as before (ALLOWED_CREDENTIAL_ENV.codex).
    return this.validatedProvider() === null ? [] : ["CODEX_API_KEY", "OPENAI_API_KEY"];
  }

  buildRunCommand(request: RunRequest, context?: RunContext): string[] {
    const cmd: string[] = [];
    const override = this.validatedProvider();

    if (request.hermetic) {
      // The private HOME reaches Codex through env(1), not through the
      // environment codemux hands to scode: scode derives its deny rules
      // (~/Documents, ~/.aws, ...) from $HOME, so moving HOME for the whole
      // launch would move the sandbox's protected paths off the real home.
      // A static preview (`verify`) has no prepared home; the placeholder
      // path does not exist, and Codex refuses a missing CODEX_HOME, so a
      // command built without prepareRun fails closed.
      const unprepared = join(this.realCodexHome(request), ".codemux-hermetic", "unprepared");
      const home = context?.hermeticHome ?? {
        home: unprepared,
        codexHome: join(unprepared, ".codex"),
      };
      cmd.push("env", `HOME=${home.home}`, `CODEX_HOME=${home.codexHome}`);
    } else if (override !== null) {
      // A non-hermetic override run also gets a private CODEX_HOME — the
      // per-run directory holding this run's config.toml (codex-provider.ts)
      // — delivered the same way, so the operator's config.toml and
      // auth.json are not read by construction. Same fail-closed placeholder
      // rule as the hermetic home: without prepareRun the home does not
      // exist and Codex refuses a missing CODEX_HOME.
      const unprepared = join(this.realCodexHome(request), ".codemux-provider", "unprepared");
      cmd.push("env", `CODEX_HOME=${context?.codexProviderHome?.codexHome ?? unprepared}`);
    }
    cmd.push("codex");

    if (request.hermetic) {
      cmd.push(...CODEX_HERMETIC_FLAGS);
    }
    if (request.tools === "none") {
      cmd.push(...CODEX_NO_TOOLS_FLAGS);
    }

    if (request.model && override === null) {
      // On an override run the model rides the config.toml, never -m: the
      // two could disagree across a config rewrite, and one source is
      // checkable.
      cmd.push("-m", request.model);
    }

    if (request.sandboxed) {
      // codemux is already enforcing scode sandbox boundaries.
      cmd.push("--dangerously-bypass-approvals-and-sandbox");
    } else if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }

    if (request.effort) {
      cmd.push(...this.mapEffort(request.effort));
    }

    cmd.push("exec", "--skip-git-repo-check");
    // No run of this adapter persists a session: a thread codex would write
    // under CODEX_HOME dies with the run instead of staying resumable.
    cmd.push("--ephemeral");
    cmd.push("--ignore-rules");
    // Events as JSONL on stdout (one per line; codex-rs exec lib.rs), on
    // every run: the ledger's usage and the reply both come from the
    // stream. A plain run never captures it whole -- an agentic stream is
    // tens of MiB and fills the 16 MiB capture bound (the ul3 finding) --
    // so prepareRun hangs a streaming fold on the context and the launcher
    // feeds the stream through it, keeping the reply text, the usage
    // snapshot, and the served model while the tool output is dropped as
    // it arrives (plain-unwrap.ts). The fold reproduces human mode's
    // stdout exactly on every shape whose bytes the wire can carry: the
    // final assistant message of a completed turn (kept even when codex
    // then exits nonzero), nothing for a turn that never completed, and —
    // the one shape whose bytes it cannot — a completed turn with no
    // message anywhere succeeding with empty stdout, human mode's own
    // exit-0 verdict for it (round al10). --result-json additionally
    // reduces the same stream to the promised envelope.
    cmd.push("--json");
    // Round al29: every run names a --output-last-message file — a
    // Plan-only turn's recorded final message is the reply's only
    // carrier, the one item the JSONL wire does not carry (see
    // CODEX_FINAL_MESSAGE_FALLBACK_NOTE), and the plain verdict needs it
    // for exactly that turn. The two paths consult it under two rules
    // that cannot let it contradict the stream: the envelope path applies
    // it to a messageless stream as before, and the plain verdict reads
    // it only in the ONE bounded arm — a turn that completed with no
    // agent_message and nothing else failed (plain-unwrap.ts,
    // CodexPlanFallbackRead) — so a stream that carried the reply, or
    // failed, answers from the stream alone. Round al28's rule (the file
    // deleted from plain runs entirely) lost the Plan-only turn's reply
    // on the one path operators run by hand. prepareRun puts the file in
    // a per-run directory under `.codemux-scratch/` in the real
    // CODEX_HOME -- harness state, which every scode platform keeps
    // writable and none shadows -- or inside the private home on a
    // hermetic run. An untrusted sandbox denies harness state, so that
    // launch prepares no file and the stream is the result's only source
    // (a Plan-only turn there succeeds empty on a plain run, the al10
    // rule, and reports a null result on --result-json, README's
    // documented cost). A static preview (`verify`) has no prepared
    // context, so it names a placeholder under a directory that cannot
    // exist, failing closed the way the hermetic home's preview does.
    {
      const fallbackPath = context?.lastMessagePath;
      if (fallbackPath !== undefined) {
        cmd.push("--output-last-message", fallbackPath);
      } else if (context === undefined) {
        const placeholder = join(
          this.realCodexHome(request),
          request.hermetic ? ".codemux-hermetic" : SCRATCH_PARENT_DIR_NAME,
          "unprepared",
          LAST_MESSAGE_BASENAME
        );
        cmd.push("--output-last-message", placeholder);
      }
      // A prepared context with no lastMessagePath is the untrusted
      // launch: there is no file to name, by design.
    }
    if (request.hermetic && override === null) {
      // Belt and braces: the private CODEX_HOME holds no config.toml anyway.
      // An override run is the exception that proves the rule's wording —
      // `--ignore-user-config` skips "$CODEX_HOME/config.toml" itself, which
      // is exactly where the override lives (verified in the 0.160 binary's
      // own help text), so it is never passed on one.
      cmd.push("--ignore-user-config");
    }
    cmd.push("-");

    return cmd;
  }

  /**
   * Whether the run authenticates with an API key. Only the variable Codex
   * itself reads counts (CODEX_API_KEY at 0.154): a hermetic run must use
   * the same credential a plain run would, never switch an operator with a
   * stray OPENAI_API_KEY from the account login to API billing.
   */
  private apiKeyAuth(): boolean {
    return Boolean(this.environment.CODEX_API_KEY?.trim());
  }

  /**
   * Builds this run's context: the `--output-last-message` file a `--json`
   * launch will name, and the private hermetic home a hermetic run needs.
   * Nothing is recorded on the adapter; the launcher owns the returned
   * context, so two launches through this singleton -- even two through
   * the same request object -- each carry their own.
   */
  override prepareRun(request: RunRequest, sandboxTrust?: ScodeTrustLevel): RunContext {
    const context: RunContext = {};
    const override = this.validatedProvider();
    if (request.hermetic) {
      // One home per run, never shared: a previous run's files or refreshed
      // login state must not reach the next one. hermetic-home.ts tracks
      // live homes itself (signal handling, the exit sweep), so the context
      // holds the home as plain data and the adapter holds nothing. An
      // override run never links the operator's auth.json either — the
      // provider key is the credential — so the home starts empty and holds
      // only the override's config.toml, written below.
      context.hermeticHome = createCodexHermeticHome(
        this.realCodexHome(request),
        this.apiKeyAuth() || override !== null
      );
      if (override !== null) {
        writeCodexProviderConfigInto(
          context.hermeticHome.codexHome,
          override,
          this.modelFor(request.model)!,
          readCodexMultiAgent(this.environment)
        );
      }
    } else if (override !== null) {
      // The plain-run variant of the same rule: one private CODEX_HOME per
      // launch, owned by the run and finalized in cleanupRun (and swept, by
      // the age-gated rule the hermetic homes use, only once it is stale and
      // its owning process is gone — codex-provider.ts).
      context.codexProviderHome = writeCodexProviderConfig(
        this.realCodexHome(request),
        override,
        this.modelFor(request.model)!,
        readCodexMultiAgent(this.environment)
      );
    }
    // The plain run's streaming fold (review ul4's rule, the opencode
    // shape): the launcher feeds the `--json` event stream through it
    // instead of capturing it whole, so an agentic run's tool output
    // cannot fill the capture bound, and processRunResult reads the folded
    // reply and usage back off the same object. A --result-json run
    // captures the stream whole and reduces it to the envelope, as before.
    if (!request.resultJson) {
      context.stdoutSink = new CodexPlainFold();
    }
    // The --output-last-message file of THIS run, on every launch that can
    // have one (round al29 restores the plain run's file, scoped by the
    // verdict to the Plan-only turn alone — plain-unwrap.ts's
    // CodexPlanFallbackRead — where the recorded message is the reply's
    // only carrier), placed where the child can write it and the
    // parent can read it back: scode keeps harness state writable on
    // every platform and never shadows it, unlike the OS temp root, which
    // its Linux sandbox replaces with a fresh /tmp the parent never sees.
    // Under hermetic the file lives inside the private home (itself under
    // the real CODEX_HOME), and finalize removes it with the home;
    // otherwise it gets a per-run directory under `.codemux-scratch/` in
    // the real CODEX_HOME, so two runs never see each other's message, and
    // prepareRunDirParent sweeps directories a dead codemux left behind.
    // An untrusted sandbox denies harness state -- no location is both
    // writable by the child and readable by the parent -- so that run
    // passes no file at all and the event stream is the result's only
    // source; a Plan-only turn then reports a null result on
    // `--result-json` and succeeds empty on a plain run, the documented
    // costs (README).
    // Hermetic runs keep their file whatever the
    // trust: an untrusted sandbox denies the private home itself, so the
    // fallback is not what decides that run.
    // processRunResult removes the file once read; cleanupRun removes the
    // directory.
    // prepareRun creates the home above whenever request.hermetic is set,
    // so a home here is the hermetic case; a hermetic run that somehow has
    // none fails closed at getRunEnv before anything launches.
    {
      const home = context.hermeticHome;
      if (home !== undefined) {
        context.lastMessagePath = join(home.home, LAST_MESSAGE_BASENAME);
      } else if (sandboxTrust !== "untrusted") {
        try {
          const scratchParent = prepareRunDirParent(
            this.realCodexHome(request),
            SCRATCH_PARENT_DIR_NAME
          );
          context.lastMessageDir = mkdtempSync(
            join(scratchParent, `run-${process.pid}-`)
          );
          context.lastMessagePath = join(
            context.lastMessageDir,
            LAST_MESSAGE_BASENAME
          );
        } catch (error) {
          // Round al24 (edges minor): a scratch step that throws must not
          // orphan what the context already holds. The provider-override
          // home (or a hermetic home) was created above, and this throw
          // means the caller never receives the context — cleanupRun
          // cannot run — so the home and its process-exit listener would
          // sit until termination, one per failed launch. Finalize what
          // the context holds here, then let the failure through.
          this.cleanupRun(context);
          throw error;
        }
      }
    }
    return context;
  }

  override cleanupRunSync(context?: RunContext): void {
    // A launch that rejects (a captured stdout that is not UTF-8, say) can
    // reject after codex already wrote its --output-last-message file, and
    // processRunResult's read-and-remove never runs: without this path the
    // model output in that file would outlive the run, so the per-run
    // directory under the real CODEX_HOME's `.codemux-scratch/` goes with
    // it. A hermetic run needs no separate removal -- the file lives inside
    // the private home, which dies with the run below (it holds a link to
    // the real login, and a run that never launched needs none of it). An
    // untrusted run carries neither piece of state and returns above.
    if (
      context?.lastMessageDir === undefined &&
      context?.hermeticHome === undefined &&
      context?.codexProviderHome === undefined
    ) {
      return;
    }
    if (context.lastMessageDir !== undefined) {
      // The same revalidation the result reader applies
      // (readFinalMessageFallback): a run with write access to ~/.codex could
      // have replaced `.codemux-scratch` with a symlink after prepareRun made
      // it, and the recursive removal resolves that intermediate component
      // like any path operation would -- following the link into a directory
      // codemux never chose, outside the sandbox. rm does not follow a symlink
      // at the run directory's own name (it removes the link), so the parent
      // is the one component to check. A parent that fails keeps its
      // directory: the refusal says so, the reader's wording, and the launch's
      // own rejection stays the failure the caller needs.
      let parentTrusted = true;
      try {
        assertTrustedDirectory(dirname(context.lastMessageDir));
      } catch (error) {
        parentTrusted = false;
        console.error(
          "codemux: refusing to remove codex's --output-last-message directory: " +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (parentTrusted) {
        try {
          rmSync(context.lastMessageDir, { recursive: true, force: true });
        } catch (error) {
          // A cleanup that cannot remove the directory says so and stays out
          // of its way.
          console.error(
            "codemux: could not remove codex's --output-last-message directory: " +
              `${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
    try {
      context.hermeticHome?.finalize();
    } catch (error) {
      console.error(
        "codemux: could not remove codex's private hermetic home: " +
          `${error instanceof Error ? error.message : String(error)}`
        );
    }
    try {
      // A hermetic override run has no codexProviderHome — its config rides
      // the hermetic home above — so this finalizes exactly the plain-run
      // home this launch created.
      context.codexProviderHome?.finalize();
    } catch (error) {
      console.error(
        "codemux: could not remove codex's provider-override home: " +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  override getRunEnv(request: RunRequest, context?: RunContext): Record<string, string> {
    // Both launch paths call this right before spawning; a static preview
    // never does. The placeholder home in buildRunCommand fails closed on
    // Codex's side, and this is the codemux-side guarantee.
    if (request.hermetic && context?.hermeticHome === undefined) {
      throw new Error("codex hermetic home was not prepared before launch");
    }
    const override = this.validatedProvider();
    if (override === null) return {};
    if (!request.hermetic && context?.codexProviderHome === undefined) {
      throw new Error("codex provider config was not prepared before launch");
    }
    // The key the config.toml's env_key names, delivered through the
    // environment codemux provides: never argv, never an operator file, and
    // immune to the sanitizer because it is adapter-provided.
    return { [CODEX_PROVIDER_KEY_ENV]: override.apiKey };
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    // The passed-through CODEX_HOME is checked exactly as the child reads
    // it here (the round10/round13 rule), before prepareRun creates the
    // run's `.codemux-scratch/` directory under it: validation owns the
    // refusal, so a value the run would refuse never touches disk.
    this.realCodexHome(request);
    // Fail before launch on a half-configured override and surface the model
    // requirement early (validatedProvider's output-cap refusal is reached
    // through the same call): the config.toml cannot be written without
    // both, and a run that reached prepareRun would die mid-write.
    this.modelFor(request.model);
    const cwd = validateWorkingDirectory(request.cwd) ?? process.cwd();
    assertNoCodexProjectExecutionConfig(cwd);
    if (request.hermetic) {
      assertNoCodexProjectSkills(cwd, this.effectiveHome());
    }
    if (request.tools === "none" && (request.autonomy ?? "read-only") !== "read-only") {
      throw new Error(
        "codex cannot remove its apply_patch tool; --tools none needs --auto read-only, " +
          "where the sandbox denies writes to the working directory"
      );
    }
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
    assertNoCodexProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
    // The private CODEX_HOME's lifecycle rides prepareRun, which only the
    // headless launch path calls; an interactive session has no hook to
    // write and remove the override's config.toml, and pointing one at the
    // operator's real CODEX_HOME would mean writing codemux's provider
    // table into the operator's config.
    if (this.validatedProvider() !== null) {
      throw new Error(
        "the codex provider override supports headless runs only; unset CODEMUX_CODEX_PROVIDER_* for an interactive session"
      );
    }
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  override processRunResult(
    result: RunResult,
    request: RunRequest,
    context?: RunContext
  ): RunResult {
    if (!request.resultJson) {
      // A plain run streamed its `--json` events through the fold
      // prepareRun hung on the context; the verdict reproduces human
      // mode's stdout on every shape whose bytes the wire can carry (the
      // final assistant message of a completed turn — kept even when codex
      // then exits nonzero; nothing for a turn that never completed) and
      // succeeds with empty stdout for the one shape whose bytes it cannot
      // (a completed turn with no message anywhere; round al10), and the
      // receipt's usage is the stream's full block, not the blended
      // stderr figure. A caller holding captured stdout without a context
      // folds it whole through the same verdict; a hatch run -- stdout
      // that is not the wire at all -- passes through verbatim with the
      // stderr figure as before (plain-unwrap.ts). Round al29: the plain
      // run names a --output-last-message file again, read (and removed)
      // HERE before the verdict runs — the file must not outlive the run
      // that wrote it — and handed over as the bounded thunk the verdict
      // consults only for a completed messageless turn (the Plan-only
      // shape; CodexPlanFallbackRead): a stream that carried the reply,
      // failed, or never completed answers from the stream alone, exactly
      // as it did before the file existed. A launch that named no file
      // (the untrusted sandbox) reads `absent` and passes no thunk.
      const fallback = this.readFinalMessageFallback(context);
      const fallbackPath = context?.lastMessagePath ?? null;
      const planFallback: (() => CodexPlanFallbackRead) | undefined =
        fallback.outcome === "absent" || fallbackPath === null
          ? undefined
          : () => {
              if (fallback.outcome === "text") {
                return { outcome: "text", text: fallback.text };
              }
              // An empty file is upstream's messageless-turn record: text
              // of zero length, which the verdict's arm answers with the
              // empty reply human mode printed.
              if (fallback.outcome === "empty") {
                return { outcome: "text", text: "" };
              }
              // A named file that is not there is a write codex only
              // logged (round al34, edges major 2): the thunk carries it
              // as `missing` with the path, and the verdict fails the
              // completed messageless turn naming the unwritten file —
              // only a launch that named no file at all passes no thunk.
              if (fallback.outcome === "missing") {
                return { outcome: "missing", path: fallbackPath };
              }
              return { outcome: "unreadable", error: fallback.error };
            };
      const sink = context?.stdoutSink;
      if (sink instanceof CodexPlainFold) {
        return sink.verdict(result, planFallback);
      }
      return codexPlainStreamResult(result, planFallback);
    }
    // A --result-json run named a --output-last-message file: read (and
    // remove) it before the verdict runs, for whether or not the stream
    // needs it, the file must not outlive the run that wrote it. A read
    // that FAILED is not a message that is absent (round al18): the
    // verdict below reads a null fallback as an intentionally missing
    // message, so an unreadable file fails the run with its read error
    // instead of passing that failure in as the absent-message null.
    // Round al20: the failure is applied to the run BEFORE the verdict
    // builds its result, so it goes through the same failure
    // normalization as every other failed run -- the envelope path's
    // failed-envelope contract (null result, null usage) reads the
    // already-failed run, where serializing the verdict first kept a
    // successful envelope's result and usage beside success:false.
    // Round al29 (contracts minor): a NAMED file that is missing travels
    // as its own shape, so the messageless stream that needed it fails
    // naming the absent file — the README's documented rule — rather than
    // the generic no-message diagnostic.
    const fallback = this.readFinalMessageFallback(context);
    const fallbackText =
      fallback.outcome === "text"
        ? fallback.text
        : fallback.outcome === "missing" && context?.lastMessagePath !== undefined
        ? { missing: context.lastMessagePath }
        : null;
    const run =
      fallback.outcome === "unreadable"
        ? finalMessageReadFailure(result, fallback.error)
        : result;
    // The run was launched with --json, so stdout is the JSONL event stream
    // rather than the reply; codexResult builds the envelope --result-json
    // promises (result = final assistant message, codemux block = usage).
    // An override run's model rode the config.toml, never -m, so the request
    // may carry none while the run used one; resolve it the way prepareRun
    // did, so the envelope's model fallback (and the reroute note) sees the
    // model codemux actually selected.
    const override = this.validatedProvider();
    const effective =
      override === null ? request : { ...request, model: this.modelFor(request.model) };
    return codexResult(run, effective, fallbackText);
  }

  /**
   * Reads and removes this run's --output-last-message file, classifying
   * what the read produced (FinalMessageRead, the taxonomy documented at
   * the type): `absent` when this run launched without one (no context
   * path — an untrusted sandbox launch passes no file), `empty` when the
   * named file holds nothing (upstream's messageless-turn record), `text`
   * when it holds the recorded message verbatim, `missing` when the named
   * file is not there, and `unreadable` when the file cannot be safely
   * read — a permission error, an oversized or non-UTF-8 file, a refused
   * symlink at its name, or a directory holding it that is not a real
   * user-owned one (a swapped symlink, the check below). The classes stay
   * distinct (round al18): before it, every failed read collapsed into
   * the absent-message null, and the plain path's verdict — which
   * succeeds a completed turn with no message anywhere — passed a
   * Plan-only turn whose file was unreadable as a successful empty reply.
   * A message codemux cannot read must not quietly become the run's
   * result; now it fails the run outright — finalMessageReadFailure on
   * the envelope path, and the bounded thunk's unreadable arm on the
   * plain one (round al29).
   */
  private readFinalMessageFallback(context?: RunContext): FinalMessageRead {
    const path = context?.lastMessagePath ?? null;
    if (path === null) return { outcome: "absent" };
    // The noFollow below refuses a symlink at the file's own name only:
    // a compromised child could instead replace the directory holding the
    // file -- this run's per-run directory, or its `.codemux-scratch` /
    // `.codemux-hermetic` parent -- with a symlink, and both the read and
    // the removal would follow it into a directory codemux never chose,
    // outside the sandbox (an intermediate path component is followed
    // however the final one is opened, and Node has no dirfd-relative
    // open). The same lstat check prepareRunDirParent applied when it
    // created the parent refuses both directories first, so a swapped
    // directory loses the fallback with a warning rather than lending the
    // run -- and the delete -- a file it cannot vouch for.
    try {
      assertTrustedDirectory(dirname(path));
      assertTrustedDirectory(dirname(dirname(path)));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // One channel only (round al21, contracts-2 minor 6): on the
      // envelope path the refusal rides the run's stderr through
      // finalMessageReadFailure, which the CLI prints -- a console.error
      // here printed the same failure a second time on the terminal. On
      // the plain path (round al29) the unreadable outcome rides the
      // bounded thunk instead, failing only a completed messageless turn;
      // a stream that answered ignores it.
      return { outcome: "unreadable", error: `the read was refused (${detail})` };
    }
    let contents: FinalMessageRead = { outcome: "absent" };
    try {
      const read = readUtf8FileBounded(path, {
        maxBytes: MAX_FINAL_MESSAGE_BYTES,
        label: path,
        // The name is one this adapter just generated (in this run's
        // private per-run directory, or its private hermetic home), so a
        // link standing in its place is an attack on the run, not a path
        // codemux should follow.
        noFollow: true,
      });
      // The file IS the message, verbatim (round al26, correctness minor:
      // codex's writer is fs::write(path, message) with no newline of its
      // own, so a message ending in one keeps it — and the plain path's
      // println! spelling prints it back exactly). An empty file is
      // upstream's own messageless-turn record (the warning beside the
      // write), never a message; only a wholly absent file says the write
      // failed, and that is the `missing` arm below.
      contents = read.length === 0 ? { outcome: "empty" } : { outcome: "text", text: read };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Round al26 (correctness major): a launch that named this file
        // and a completed turn later found no file is a WRITE codex only
        // logged (upstream writes something for every completed turn — a
        // message, or the empty file plus its warning), so the absence is
        // its own outcome, never the intentional no-message null. Round
        // al29 routes it: the envelope path fails the messageless turn
        // naming the absent file (codexResult's missing arm), and round
        // al34 (edges major 2) aligned the plain path with it — the
        // thunk carries the outcome as CodexPlanFallbackRead's `missing`
        // arm with the path, and the verdict fails the turn naming the
        // unwritten file.
        contents = { outcome: "missing" };
      } else {
        const detail = error instanceof Error ? error.message : String(error);
        // Same single-channel rule as the refused read above: the error
        // rides the run's channels via finalMessageReadFailure (envelope)
        // or the bounded thunk (plain) alone.
        contents = { outcome: "unreadable", error: detail };
      }
    }
    try {
      rmSync(path, { force: true });
    } catch (error) {
      // Same rule as cleanupRun: a cleanup that cannot remove the file says
      // so and stays out of the run's way, so a finished run's result is
      // never replaced by a cleanup error.
      console.error(
        "codemux: could not remove codex's --output-last-message file: " +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
    return contents;
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    sandboxed = false
  ): string[] {
    const cmd = ["codex"];
    if (model) {
      cmd.push("-m", model);
    }
    if (sandboxed) {
      // codemux is already enforcing scode sandbox boundaries.
      cmd.push("--dangerously-bypass-approvals-and-sandbox");
    } else if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    if (effort) {
      cmd.push(...this.mapEffort(effort));
    }
    return cmd;
  }
}
