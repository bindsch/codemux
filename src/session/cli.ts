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
import { prepareCodexSessionCatalog, type CodexSessionCatalog } from "./codex-catalog.js";
import type { CodemuxConfig } from "../types.js";
import { exitOnResumeRefusal } from "./cli-usage.js";
import { registerSessionOptions } from "./cli-options.js";
import { cleanupAfterSpawnThrow, exitPrintedSandbox, handleSessionAbort, removeFinalProjectDir } from "./cli-exit.js";
import { recordSessionBeforeSpawn } from "./cli-record.js";
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
  recordSessionEnd,
  releaseSessionRecord,
} from "./registry.js";
import type { SessionPrivateHome } from "./private-home-types.js";
import { spawnSessionChild } from "./spawn.js";
import { launchRedirectCheck } from "../cli-runtime.js";
import { assertSessionOptionsSupported } from "./cli-policy.js";
import { abandonFreshSessionDirectories } from "./cli-abandon.js";

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
      // The catch owns pre-spawn homes; the catalog lasts until the child settles.
      let codexSessionCatalog: CodexSessionCatalog | null = null;
      let codexSessionHome: CodexSessionProviderHome | null = null;
      let sessionProjectDir: ProjectSettingsSessionDir | null = null;
      let sessionProjectDirResumed = false;
      // The hermetic codex/kimi/agy session's private home: the same
      // fresh/resumed removal rule as the claude family's directory.
      let sessionPrivateHome: SessionPrivateHome | null = null;
      let sessionPrivateHomeResumed = false;
      let turnAgentFreshHome: SessionPrivateHome | null = null; // review m5 (cli-drivers.ts)
      const spawnBegan = { value: false };
      // Release fresh unconfirmed records or stamp claimed resumes on abort.
      let owned: { registryPath: string; id: string; fresh: boolean } | null = null;
      // Only the end path stamps final, after removing the private directory.
      const releaseOwnedRecord = (): void => {
        if (owned === null) return;
        if (owned.fresh) discardUnconfirmedRecord(owned.registryPath, owned.id);
        else releaseSessionRecord(owned.registryPath, owned.id, false);
      };
      // Dispose driver signal handlers on any pre-spawn exit.
      let builtDriver: SessionDriver | null = null;
      /** Aborting removes only a FRESH private directory (its record was
       * never confirmed); a resumed one stays — that removal is the end
       * path's (round 17, edges 1), the codex/kimi/agy home included. */
      const abandonSessionProjectDir = (): void => {
        abandonFreshSessionDirectories(
          sessionProjectDir, sessionProjectDirResumed,
          sessionPrivateHome, sessionPrivateHomeResumed
        );
        abandonFreshSessionDirectories(null, false, turnAgentFreshHome, false);
      };
      try {
        requireValidConfig();
        assertSessionOptionsSupported(options);
        const {
          agentId,
          sessionSupport,
          adapter,
          override,
          requestedAutonomy,
          passthroughEnv,
          enablePlaywrightMcp,
          hermetic,
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
          modelAlias,
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
          hermetic,
          experimentProjectSettings,
          sandboxTrust,
          sandboxNoNet,
          sandboxScrubEnv,
          sandboxBlock,
          workdir,
        });
        // The same --final predicate the driver options carry
        // (cli-drivers.ts): the end path alone stamps the record final,
        // and only after the removal (review round 10, edges 4; round
        // 16, edges 1). Plain --hermetic qualifies; opencode has no
        // session-keyed home, so its --final decides about nothing.
        const finalSession = Boolean(options.final) && hermetic;
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
          hermetic,
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
        sessionPrivateHome = launch.sessionPrivateHome;
        sessionPrivateHomeResumed = resumeId !== undefined;
        codexSessionCatalog = agentId === "codex" ? prepareCodexSessionCatalog({
          request: { ...runLike, model }, realCodexHome: codexHome(), binary: launch.codexCatalogBinary,
          harnessVersion: launch.harnessVersion, sandboxOptions: launch.sandboxOptions, callerBlockPaths: sandboxBlock, printOnly,
        }) : null;
        const {
          needsKeepEnvPreflight,
          buildSessionEnvironment,
          claudeFamilyAgent,
          claudeBuilt,
          turnPerProcess,
        } = launch;
        const { argv, buildLongLivedEnvironment, extraExecutableChecks, printedSandbox } =
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
            sandboxOptions: codexSessionCatalog?.sandboxOptions ?? launch.sandboxOptions,
            callerBlockPaths: agentId === "opencode" ? sandboxBlock : undefined,
            claudeBuilt,
            codexSessionHome,
            codexSessionCatalog,
            sessionProjectDir,
            sessionPrivateHome,
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
            sessionPrivateHome,
            sessionPrivateHomeResumed,
            releaseOwnedRecord,
          });
          return;
        }
        const {
          driver,
          claudeDriver,
          agyDriver,
          aiderDriver,
          aiderSessionId,
          aiderPrivateHome,
          turnState,
          turnAgentFreshHome: freshTurnHome,
        } =
          createSessionDriver({
            options,
            agentId,
            adapter,
            override,
            codexHome,
            codexOverride,
            codexSessionHome,
            codexSessionCatalog,
            resumeId,
            claudeFamilyAgent,
            claudeBuilt,
            model,
            modelAlias,
            autonomy,
            effort,
            workdir,
            passthroughEnv,
            enablePlaywrightMcp,
            hermetic,
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
            sessionPrivateHome: launch.sessionPrivateHome,
            kimiSourceBrandHome: launch.kimiSourceBrandHome,
            sessionProjectDir,
          });
        // LANE S1 (flagged edit): a hermetic aider session opens its
        // private home inside the driver arm (the session id that keys
        // it is minted there), so it is bound here — after the arm,
        // before the spawn — for the catch and the finally that own its
        // removal, the same positions codex and kimi reach through the
        // launch phase above.
        if (aiderPrivateHome !== null) {
          sessionPrivateHome = aiderPrivateHome;
        }
        turnAgentFreshHome = freshTurnHome;
        builtDriver = driver;
        if (resumeId !== undefined) {
          // The claim was taken ahead of the launch preparation (see
          // above); the driver, built only now, is told about it so its
          // recordSessionStart updates this process's record in place and
          // its every end path stamps `ended`.
          driver.adoptResumeClaim();
        }
        // The pre-spawn registry record steps (cli-record.ts): the
        // writable-registry probe for the first-turn-id agents, the
        // claude-family and aider records, and the fresh id this
        // process comes to own.
        const { freshOwnedId } = recordSessionBeforeSpawn({
          registryPath,
          agentId,
          resumeId,
          claudeDriver,
          claudeSessionId: claudeBuilt?.sessionId ?? null,
          aiderDriver,
          aiderSessionId,
          releaseOwnedRecord,
          abandonSessionProjectDir,
        });
        if (owned === null && freshOwnedId !== null) {
          owned = { registryPath, id: freshOwnedId, fresh: true };
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
            const { env, longLivedSandboxOptions, validateBeforeSpawn } = buildLongLivedEnvironment();
            if (env === null) throw new Error("the long-lived session child has no environment");
            proc = await spawnSessionChild(argv, env, {
              cwd: workdir,
              sandboxed: Boolean(options.sandbox),
              autonomy: requestedAutonomy,
              sandboxOptions: longLivedSandboxOptions,
              validateBeforeSpawn: () => { validateBeforeSpawn?.(); codexSessionCatalog?.assertPrepared(); },
              graceMs: shutdownGraceMs,
              envOmissions: adapter.getEnvOmissions(),
              // The Playwright binary the claude-family argv embeds in its
              // --mcp-config argument (review round 110): the spawn re-stats
              // it beside the command's own positions, immediately before
              // the child exists.
              // The redirect target (OPENCODE_BIN_PATH) the session gate
              // resolved and probed joins the same pin (review round 331,
              // item 5), so a replacement between the probe and the
              // spawn fails the re-stat.
              extraExecutableChecks: [
                ...extraExecutableChecks, ...(claudeBuilt?.playwrightMcpCheck != null ? [claudeBuilt.playwrightMcpCheck] : []),
                ...((check) => check === null ? [] : [check])(
                  launchRedirectCheck(agentId, env, workdir)
                ),
              ],
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
          turnAgentFreshHome = null; code = await driver.run(); // the driver's end path owns the home now
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
          // --final divides by family: the codex and kimi drivers settle
          // their homes only, so the CLI removes them here (after run(),
          // the spawn hold, and cleanupRun); the agy and claude-family
          // drivers remove in their end paths before the end stamp, and a
          // home agy's end path decided (finalRemovalRan) is never
          // re-decided here; the call covers agy's no-child end only. A
          // fresh session's harness id never reaches the CLI, so only a
          // --final RESUME stamps its record; a fresh record stays
          // resumable while its home is gone (the next --resume: 78).
          if (agentId !== "opencode" && sessionPrivateHome !== null && finalSession && !agyDriver?.finalRemovalRan) {
            finalRemovalFailed =
              !removeFinalProjectDir(sessionPrivateHome) || finalRemovalFailed;
            if (!finalRemovalFailed && resumeId !== undefined) {
              recordSessionEnd(registryPath, resumeId, true);
            }
          }
        }
        unframe();
        driver.dispose();
        process.stdin.destroy();
        process.exitCode = finalRemovalFailed ? Math.max(code, 1) : code;
      } catch (error) {
        // handleSessionAbort exits synchronously, so cleanup must precede it.
        removeFinalProjectDir(codexSessionCatalog);
        handleSessionAbort(error, {
          spawnBegan: spawnBegan.value,
          codexSessionHome,
          abandonSessionProjectDir,
          releaseOwnedRecord,
          builtDriver,
        });
      } finally {
        if (!removeFinalProjectDir(codexSessionCatalog)) process.exitCode = Math.max(Number(process.exitCode ?? 0), 1);
      }
    });
}
