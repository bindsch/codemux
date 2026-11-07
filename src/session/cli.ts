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
import type { ProjectSettingsSessionDir } from "../claude-project-config.js";
import type { CodexSessionProviderHome } from "../codex-provider.js";
import type { CodemuxConfig } from "../types.js";
import { exitOnResumeRefusal, exitWithCode } from "./cli-usage.js";
import { registerSessionOptions } from "./cli-options.js";
import { cleanupAfterSpawnThrow, exitPrintedSandbox, handleSessionAbort, removeFinalProjectDir } from "./cli-exit.js";
import { resolveSessionRequest } from "./cli-request.js";
import { resolveSessionContext } from "./cli-resume.js";
import { prepareSessionLaunch } from "./cli-launch.js";
import { prepareSessionChild } from "./cli-spawn-prep.js";
import { createSessionDriver } from "./cli-drivers.js";
import { frameCallerStdin } from "./stdin-frame.js";
import type { SessionDriver } from "./stdin-frame.js";
import type { SessionProcess } from "./process.js";
import {
  claimForResume,
  discardUnconfirmedRecord,
  probeRegistryForStart,
  releaseSessionRecord,
} from "./registry.js";
import { spawnSessionChild } from "./spawn.js";
import { UsageRefusalError } from "../validation.js";

// The modules the action is split into, re-exported so this path keeps
// every public symbol importable (readRegistry and friends live in
// session/registry.ts, not here).
export { SESSION_AGENTS } from "./cli-agents.js";
export { claudeFamilyHarnessHome } from "./cli-homes.js";
export { frameCallerStdin } from "./stdin-frame.js";
export type { FramedInput } from "./stdin-frame.js";

