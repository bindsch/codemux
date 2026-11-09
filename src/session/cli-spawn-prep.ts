// What the long-lived session child runs under: the argv, the run
// context, the environment with its keep-env preflight, and the
// --print-sandbox introspection. src/session/cli.ts owns the command
// and the spawn itself.
import { join } from "node:path";
import { buildAgySessionCommand } from "./agy-session.js";
import { buildCodexSessionCommand, codexSessionHermeticEnvPrefix } from "./codex-session.js";
import type { BaseAdapter, RunContext } from "../adapters/base.js";
import {
  assertScodeKeepEnvSupport,
  resolveScodeExecutableForEnv,
} from "../cli-runtime.js";
import type { ProjectSettingsSessionDir } from "../claude-project-config.js";
import type { CodexSessionProviderHome } from "../codex-provider.js";
import type { ProviderOverride } from "../provider-override.js";
import { withKeepEnvExemption, type SandboxOptions } from "../sandbox.js";
import { escapeArgvForPrint } from "../usage-protocol.js";
import { agyPrivateHomeEnvPrefix } from "../adapters/agy-homes.js";
import type { SessionEnvironmentBuilder } from "./cli-launch.js";
import type { SessionCommandOptions } from "./cli-request.js";
import type { ClaudeSessionBuilt } from "./claude-session/builders.js";
import type { SessionPrivateHome } from "./private-home-types.js";
import { usageError } from "./cli-usage.js";
import { resolveSessionSandboxSpawn } from "./spawn.js";
import type { AgentId, AutonomyLevel, ReasoningEffort, RunRequest } from "../types.js";

