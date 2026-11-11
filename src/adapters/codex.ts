import { mkdtempSync } from "node:fs";
import { combinedCleanupFailure } from "../experiment-records.js";
import { join } from "node:path";
import { previewCodexRun } from "../codex-preview.js";
import type { RunContext } from "./base.js";
import { CodexPolicy } from "./codex-policy.js";
import {
  CODEX_EXPERIMENT_FLAGS,
  CODEX_HERMETIC_FLAGS,
  CODEX_NO_TOOLS_FLAGS,
  CODEX_PROJECT_SETTINGS_HERMETIC_FLAGS,
  LAST_MESSAGE_BASENAME,
  SCRATCH_PARENT_DIR_NAME,
} from "./codex-flags.js";
import { writeCodexProjectSettingsConfig } from "../codex-project-settings.js";
import { validateProjectSettingsRunRequest } from "../claude-project-settings.js";
import { processCodexRunResult } from "./codex-result.js";
import {
  createCodexHermeticHome,
  prepareRunDirParent,
} from "../hermetic-home.js";
import { recordTrustedParent, removeUnderTrustedParent } from "../safe-remove.js";
import {
  readCodexMultiAgent,
  writeCodexProviderConfig,
  writeCodexProviderConfigInto,
} from "../codex-provider.js";
import { readExperimentRunSpec } from "../experiment-mcp.js";
import { codexPlaywrightMcpOverrides } from "../codex-playwright-mcp.js";
import { codexNoToolsCatalogArgs, codexNoToolsCatalogBody, needsCodexNoToolsCatalog, prepareCodexNoToolsCatalog } from "../codex-no-tools.js";
import type { ExecutableCheck } from "../executable-security.js";
import { UsageRefusalError } from "../validation.js";
import { ExperimentCodexRun } from "../experiment-codex-run.js";
import { CodexCostFold, withCodexNativeCost } from "../codex-native-cost.js";
import { withStreamScanSurface } from "../stream-marker-scan.js";
import type { SandboxOptions, ScodeTrustLevel } from "../sandbox.js";
import type { AutonomyLevel, ReasoningEffort, RunRequest, RunResult , LaunchIntent } from "../types.js";
import { codexLoginState, loginHome, type LoginState } from "../harness-health.js";

