// The resume half of `codemux session` startup: registry path, harness
// home, provider identity, the resume lookup, and the containment
// guards (design §4.8). src/session/cli.ts owns the command; this runs
// after session/cli-request.ts has validated the flags.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectSettingsConfigRoot, projectSettingsSessionDirPath } from "../claude-project-config.js";
import {
  codexProviderSessionsParent,
  codexSessionProviderHomePath,
} from "../codex-provider.js";
import { kimiPrivateBrandHome } from "../kimi-hermetic.js";
import {
  providerIdentityBaseUrl,
  requireProviderOverride,
  type ProviderOverride,
} from "../provider-override.js";
import type { ScodeTrustLevel } from "../sandbox.js";
import type { AgentId, AutonomyLevel } from "../types.js";
import type { SessionAgentSupport } from "./cli-agents.js";
import {
  aiderHarnessHome,
  agyHarnessHome,
  claudeFamilyHarnessHome,
  codexHarnessHome,
  kimiHarnessHome,
  opencodeHarnessHome,
  turnAgentHarnessHome,
} from "./cli-homes.js";
import { isTurnAgent } from "./turn-driver-launch.js";
import type { SessionCommandOptions } from "./cli-request.js";
import { sessionKeyedHomePath } from "./private-home-key.js";
import { assertResumeIdShape, exitOnResumeRefusal, exitWithCode, usageError } from "./cli-usage.js";
import {
  lookupForResume,
  registryInside,
  sessionRegistryPath,
  type ResumeProbe,
} from "./registry.js";