export function registerSessionCommand(
  program: Command,
  config: CodemuxConfig,
  requireValidConfig: () => void
): void {
  const session = program
    .command("session")
    .description("Start or resume a live agent session (JSONL events on stdout, JSONL input on stdin)");
  // Every option row lives in cli-options.ts, one registration shared by
  // nothing else; the action below stays with the state it manages.
  registerSessionOptions(session, config.defaultAgent);
  session.action(async (options) => {
      // Session-scoped state the CATCH below must reach: block-scoped
      // locals inside the try are invisible in its catch clause (a
      // sibling scope), so these live outside both — the codex override
      // session home, abandoned on any exit that never reached the
      // spawn (review D5), the project-settings session's private config
      // directory (same rule), and whether that spawn began.
      let codexSessionHome: CodexSessionProviderHome | null = null;
      let sessionProjectDir: ProjectSettingsSessionDir | null = null;
      let sessionProjectDirResumed = false;
      const spawnBegan = { value: false };
      // The record this process owns from the resume claim or a fresh
      // start record until the spawn, with its release rule (fresh and
      // unconfirmed is discarded, a claimed one is stamped ended). The
      // CATCH below reaches this so the claim is always released on the
      // way out (round 13, edges 3).
      let owned: { registryPath: string; id: string; fresh: boolean } | null = null;
      // An abort release never stamps final: the end path alone writes
      // it, after the private directory was removed (round 16, edges 1),
      // so a claim released before that leaves a directory it never
      // removed resumable, not refusing every later resume as final.
      const releaseOwnedRecord = (): void => {
        if (owned === null) return;
        if (owned.fresh) discardUnconfirmedRecord(owned.registryPath, owned.id);
        else releaseSessionRecord(owned.registryPath, owned.id, false);
      };
      // The driver, once built: its constructor installs the session's
      // signal handlers, so an exit decided after that point and before
      // the spawn (a lost resume claim, a registry that cannot record)
      // disposes it on the way out instead of leaving the handlers behind.
      let builtDriver: SessionDriver | null = null;
      /** Aborting removes only a FRESH private directory (its record was
       * never confirmed); a resumed one stays — that removal is the end
       * path's (round 17, edges 1). */
      const abandonSessionProjectDir = (): void => {
        if (sessionProjectDir !== null && !sessionProjectDirResumed) {
          sessionProjectDir.remove();
        }
      };
      try {
        requireValidConfig();
        // Registered so the flag is refused by name (exit 64) instead of
        // commander's generic parse error (exit 1): a session spawns
        // several children per turn, so scode's per-run accounting file has
        // no single stream to append to here.
        if (options.sandboxAccount !== undefined || options.sandboxAccountId !== undefined) {
          throw new UsageRefusalError(
            "--sandbox-account and --sandbox-account-id are not supported for sessions: the per-turn agents spawn several children with no single accounting stream; use run or tui"
          );
        }
        // Registered so the flag is refused by name (exit 64) instead of
        // commander's generic parse error (exit 1): Claude Code's own flag
        // works with --print only, so a multi-turn session cannot carry it,
        // whatever the agent.
        if (options.maxBudgetUsd !== undefined) {
          throw new UsageRefusalError(
            "--max-budget-usd is not supported for sessions: Claude Code applies the spend limit to headless runs only; use run"
          );
        }
        const {
          agentId,
          sessionSupport,
          adapter,
          override,
          requestedAutonomy,
          passthroughEnv,
          enablePlaywrightMcp,
          experimentProjectSettings,
          sandboxOptions,
          sandboxTrust,
          sandboxNoNet,
          sandboxScrubEnv,
          sandboxBlock,
          sessionTimeoutMs,
          turnTimeoutMs,
          permissionTimeoutMs,
          shutdownGraceMs,
          model,
          autonomy,
          effort,
          workdir,
          runLike,
        } = resolveSessionRequest(options, config);
        const {
          registryPath,
          codexHome,
          codexOverride,
          resumeId,
          claudeSessionId,
          harnessHome,
          providerBaseUrl,
          resumeProbe,
        } = resolveSessionContext({
          options,
          agentId,
          sessionSupport,
          override,
          autonomy,
          passthroughEnv,
          enablePlaywrightMcp,
          experimentProjectSettings,
          sandboxTrust,
          sandboxNoNet,
          sandboxScrubEnv,
          sandboxBlock,
          workdir,
        });
        // The same --final predicate the driver options carry
        // (cli-drivers.ts): the end path alone stamps the record final,
        // and only after it removed the private directory (review round
        // 10, edges 4; round 16, edges 1).
        const finalSession = Boolean(options.final) && experimentProjectSettings;
        // A print-only invocation records NOTHING (round 17, edges 2; cli-spawn-prep.ts has the story).
        const printOnly = Boolean(options.printSandbox);
        if (resumeId !== undefined && !printOnly) {
          // The ownership claim, under the writer lock and BEFORE the
          // launch preparation opens anything keyed by the record (round
          // 13, edges 3): between that open and a later claim another
          // codemux process's sweep — every prepareRunDirParent fires one —
          // read the still-unclaimed record as `free` and removed a
          // directory two days quiet, so the claimed resume launched
          // without its transcript. Claimed first, the record reads `held`
          // in every process by the time anything opens it. A concurrent
          // resume of the same id is refused before its harness can act on
          // any caller input (review live19), exiting having opened
          // nothing; a later refusal inside the preparation (the quota
          // gate, the harness floor) throws to the catch below, which
          // releases this claim on the way out.
          const claimed = claimForResume(registryPath, resumeId, resumeProbe);
          exitOnResumeRefusal(resumeId, registryPath, claimed);
          owned = { registryPath, id: resumeId, fresh: false };
        }
        const launch = await prepareSessionLaunch({
          options,
          config,
          agentId,
          adapter,
          sessionSupport,
          override,
          autonomy,
          effort,
          model,
          workdir,
          passthroughEnv,
          enablePlaywrightMcp,
          experimentProjectSettings,
          sandboxOptions,
          sandboxTrust,
          claudeSessionId,
          resumeId,
          codexHome,
          codexOverride,
          runLike,
        });
        // The session homes the catch below must reach: bound to the
        // action-scoped state before the spawn-prep phase, whose
        // --print-sandbox exit abandons a fresh directory through them.
        codexSessionHome = launch.codexSessionHome;
        sessionProjectDir = launch.sessionProjectDir;
        sessionProjectDirResumed = launch.sessionProjectDirResumed;
        const {
          needsKeepEnvPreflight,
          buildSessionEnvironment,
          claudeFamilyAgent,
          claudeBuilt,
          turnPerProcess,
        } = launch;
        const { argv, buildLongLivedEnvironment, printedSandbox } =
          await prepareSessionChild({
            options,
            agentId,
            adapter,
            override,
            runLike,
            resumeId,
            model,
            autonomy,
            effort,
            workdir,
            requestedAutonomy,
            sandboxOptions,
            claudeBuilt,
            codexSessionHome,
            sessionProjectDir,
            turnPerProcess,
            needsKeepEnvPreflight,
            buildSessionEnvironment,
          });
        if (printedSandbox) {
          exitPrintedSandbox({
            codexSessionHome,
            finalFlag: Boolean(options.final),
            sessionProjectDir,
            sessionProjectDirResumed,
            releaseOwnedRecord,
          });
          return;
        }
        const { driver, claudeDriver, aiderDriver, aiderSessionId, turnState } =
          createSessionDriver({
            options,
            agentId,
            adapter,
            override,
            codexHome,
            codexOverride,
            codexSessionHome,
            resumeId,
            claudeFamilyAgent,
            claudeBuilt,
            model,
            autonomy,
            effort,
            workdir,
            passthroughEnv,
            enablePlaywrightMcp,
            experimentProjectSettings,
            sandboxTrust,
            sandboxNoNet,
            sandboxScrubEnv,
            sandboxBlock,
            permissionTimeoutMs,
            turnTimeoutMs,
            sessionTimeoutMs,
            shutdownGraceMs,
            requestedAutonomy,
            sandboxOptions,
            runLike,
            registryPath,
            harnessHome,
            providerBaseUrl,
            buildSessionEnvironment,
            removeFinalProjectDir: () => removeFinalProjectDir(sessionProjectDir),
          });
        builtDriver = driver;
        if (resumeId !== undefined) {
          // The claim was taken ahead of the launch preparation (see
          // above); the driver, built only now, is told about it so its
          // recordSessionStart updates this process's record in place and
          // its every end path stamps `ended`.
          driver.adoptResumeClaim();
        }
        if (resumeId === undefined && (agentId === "agy" || agentId === "opencode" || agentId === "kimi")) {
          // agy, opencode, and kimi name a fresh conversation only in
          // their first turn's output (kimi's resume hint is that turn's
          // last line), so that turn runs before the record can exist;
          // the registry is proven writable first (review live22). Fresh
          // sessions only: a resume's claim just wrote the same file, and
          // a failing probe here would otherwise exit past the claim's
          // release (round 31, contracts 1).
          const probe = probeRegistryForStart(registryPath);
          if (!probe.ok) {
            releaseOwnedRecord();
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
            // The private config directory of a session that never
            // recorded is an orphan: nothing will ever resume it. Removed
            // BEFORE the release (review round 10, edges 4); the release
            // itself stamps nothing final (round 16, edges 1).
            abandonSessionProjectDir();
            releaseOwnedRecord();
            exitWithCode(1, `cannot record the session in the registry: ${failure} (registry: ${registryPath})`);
          }
          if (owned === null) {
            owned = { registryPath, id: claudeBuilt.sessionId, fresh: true };
          }
        }
        if (aiderDriver !== null && aiderSessionId !== null) {
          // The same pre-spawn record for the other codemux-owned
          // identity: the fresh session's history file and the start
          // record are in place before anything spawns; a resume rewrites
          // only the record, never the history.
          const failure = aiderDriver.recordBeforeSpawn();
          if (failure !== null) {
            releaseOwnedRecord();
            // A fresh session's history directory was just created ahead
            // of this record; with the record failed, nothing points at
            // it, so remove it now rather than orphan it to the 28-day
            // sweep (review D2, correctness-2 3). No-op on a resume.
            aiderDriver.removeFreshHistory();
            exitWithCode(1, `cannot record the session in the registry: ${failure} (registry: ${registryPath})`);
          }
          if (owned === null) {
            owned = { registryPath, id: aiderSessionId, fresh: true };
          }
        }
        let proc: SessionProcess | null = null;
        if (argv !== null) {
          spawnBegan.value = true;
          // A signal during the spawn's preflight starts the end path
          // with no child; spawnPending holds the end path — the --final
          // removal on the claude family, the resume-record release and
          // session_ended on every long-lived child — until the child
          // this spawn produces settles (round 18, edges 1; round 64).
          driver.spawnPending?.();
          try {
            // The session home's config.toml, written only now — after
            // the claim, before anything spawns (review D5, correctness
            // 3): a racing second resume refused `session_busy` above
            // never rewrote the live session's config. A throw here
            // takes the catch's abandon-and-release path like any spawn
            // failure.
            codexSessionHome?.prepareConfig();
            // The long-lived child's environment, built at the same
            // post-claim position: its getRunEnv copies the credential
            // mirror into the session's private config directory, and a
            // resume that lost the claim — or printed only — must write
            // nothing there (review round 3, edges finding on the claim
            // order).
            const { env, longLivedSandboxOptions } = buildLongLivedEnvironment();
            if (env === null) throw new Error("the long-lived session child has no environment");
            proc = await spawnSessionChild(argv, env, {
              cwd: workdir,
              sandboxed: Boolean(options.sandbox),
              autonomy: requestedAutonomy,
              sandboxOptions: longLivedSandboxOptions,
              graceMs: shutdownGraceMs,
              envOmissions: adapter.getEnvOmissions(),
              // The Playwright binary the claude-family argv embeds in its
              // --mcp-config argument (review round 110): the spawn re-stats
              // it beside the command's own positions, immediately before
              // the child exists.
              ...(claudeBuilt?.playwrightMcpCheck != null
                ? { extraExecutableChecks: [claudeBuilt.playwrightMcpCheck] }
                : {}),
            }, {
              onLine: (line) => driver.handleHarnessLine(line),
              onFatal: (fatal) => driver.handleFatal(fatal),
            });
          } catch (error) {
            // No child came: release the late-child hold or the end path
            // never exits (round 18, edges 1).
            driver.spawnAbandoned?.();
            // An end path a signal or timeout began during the preflight
            // owns this ending (round 20, minor 8; every long-lived-child
            // driver since round 65): await it and leave through its exit
            // code, never release the record here or rethrow past it.
            if (driver.endPathStarted?.() === true && driver.finishAfterSpawnThrow) {
              await driver.finishAfterSpawnThrow(error);
              return;
            }
            // No driver end path runs for a spawn that threw, so the claim
            // is released here (review live20; a lost release reports like
            // the drivers', live21). The release runs in finally inside
            // cleanupAfterSpawnThrow: a throwing removal once skipped it
            // and stranded the record — and the outer abort handler skips
            // the release too, because the spawn already began (round 23,
            // edges 2).
            cleanupAfterSpawnThrow({
              codexSessionHome,
              sessionProjectDir,
              abandonSessionProjectDir,
              releaseOwnedRecord,
            });
            throw error;
          }
          driver.attach?.(proc);
        }
        const unframe = frameCallerStdin(driver);
        let code: number;
        // Set by the finally below when a fresh --final directory it had
        // to remove itself survived: the exit code must say so, whatever
        // the session's own verdict was.
        let finalRemovalFailed = false;
        try {
          code = await driver.run();
        } finally {
          // A turn spawn the end path gave up waiting on (review round
          // 110) can still land a child after run() resolved; the
          // driver's hold stops and settles it, and the cleanup below —
          // which deletes what a live child would still be using
          // (opencode's turn provider config, review D5) — runs after
          // that hold.
          await driver.awaitAbandonedSpawn?.();
          // What the latest turn's env assembly left live (opencode's
          // current provider config; earlier turns' were finalized at the
          // next turn's spawn) dies with the session. The codex session
          // home never rode turnState: the driver's end path settled it
          // (kept on a resumable end; a fresh one removed otherwise, a
          // resumed one never — review D3) before run() resolved. The
          // project-settings session's private config directory is the
          // opposite rule: run-scoped cleanup never touches it (its
          // context's finalize is the no-op above), and --final alone
          // removes it — the whole two-attempt sequence inside the
          // driver's end path, BEFORE the end stamp released the record
          // (review round 10, edges 4; round 15, major). The CLI removes
          // only what that end path never decided: a FRESH directory
          // whose record was discarded as unconfirmed, so nothing points
          // at it. Never a resumed one (its state predates this process)
          // and never one the driver already decided — a removal here
          // after a settled double failure would delete a directory the
          // record and the already-emitted session_ended still promise
          // (review round 15, major). Without --final it persists for the
          // next --resume.
          await adapter.cleanupRun(turnState.launch?.context);
          // A fresh directory whose record was discarded as unconfirmed is
          // referenced by nothing and would keep copied credentials on disk
          // (review round 46): it goes whatever --final said.
          const orphaned = claudeDriver?.recordDiscarded === true && !sessionProjectDirResumed;
          if ((finalSession || orphaned) && !claudeDriver?.finalRemovalRan && !sessionProjectDirResumed) {
            finalRemovalFailed = !removeFinalProjectDir(sessionProjectDir);
          }
        }
        unframe();
        driver.dispose();
        process.stdin.destroy();
        process.exitCode = finalRemovalFailed ? Math.max(code, 1) : code;
      } catch (error) {
        handleSessionAbort(error, {
          spawnBegan: spawnBegan.value,
          codexSessionHome,
          abandonSessionProjectDir,
          releaseOwnedRecord,
          builtDriver,
        });
      }
    });
}