export class CodexAdapter extends CodexPolicy {
  buildRunCommand(request: RunRequest, context?: RunContext): string[] {
    const cmd: string[] = [];
    const override = this.validatedProvider();

    if (request.hermetic) {
      // The private HOME rides env(1), not the environment codemux hands to
      // scode: scode derives its user-file deny rules from HOME, so moving
      // HOME for the whole launch would move the sandbox's protected paths
      // off the real home. A static preview's placeholder home does not
      // exist and Codex refuses a missing CODEX_HOME: fail closed.
      const unprepared = join(this.realCodexHome(request), ".codemux-hermetic", "unprepared");
      const home = context?.hermeticHome ?? {
        home: unprepared,
        codexHome: join(unprepared, ".codex"),
      };
      cmd.push("env", `HOME=${home.home}`, `CODEX_HOME=${home.codexHome}`);
    } else if (override !== null || request.experimentMcp) {
      // An override run gets a private CODEX_HOME holding only this run's
      // config.toml (codex-provider.ts), so the operator's config.toml and
      // auth.json are not read by construction. The experiment check's
      // control rides the same slot with its own private home (prepareRun).
      // Same fail-closed placeholder rule as the hermetic home.
      const unprepared = join(this.realCodexHome(request), ".codemux-provider", "unprepared");
      cmd.push("env", `CODEX_HOME=${context?.hermeticHome?.codexHome ?? context?.codexProviderHome?.codexHome ?? unprepared}`);
    }
    cmd.push("codex");

    if (request.hermetic) {
      // The project-settings mode keeps every account-surface disable but
      // drops the AGENTS.md suppression: the repository's instructions are
      // part of what the mode exists to load (the kimi arm's rule).
      cmd.push(...(request.experimentProjectSettings
        ? CODEX_PROJECT_SETTINGS_HERMETIC_FLAGS
        : CODEX_HERMETIC_FLAGS));
    }
    if (request.tools === "none") {
      cmd.push(...CODEX_NO_TOOLS_FLAGS);
      cmd.push(...codexNoToolsCatalogArgs(request, context, this.realCodexHome(request)));
    }
    if (request.experimentMcp) {
      cmd.push(...CODEX_EXPERIMENT_FLAGS);
      if (!request.hermetic) {
        // The check's control runs from its own private CODEX_HOME
        // (prepareRun), and the Keychain entry is keyed to the real
        // CODEX_HOME path (the hermetic flags' rule), so it reads the
        // linked auth.json through the file store like the probe does.
        cmd.push("-c", 'cli_auth_credentials_store="file"');
      }
    }
    // The Playwright server rides the -c config-override channel, the one
    // MCP carrier codex has (codex-playwright-mcp.ts); the shared build
    // attaches nothing unless the request is sandboxed and enabled.
    const playwright = codexPlaywrightMcpOverrides(request.sandboxed, {
      enabled: request.enablePlaywrightMcp,
      forbiddenRoot: request.cwd ?? process.cwd(),
      pathEnv: this.executionPathEnv(),
    });
    cmd.push(...playwright.overrides);
    if (context !== undefined) context.playwrightMcpCheck = playwright.check;

    const model = request.experimentMcp
      ? context?.experimentCodex?.model ?? this.experimentModel(request).model : request.model;
    if (model && override === null) {
      // On an override run the model rides the config.toml, never -m: the
      // two could disagree across a config rewrite, and one source is
      // checkable.
      cmd.push("-m", model);
    }

    if (request.sandboxed) {
      // codemux is already enforcing scode sandbox boundaries. A native
      // carrier exists for every level (`-s read-only` through `-s
      // danger-full-access`; codex 0.166.0 binary strings, read 2026-11-08)
      // and is deliberately not passed: codex's own seatbelt sandbox inside
      // scode's is nested sandboxing, blocked on macOS (the droid shell
      // probe, docs/harnesses.md), so the bypass flag leaves the level to
      // scode alone.
      cmd.push("--dangerously-bypass-approvals-and-sandbox");
    } else if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }

    if (request.effort) {
      cmd.push(...this.mapEffort(request.effort));
    }
    if (request.web === false) {
      // rust-v0.166.0 config.schema.json: web_search is WebSearchMode;
      // tools.web_search is an object for domains/location, not a mode.
      cmd.push("-c", 'web_search="disabled"');
    }

    cmd.push("exec", "--skip-git-repo-check");
    // Experiments need a rollout in the private home until verification.
    if (!request.experimentMcp) cmd.push("--ephemeral");
    cmd.push("--ignore-rules");
    // Events as JSONL on stdout (codex-rs exec lib.rs), on every run: the
    // ledger's usage and the reply both come from the stream. A plain run
    // never captures it whole (the ul3 capture-bound finding), so prepareRun
    // hangs a streaming fold on the context (plain-unwrap.ts) that keeps
    // reply text, usage, and served model while dropping tool output.
    cmd.push("--json");
    // Round al29: every run names a --output-last-message file — a Plan-only
    // turn's recorded final message is the reply's only carrier (the JSONL
    // wire does not carry it; plain-unwrap.ts reads it in one bounded arm).
    // prepareRun places it; the untrusted-sandbox and static-preview rules
    // are documented there.
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
    if (request.hermetic && override === null && !request.experimentMcp && !request.experimentProjectSettings) {
      // Belt and braces: the private CODEX_HOME holds no config.toml
      // anyway. Override and project-settings runs are the exceptions —
      // `--ignore-user-config` skips "$CODEX_HOME/config.toml" itself
      // (0.160 help), where each mode's carrier lives — so neither passes it.
      cmd.push("--ignore-user-config");
    }
    cmd.push("-");

