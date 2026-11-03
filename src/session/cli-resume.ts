// The resume half of `codemux session` startup: registry path, harness
// home, provider identity, the resume lookup, and the containment
// guards (design §4.8). src/session/cli.ts owns the command; this runs
// after session/cli-request.ts has validated the flags.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { projectSettingsConfigRoot, projectSettingsSessionDirPath } from "../claude-project-config.js";
import {
  codexProviderSessionsParent,
  codexSessionProviderHomePath,
} from "../codex-provider.js";
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
} from "./cli-homes.js";
import type { SessionCommandOptions } from "./cli-request.js";
import { exitOnResumeRefusal, exitWithCode, usageError } from "./cli-usage.js";
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
    if (!sessionSupport.resumePattern.test(options.resume)) {
      usageError(
        `--resume expects a ${sessionSupport.resumeLabel} session id; '${options.resume}' is not one`
      );
    }
    resumeId = options.resume;
  }
  // A claude-family session's id, minted HERE rather than inside
  // buildClaudeSessionCommand: a project-settings session's private
  // config directory is keyed by it, and both the harness home below
  // and the record need that key before anything spawns. A resume
  // reuses the recorded id (the same UUID the directory was keyed
  // by). The aider precedent, one family earlier (aiderSessionId
  // below).
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
  const harnessHome =
    agentId === "codex"
      ? codexOverride !== null
        ? resumeId !== undefined
          ? codexSessionProviderHomePath(codexHome(), codexOverride.baseUrl, resumeId)
          : codexProviderSessionsParent(codexHome())
        : codexHome()
      : agentId === "agy"
        ? agyHarnessHome()
        : agentId === "opencode"
          ? opencodeHarnessHome()
          : agentId === "aider"
            ? aiderHarnessHome()
            : agentId === "kimi"
              ? kimiHarnessHome(passthroughEnv)
              : experimentProjectSettings && claudeSessionId !== undefined
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
    autonomy,
    sandboxed: Boolean(options.sandbox),
    sandboxTrust,
    sandboxNoNet,
    sandboxScrubEnv,
    sandboxBlock,
    cwd: workdir,
    passEnv: passthroughEnv,
    playwrightMcp: enablePlaywrightMcp,
    providerBaseUrl,
    hermetic: experimentProjectSettings,
    projectSettings: experimentProjectSettings,
  };
  if (resumeId !== undefined) {
    exitOnResumeRefusal(
      resumeId,
      registryPath,
      lookupForResume(registryPath, resumeId, resumeProbe)
    );
    // The one resume check the registry cannot make: a
    // project-settings session's transcript lives in its private
    // config directory (the recorded harness_home), and a directory
    // removed by --final or the stale sweep takes the transcript
    // with it. Refused as policy (78) — the entry is trustworthy,
    // the state behind it is gone.
    if (experimentProjectSettings && !existsSync(harnessHome)) {
      exitWithCode(
        78,
        `cannot resume session ${resumeId}: its private config directory (${harnessHome}) ` +
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
