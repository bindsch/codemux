import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunContext } from "./base.js";
import { CodexPolicy } from "./codex-policy.js";
import {
  CODEX_EXPERIMENT_FLAGS,
  CODEX_HERMETIC_FLAGS,
  CODEX_NO_TOOLS_FLAGS,
  LAST_MESSAGE_BASENAME,
  SCRATCH_PARENT_DIR_NAME,
} from "./codex-flags.js";
import { processCodexRunResult } from "./codex-result.js";
import {
  assertTrustedDirectory,
  createCodexHermeticHome,
  prepareRunDirParent,
} from "../hermetic-home.js";
import {
  readCodexMultiAgent,
  writeCodexProviderConfig,
  writeCodexProviderConfigInto,
} from "../codex-provider.js";
import { readExperimentRunSpec } from "../experiment-mcp.js";
import { UsageRefusalError } from "../validation.js";
import { ExperimentCodexRun } from "../experiment-codex-run.js";
import { CodexPlainFold } from "../plain-unwrap.js";
import type { SandboxOptions, ScodeTrustLevel } from "../sandbox.js";
import type { AutonomyLevel, ReasoningEffort, RunRequest, RunResult , LaunchIntent } from "../types.js";
import { codexLoginState, loginHome, type LoginState } from "../harness-health.js";

export class CodexAdapter extends CodexPolicy {
  buildRunCommand(request: RunRequest, context?: RunContext): string[] {
    const cmd: string[] = [];
    const override = this.validatedProvider();

    if (request.hermetic) {
      // The private HOME reaches Codex through env(1), not through the
      // environment codemux hands to scode: scode derives its deny rules
      // for user files from HOME, so moving HOME for the whole
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
    if (request.experimentMcp) {
      cmd.push(...CODEX_EXPERIMENT_FLAGS);
    }

    const model = request.experimentMcp
      ? context?.experimentCodex?.model ?? this.experimentModel(request).model : request.model;
    if (model && override === null) {
      // On an override run the model rides the config.toml, never -m: the
      // two could disagree across a config rewrite, and one source is
      // checkable.
      cmd.push("-m", model);
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
    // Experiments need a rollout in the private home until verification.
    if (!request.experimentMcp) cmd.push("--ephemeral");
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
    if (request.hermetic && override === null && !request.experimentMcp) {
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
  override prepareRun(request: RunRequest, sandboxTrust?: ScodeTrustLevel, _sandboxOptions?: SandboxOptions, launch: LaunchIntent = {}): RunContext {
    const context: RunContext = {};
    const override = this.validatedProvider();
    const experimentModel = request.experimentMcp ? this.experimentModel(request) : undefined;
    if (request.hermetic) {
      // One home per run, never shared: a previous run's files or refreshed
      // login state must not reach the next one. hermetic-home.ts tracks
      // live homes itself (signal handling, the exit sweep), so the context
      // holds the home as plain data and the adapter holds nothing. An
      // override run never links the operator's auth.json either — the
      // provider key is the credential — so the home starts empty and holds
      // only the override's config.toml, written below.
      // A print-only launch needs the home path for its argv and no login:
      // the home starts empty, like an API-key run's (review round 55).
      context.hermeticHome = createCodexHermeticHome(
        this.realCodexHome(request),
        this.apiKeyAuth() || override !== null || launch.printOnly === true
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
          this.cleanupRunSync(context);
          throw error;
        }
      }
    }
    if (request.experimentMcp) {
      try {
        if (!context.hermeticHome) throw new UsageRefusalError("Codex experiment requires a private hermetic home");
        const experiment = new ExperimentCodexRun(readExperimentRunSpec(request),
          request.cwd ?? process.cwd(), context.hermeticHome.codexHome,
          Boolean(request.resultJson), this.environment, request.prompt, experimentModel,
          (path) => { context.experimentRecording = path; });
        context.experimentCodex = experiment;
        context.experimentRecording = experiment.startedRecordingPath;
        context.stdoutSink = experiment;
      } catch (error) {
        this.cleanupRunSync(context);
        throw error;
      }
    }
    return context;
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
      // (readFinalMessageFallback): a run with write access to Codex state could
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

  private cleanupExperimentHome(context: RunContext): void {
    const experiment = context.experimentCodex!;
    experiment.interruptBeforeEvidence();
    try {
      experiment.preserveHarnessLog();
      context.hermeticHome?.finalize();
    } catch (error) {
      if (experiment.startedRecordingPath) experiment.relay.fail(error);
      throw error;
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
    return processCodexRunResult(result, request, context, () =>
      this.validatedProvider() === null
        ? request
        : { ...request, model: this.modelFor(request.model) }
    );
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

  /** The codex login read: auth.json's mode and refresh-token presence. */
  override loginState(): LoginState {
    return codexLoginState(loginHome(this.environment), this.environment);
  }
}