export function resolveSessionContext({
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
}: {
  options: SessionCommandOptions;
  agentId: AgentId;
  sessionSupport: SessionAgentSupport;
  override: ProviderOverride | null;
  autonomy: AutonomyLevel;
  passthroughEnv: string[];
  enablePlaywrightMcp: boolean;
  hermetic: boolean;
  experimentProjectSettings: boolean;
  sandboxTrust: ScodeTrustLevel;
  sandboxNoNet: boolean;
  sandboxScrubEnv: boolean;
  sandboxBlock: readonly string[];
  workdir: string;
}) {
  const registryPath = sessionRegistryPath();
  // CODEX_HOME reaches only a codex session's child, so only codex
  // validates it: codexHarnessHome's refusals (a relative or padded
  // value) must not end a claude/zai/agy/kimi/opencode/aider session
  // over a variable its harness never reads (review D8,
  // correctness 2).
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
    assertResumeIdShape(sessionSupport, options.resume);
    resumeId = options.resume;
  }
  // A claude-family session's id, minted HERE rather than inside
  // buildClaudeSessionCommand: a hermetic session's private config
  // directory is keyed by it — plain --hermetic and
  // --experiment-project-settings share the one directory — and both
  // the harness home below and the record need that key before
  // anything spawns. A resume reuses the recorded id (the same UUID
  // the directory was keyed by). The aider precedent, one family
  // earlier (aiderSessionId below).
  const claudeSessionId =
    agentId === "claude" || agentId === "zai" ? resumeId ?? randomUUID() : undefined;
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
  // A HERMETIC codex/kimi/agy session's home is its private home's
  // settled spelling — the session-keyed directory the driver
  // records at its settle (settledPrivateHomePath, settledAgyHarnessHome
  // in the drivers) — on a resume, where the id is known;
  // a fresh session's cover is the parent every keyed path sits
  // under, the override arm's own conservative-cover rule.
  // The PARENT spelling of the key (sessionKeyedHomePath): the drivers
  // record settledPrivateHomePath(<run-shaped dir>, id), which is the
  // same directory; passing the parent to that helper would look one
  // directory too high (review round 412, blocker).
  const hermeticSessionKey = (parent: string): string =>
    resumeId !== undefined ? sessionKeyedHomePath(parent, resumeId) : parent;
  const harnessHome =
    options.harnessHome !== undefined ? options.harnessHome : agentId === "codex"
      ? hermetic
        ? hermeticSessionKey(join(codexHome(), ".codemux-hermetic"))
        : codexOverride !== null
          ? resumeId !== undefined
            ? codexSessionProviderHomePath(codexHome(), codexOverride.baseUrl, resumeId)
            : codexProviderSessionsParent(codexHome())
          : codexHome()
      : agentId === "agy"
        ? hermetic
          ? resumeId !== undefined
            ? join(
                hermeticSessionKey(join(dirname(agyHarnessHome()), ".codemux-isolation-probes")),
                ".gemini",
                "antigravity-cli"
              )
            : join(dirname(agyHarnessHome()), ".codemux-isolation-probes")
          : agyHarnessHome()
        : agentId === "opencode"
          ? hermetic
            ? hermeticSessionKey(join(opencodeHarnessHome(), ".codemux-hermetic"))
            : opencodeHarnessHome()
          : agentId === "aider"
            ? // A hermetic aider session's recorded home is the
              // session-keyed directory under
              // `~/.aider/.codemux-hermetic` (the codex/kimi rule); a
              // fresh session's cover is the parent every keyed path
              // sits under.
              hermetic
              ? hermeticSessionKey(join(aiderHarnessHome(), ".codemux-hermetic"))
              : aiderHarnessHome()
            : agentId === "kimi"
              ? hermetic || enablePlaywrightMcp
                ? resumeId !== undefined
                  ? kimiPrivateBrandHome(
                      hermeticSessionKey(
                        join(kimiHarnessHome(passthroughEnv), ".codemux-hermetic")
                      )
                    )
                  : join(kimiHarnessHome(passthroughEnv), ".codemux-hermetic")
                : kimiHarnessHome(passthroughEnv)
              : isTurnAgent(agentId)
                ? agentId === "qwen" || !hermetic
                  ? turnAgentHarnessHome(agentId, passthroughEnv)
                  : resumeId !== undefined
                    ? hermeticSessionKey(
                        join(
                          turnAgentHarnessHome(agentId, passthroughEnv),
                          ".codemux-hermetic"
                        )
                      )
                    : join(
                        turnAgentHarnessHome(agentId, passthroughEnv),
                        ".codemux-hermetic"
                      )
              : claudeSessionId !== undefined &&
                  (hermetic || experimentProjectSettings)
                ? projectSettingsSessionDirPath(
                    projectSettingsConfigRoot(process.env),
                    claudeSessionId
                  )
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
    callerOwnedHome: options.harnessHome !== undefined,
    autonomy,
    sandboxed: Boolean(options.sandbox),
    sandboxStrict: Boolean(options.sandboxStrict),
    sandboxTrust,
    sandboxNoNet,
    sandboxScrubEnv,
    sandboxBlock,
    cwd: workdir,
    passEnv: passthroughEnv,
    playwrightMcp: enablePlaywrightMcp,
    providerBaseUrl,
    hermetic,
    projectSettings: experimentProjectSettings,
  };
  if (resumeId !== undefined) {
    exitOnResumeRefusal(
      resumeId,
      registryPath,
      lookupForResume(registryPath, resumeId, resumeProbe)
    );
    // The one resume check the registry cannot make: a hermetic
    // session's transcript lives in its private home (the recorded
    // harness_home — the claude family's config directory, the
    // codex/kimi/agy settled key), and a home removed by --final or
    // the stale sweep takes the transcript with it. Refused as policy
    // (78) — the entry is trustworthy, the state behind it is gone.
    // OpenCode keeps its native database in its session-keyed home.
    // A plain session of any agent has no private home to check.
    const sessionKeyedHome =
      options.harnessHome !== undefined ? harnessHome
      : claudeSessionId !== undefined && (hermetic || experimentProjectSettings) ? harnessHome
      : agentId === "codex" && hermetic ? harnessHome
      : agentId === "kimi" && (hermetic || enablePlaywrightMcp) ? harnessHome
      : agentId === "agy" && hermetic ? harnessHome
      // The hermetic aider session's private home carries the history
      // file (cli-drivers.ts opens it settled): removed by --final or
      // the stale sweep, the transcript is gone with it.
      : agentId === "opencode" && hermetic ? harnessHome
      : agentId === "aider" && hermetic ? harnessHome
      // The five hermetic-capable second-wave agents with a home
      // (turn-driver-homes.ts); qwen keeps none
      // and cursor's --hermetic is refused at the request gate.
      : isTurnAgent(agentId) && hermetic && agentId !== "qwen" ? harnessHome
      : null;
    if (sessionKeyedHome !== null && !existsSync(sessionKeyedHome)) {
      exitWithCode(
        78,
        options.harnessHome !== undefined
          ? `cannot resume session ${resumeId}: its caller-owned --harness-home is missing; restore its transcript before resuming`
          : `cannot resume session ${resumeId}: its private config directory (${sessionKeyedHome}) ` +
          "is missing -- removed by --final or the stale sweep -- and the session's " +
          "transcript with it"
      );
    }
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
  return {
    registryPath,
    codexHome,
    codexOverride,
    resumeId,
    claudeSessionId,
    harnessHome,
    providerBaseUrl,
    resumeProbe,
  };
}