export async function prepareSessionChild({
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
  sessionPrivateHome,
  turnPerProcess,
  needsKeepEnvPreflight,
  buildSessionEnvironment,
}: {
  options: SessionCommandOptions;
  agentId: AgentId;
  adapter: BaseAdapter;
  override: ProviderOverride | null;
  runLike: RunRequest;
  resumeId: string | undefined;
  model: string | undefined;
  autonomy: AutonomyLevel;
  effort: ReasoningEffort | undefined;
  workdir: string;
  requestedAutonomy: AutonomyLevel;
  sandboxOptions: SandboxOptions | undefined;
  claudeBuilt: ClaudeSessionBuilt | null;
  codexSessionHome: CodexSessionProviderHome | null;
  sessionProjectDir: ProjectSettingsSessionDir | null;
  sessionPrivateHome: SessionPrivateHome | null;
  turnPerProcess: boolean;
  needsKeepEnvPreflight: boolean;
  buildSessionEnvironment: SessionEnvironmentBuilder;
}) {
  const argv =
    claudeBuilt !== null
      ? claudeBuilt.argv
      : agentId === "codex"
        ? buildCodexSessionCommand(
            // A HERMETIC session: the private home as both HOME and
            // CODEX_HOME (codex-session.ts) — the run path's own argv
            // shape. Read once here; the child this names spawns
            // before the end path could settle the home, and it is
            // long-lived, so the name never goes stale under it.
            sessionPrivateHome !== null
              ? codexSessionHermeticEnvPrefix(sessionPrivateHome.dir)
              : // The override launch: CODEX_HOME pointed at the
                // session's provider home — the live run-shaped one for
                // a fresh session, the session-keyed one for a resume —
                // through the same env(1) shape the run path spawns with.
                codexSessionHome !== null
                ? [`CODEX_HOME=${codexSessionHome.codexHome}`]
                : undefined
          )
        : agentId === "agy"
          ? sessionPrivateHome !== null
            ? [
                // The private home's empty-environment redirect
                // (adapters/agy-homes.ts), the run path's own prefix:
                // no operator config, instructions, or state loads
                // from a home codemux made.
                ...agyPrivateHomeEnvPrefix(sessionPrivateHome.dir),
                ...buildAgySessionCommand({
                  resumeConversationId: resumeId,
                  model,
                  autonomy,
                  effort,
                }),
              ]
            : buildAgySessionCommand({
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
  // cleanup may own its lifetime. A hermetic agy session carries its
  // private home on the probe seam for the same reason — the
  // adapter's getRunEnv refuses a hermetic launch without one — with
  // the same no-run-scoped-lifetime rule.
  const runContext: RunContext | undefined =
    sessionPrivateHome !== null && agentId === "codex"
      ? {
          // The adapter requires the prepared home for native and
          // provider-override launches. The session owns its removal.
          hermeticHome: {
            home: sessionPrivateHome.dir,
            codexHome: join(sessionPrivateHome.dir, ".codex"),
            finalize: () => {},
          },
        }
      : codexSessionHome !== null
      ? {
          codexProviderHome: {
            codexHome: codexSessionHome.codexHome,
            finalize: () => {},
          },
        }
      : sessionPrivateHome !== null && agentId === "agy"
        ? {
            agyProbe: {
              mode: "hermetic",
              home: sessionPrivateHome.dir,
              printOnly: options.printSandbox === true,
            },
          }
        : sessionProjectDir !== null
        ? {
            // The session's private config directory through the
            // adapter's own getRunEnv seam: CLAUDE_CONFIG_DIR plus
            // the credential copy. Its finalize is a no-op by
            // design, the codex session-home rule: the directory is
            // per-SESSION state (it must survive this process for
            // the next --resume), so no run-scoped cleanup may own
            // its lifetime — --final and the sweep do.
            claudeProjectConfigDir: {
              dir: sessionProjectDir.dir,
              blockedPaths: sessionProjectDir.blockedPaths,
              finalize: () => {},
            },
          }
        : undefined;
  // The probe environment answers the same environment WITHOUT writing
  // into the session's private directory (the credential copy is
  // deferred): everything below that runs before the resume claim —
  // the keep-env preflight, --print-sandbox — builds from this one,
  // so a resume that never claims writes nothing (review round 3,
  // edges finding on the claim order). Built lazily: the preflight and
  // the print are the only consumers, and opencode's probe context (a
  // prepared provider config) exists only while one runs.
  const buildProbeEnvironment = (): { runEnv: Record<string, string>; env: Record<string, string> } => {
    if (runContext?.claudeProjectConfigDir !== undefined) {
      return buildSessionEnvironment({
        ...runContext,
        claudeProjectConfigDir: { ...runContext.claudeProjectConfigDir, deferCredentialCopy: true },
      });
    }
    if (agentId !== "opencode" || !needsKeepEnvPreflight) {
      // The codex override launch carries its session provider home on the
      // run context: the adapter's getRunEnv refuses an override launch
      // whose home was not prepared, so the probe environment must see the
      // same context the long-lived build will (it reads, never writes).
      return buildSessionEnvironment(runContext);
    }
    // OpenCode needs a prepared config to build its run environment.
    // This probe-only context is cleaned on success and failure;
    // every actual turn still prepares a fresh, private config.
    const probeContext = adapter.prepareRun(runLike);
    try {
      return buildSessionEnvironment(probeContext);
    } finally {
      adapter.cleanupRun(probeContext);
    }
  };
  // Long-lived children reuse this environment, BUILT AFTER THE RESUME
  // CLAIM by the caller (cli.ts builds it right before the spawn, the
  // codex prepareConfig position): building it here would copy the
  // credential mirror into a session's private directory before this
  // process owned the session. Turn children use the same builder with
  // their own context at each launch (after the claim, per turn).
  const buildLongLivedEnvironment = turnPerProcess
    ? () => ({ env: null as Record<string, string> | null, longLivedSandboxOptions: sandboxOptions })
    : () => {
        const { runEnv, env } = buildSessionEnvironment(runContext);
        return {
          env,
          longLivedSandboxOptions:
            sandboxOptions === undefined
              ? sandboxOptions
              : withKeepEnvExemption(
                  sandboxOptions,
                  { ...adapter.getEnv(), ...runEnv },
                  override !== null
                ),
        };
      };
  if (needsKeepEnvPreflight) {
    const probeEnv = buildProbeEnvironment().env;
    const scode = resolveScodeExecutableForEnv(probeEnv, workdir);
    if (scode !== null) {
      await assertScodeKeepEnvSupport(scode, workdir, probeEnv, {
        scrubEnv: sandboxOptions?.scrubEnv === true,
        untrusted: sandboxOptions?.trust === "untrusted",
      });
    }
  }

  // `--print-sandbox`: resolve exactly what the long-lived child's
  // spawn would exec — probes and keep-env resolution included, the
  // same shared builder (resolveSessionSandboxSpawn) — print the
  // scode argv, and report the print through the return value. A
  // print-only invocation claims nothing, records nothing, spawns
  // nothing: cli.ts decides print-only from the argv alone, ahead of
  // the resume claim, so the printed argv is the real one while the
  // registry is never claimed, released, or stamped (review round 17,
  // edges 2) — and nothing is written: the probe environment below
  // defers the credential copy, so a print of a resume leaves the
  // session's private directory byte-identical. A real run's claim
  // still precedes this call (it opens nothing until the launch
  // preparation below it returns). The turn-per-process agents build
  // their children per turn with a per-turn environment (env === null
  // here), so they have no one argv to print. The action's single
  // exit path (cli.ts) owns the finalizers from here — the codex
  // session home and the project-settings directory above all — so
  // this branch never exits the process itself (review round 2,
  // edges 3: a process.exit(0) here stranded a fresh codex override
  // home's run-<pid>-* directory on every print-only invocation).
  if (options.printSandbox) {
    if (!options.sandbox) {
      usageError(
        "--print-sandbox requires --sandbox: it prints the scode argv of a sandboxed session child"
      );
    }
    if (argv === null) {
      usageError(
        "--print-sandbox is not available for this agent: its session children spawn per turn, so there is no one scode argv to print"
      );
    }
    const probeEnvironment = buildProbeEnvironment();
    // The keep-env exemption the printed spawn would carry, from the
    // probe environment (same names as the real build; no writes).
    const printedSandboxOptions =
      sandboxOptions === undefined
        ? sandboxOptions
        : withKeepEnvExemption(
            sandboxOptions,
            { ...adapter.getEnv(), ...probeEnvironment.runEnv },
            override !== null
          );
    const { scodeCmd } = await resolveSessionSandboxSpawn(
      argv,
      probeEnvironment.env,
      {
        cwd: workdir,
        sandboxed: true,
        autonomy: requestedAutonomy,
        sandboxOptions: printedSandboxOptions,
        envOmissions: adapter.getEnvOmissions(),
      },
      workdir
    );
    // One argument per line, control characters escaped per argument
    // (escapeArgvForPrint), so a multi-line prompt argument cannot read as
    // several arguments.
    process.stdout.write(`${scodeCmd.map(escapeArgvForPrint).join("\n")}\n`);
    return { argv, buildLongLivedEnvironment, printedSandbox: true };
  }
  return { argv, buildLongLivedEnvironment, printedSandbox: false };
}