    return cmd;
  }

  /**
   * Whether the run authenticates with an API key. Only the variable Codex
   * itself reads counts (CODEX_API_KEY at 0.154): a hermetic run must use
   * the same credential a plain run would, never a stray OPENAI_API_KEY.
   */
  private apiKeyAuth(): boolean {
    return Boolean(this.environment.CODEX_API_KEY?.trim());
  }

  /** Builds this run's context: the last-message file a `--json` launch
   * names, the private hermetic home a hermetic run needs, and the
   * experiment bridge. Nothing is recorded on the adapter; the launcher
   * owns the returned context. */
  override prepareRun(request: RunRequest, sandboxTrust?: ScodeTrustLevel, _sandboxOptions?: SandboxOptions, launch: LaunchIntent = {}): RunContext {
    if (launch.printOnly && request.experimentMcp) throw new UsageRefusalError("Codex experiment MCP cannot be prepared for a print-only preview");
    const context: RunContext = {};
    const override = this.validatedProvider();
    const experimentModel = request.experimentMcp ? this.experimentModel(request) : undefined;
    const toolCatalog = needsCodexNoToolsCatalog(request)
      ? codexNoToolsCatalogBody(this.modelFor(request.model), this.realCodexHome(request)) : undefined;
    if (launch.printOnly) return previewCodexRun(request, this.realCodexHome(request), override !== null, sandboxTrust, toolCatalog);
    if (request.hermetic) {
      // The project-settings mode's gates run before any home is created:
      // a refused request must not leave a private home behind (the kimi
      // arm's rule).
      if (request.experimentProjectSettings) {
        validateProjectSettingsRunRequest(request);
      }
      // One home per run, never shared: a previous run's files or refreshed
      // login state must not reach the next one. hermetic-home.ts tracks
      // live homes itself, so the context holds the home as plain data. An
      // override run never links the operator's auth.json (the provider key
      // is the credential), so its home starts empty.
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
      if (request.experimentProjectSettings) {
        writeCodexProjectSettingsConfig(context.hermeticHome.codexHome, request.cwd ?? process.cwd(), override !== null);
      }
    } else if (override !== null) {
      // The plain-run variant of the same rule: one private CODEX_HOME per
      // launch, owned by the run, finalized in cleanupRun, and swept by the
      // age-gated rule the hermetic homes use (codex-provider.ts).
      context.codexProviderHome = writeCodexProviderConfig(
        this.realCodexHome(request),
        override,
        this.modelFor(request.model)!,
        readCodexMultiAgent(this.environment)
      );
    }
    // The plain run's streaming fold (review ul4's rule, the opencode
    // shape): the launcher feeds the `--json` event stream through it
    // instead of capturing it whole, so tool output cannot fill the capture
    // bound, and processRunResult reads the folded reply and usage back off
    // the same object. A --result-json run captures the stream whole.
    if (!request.resultJson) {
      context.stdoutSink = new CodexCostFold();
    }
    // The reply file and optional model catalog share launch-owned state.
    // scode preserves harness state on every platform; its temporary root
    // is private to the child. Untrusted mode denies harness state, so it
    // carries neither file. The existing finalizers remove both files.
    {
      const home = context.hermeticHome;
      if (home !== undefined) {
        context.lastMessagePath = join(home.home, LAST_MESSAGE_BASENAME);
      } else if (sandboxTrust !== "untrusted") {
        try {
          const scratchParent = prepareRunDirParent(this.realCodexHome(request), SCRATCH_PARENT_DIR_NAME);
          // Recorded at creation for the cleanup's revalidation
          // (src/safe-remove.ts, round 104): a codex child can write
          // CODEX_HOME, so the parent could be swapped after creation.
          context.lastMessageParentRecord = recordTrustedParent(scratchParent);
          context.lastMessageDir = mkdtempSync(
            join(scratchParent, `run-${process.pid}-`)
          );
          context.lastMessagePath = join(
            context.lastMessageDir,
            LAST_MESSAGE_BASENAME
          );
        } catch (error) {
          // Round al24: a scratch step that throws must not orphan what the
          // context holds — the caller never receives the context, so
          // cleanupRun cannot run. Finalize here, then let the failure
          // through.
          this.cleanupOnPrepareFailure(context, error);
          throw error;
        }
      }
    }
    if (toolCatalog !== undefined) {
      try { prepareCodexNoToolsCatalog(context, toolCatalog, sandboxTrust); }
      catch (error) { this.cleanupOnPrepareFailure(context, error); throw error; }
    }
    if (request.experimentMcp) {
      try {
        const spec = readExperimentRunSpec(request);
        if (context.hermeticHome === undefined) {
          // Only the check's paired control reaches here: a deliberate
          // non-hermetic launch (spec.control, experiment-mcp.ts). The
          // relay's config.toml still gets a private per-launch CODEX_HOME —
          // never a merge into the operator's config — linked to the login
          // a plain run uses: opening every channel is the control's job.
          if (!spec.control) throw new UsageRefusalError("Codex experiment requires a private hermetic home");
          context.hermeticHome = createCodexHermeticHome(
            this.realCodexHome(request),
            this.apiKeyAuth()
          );
        }
        const experiment = new ExperimentCodexRun(spec,
          request.cwd ?? process.cwd(), context.hermeticHome.codexHome,
          Boolean(request.resultJson), this.environment, request.prompt, experimentModel,
          (path) => { context.experimentRecording = path; });
        context.experimentCodex = experiment;
        context.experimentRecording = experiment.startedRecordingPath;
        context.stdoutSink = experiment;
      } catch (error) {
        // The same rule as the scratch catch above (review round 313): a
        // cleanup failure rides the setup error's message.
        this.cleanupOnPrepareFailure(context, error);
        throw error;
      }
    }
    return context;
  }

  /** A prepare step that throws after the context holds state: finalize
   * what it holds (the caller never received it, so cleanupRun cannot
   * run), letting the original failure through; a finalizer failure rides
   * its message instead of replacing it (rounds al24, 307, 313). */
  private cleanupOnPrepareFailure(context: RunContext, error: unknown): void {
    try {
      this.cleanupRunSync(context);
    } catch (cleanupError) {
      if (error instanceof Error) {
        error.message += `; cleanup failed: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`;
      }
    }
  }

  override cleanupRun(context?: RunContext): void | Promise<void> {
    if (context?.experimentCodex) {
      const experiment = context.experimentCodex;
      const verified = experiment.hasEvidence ? experiment.verify() : Promise.resolve();
      return verified.finally(() => this.cleanupExperimentHome(context)).finally(() => experiment.close());
    }
    this.cleanupRunSync(context);
  }

  override cleanupRunSync(context?: RunContext): void {
    if (context?.experimentCodex) {
      try { this.cleanupExperimentHome(context); }
      finally { context.experimentCodex.closeSync(); }
      return;
    }
    // A launch that rejects can reject after codex already wrote its
    // --output-last-message file, and processRunResult's read-and-remove
    // never runs: without this path the model output would outlive the
    // run. A hermetic run needs no separate removal — the file lives
    // inside the private home, which dies with the run below. An untrusted
    // run carries neither piece of state and returns above.
    if (
      context?.lastMessageDir === undefined &&
      context?.hermeticHome === undefined &&
      context?.codexProviderHome === undefined
    ) {
      return;
    }
    if (context.lastMessageDir !== undefined) {
      // The same revalidation the result reader applies, by the identity
      // recorded when the directory was made (src/safe-remove.ts, round
      // 104): a run with write access to Codex state could have replaced
      // `.codemux-scratch` with a symlink — or another directory — after
      // prepareRun made it, and the recursive removal would follow the link
      // outside the sandbox. rm does not follow a symlink at the run
      // directory's own name, so the parent is the component to check. A
      // parent that fails keeps its directory.
      const record = context.lastMessageParentRecord;
      if (record === undefined) {
        // Cannot happen: both fields are set together in prepareRun. Kept
        // as a refusal anyway: an unchecked removal is worse than a kept
        // directory.
        console.error(
          "codemux: refusing to remove codex's --output-last-message directory: " +
            "no trusted parent was recorded at creation"
        );
      } else {
        removeUnderTrustedParent(
          context.lastMessageDir,
          record,
          `codex's --output-last-message directory ${context.lastMessageDir}`
        );
      }
    }
    // Both homes finalize even when one fails, and a failure reaches the
    // caller (base.ts's contract): per-run state — model output, copied
    // credentials, provider configuration — cannot outlive the run
    // unnoticed (round 307; the catches used to print and swallow it). The
    // exit backstop and the homes' own exit hooks keep the retry they own.
    const failures: unknown[] = [];
    try {
      context.hermeticHome?.finalize();
    } catch (error) {
      failures.push(error);
    }
    try {
      // A hermetic override run has no codexProviderHome — its config rides
      // the hermetic home above — so this finalizes exactly the plain-run
      // home this launch created (the experiment control home rides the
      // hermeticHome slot the same way).
      context.codexProviderHome?.finalize();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `codemux: codex cleanup failed ${failures.length} times: ${failures
          .map((failure) => failure instanceof Error ? failure.message : String(failure))
          .join("; ")}`
      );
    }
  }

  private cleanupExperimentHome(context: RunContext): void {
    const experiment = context.experimentCodex!;
    experiment.interruptBeforeEvidence();
    // The private home holds copied credentials and configuration, so it
    // is finalized even when evidence preservation fails: a full or
    // unwritable recording destination must not leave per-run state
    // behind (round 64). One failure rethrows as itself, several as one
    // combined failure naming each.
    const failures: unknown[] = [];
    try {
      experiment.preserveHarnessLog();
    } catch (error) {
      failures.push(error);
    }
    try {
      context.hermeticHome?.finalize();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      // The relay latches its first failure, so several are relayed as
      // one error whose message names each of them (review round 69).
      const failure = combinedCleanupFailure(failures);
      if (experiment.startedRecordingPath) experiment.relay.fail(failure);
      throw failure;
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
    // The fold dropped every item event (tool output); the hermetic check
    // scans its marker evidence beside the answer (stream-marker-scan.ts).
    return withStreamScanSurface(withCodexNativeCost(processCodexRunResult(result, request, context, () =>
      this.validatedProvider() === null
        ? request
        : { ...request, model: this.modelFor(request.model) }
    ), request, context), result.stdout, context?.experimentCodex?.fold ?? context?.stdoutSink);
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    sandboxed = false,
    enablePlaywrightMcp = false,
    cwd?: string,
    nestedChecks?: ExecutableCheck[]
  ): string[] {
    const cmd = ["codex"];
    // On an override launch the model rides the config.toml, never -m (the run path's rule).
    if (model && this.validatedProvider() === null) {
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
    // The Playwright server rides the same -c override the run path
    // passes (codex-playwright-mcp.ts): interactive codex reads the same
    // mcp_servers config. The check rides nestedChecks for the spawn's
    // re-stat (the claude TUI's rule).
    const playwright = codexPlaywrightMcpOverrides(sandboxed, {
      enabled: enablePlaywrightMcp,
      forbiddenRoot: cwd ?? process.cwd(),
      pathEnv: this.executionPathEnv(),
    });
    cmd.push(...playwright.overrides);
    if (playwright.check !== null) nestedChecks?.push(playwright.check);
    return cmd;
  }

  /** The codex login read: auth.json's mode and refresh-token presence. */
  override loginState(): LoginState {
    return codexLoginState(loginHome(this.environment), this.environment);
  }
}
