import { copyFileSync, chmodSync, constants, existsSync, linkSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ZaiAdapter } from "./adapters/zai.js";
import { createCanaryScratch, mintCanaryMarker, untrackScratchRemoval } from "./hermetic-canary.js";
import { carryOpencodeModelState } from "./opencode-hermetic.js";
import { canarySessionProtocolProblem, runCanarySession, SESSION_KILL_GRACE_MS, sessionFailureDetail } from "./hermetic-session-canary-driver.js";
import type { HermeticSessionCanaryRequest } from "./hermetic-session-canary.js";
import { callerHarnessHomeEnvNames } from "./session/harness-home.js";
import type { AgentId } from "./types.js";

type HarnessHomeCanaryAgent = AgentId;

/** The redirect names the caller-home arm deletes from its sessions'
 * environment; with HOME, which it sets to a scratch operator home, these
 * are the names a caller's --pass-env cannot carry into that arm. */
export const HARNESS_HOME_CANARY_CLEARED_ENV: readonly string[] = [
  "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  "KIMI_CODE_HOME", "GEMINI_CLI_HOME", "COPILOT_HOME", "CURSOR_CONFIG_DIR", "FACTORY_HOME_OVERRIDE", "PI_CODING_AGENT_DIR", "GOOSE_PATH_ROOT",
  "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENHANDS_PERSISTENCE_DIR", "OPENHANDS_CONVERSATIONS_DIR", "PERSISTENCE_DIR", "QWEN_HOME", "QWEN_RUNTIME_DIR",
  "CLINE_DIR", "CLINE_DATA_DIR", "CLINE_SESSION_DATA_DIR", "CLINE_PROVIDER_SETTINGS_PATH", "CLINE_GLOBAL_SETTINGS_PATH", "CLINE_MCP_SETTINGS_PATH",
];

/** Every name the caller-home arm sets or clears in its sessions'
 * environment: HOME, the cleared redirects, zai's gateway key, which the
 * arm rewrites from the adapter's token, and the names the `--harness-home`
 * session itself sets or clears, which it refuses in --pass-env. */
export function harnessHomeCanaryOwnedEnv(agent: AgentId): readonly string[] {
  return [...new Set(["HOME", ...HARNESS_HOME_CANARY_CLEARED_ENV, ...(agent === "zai" ? ["ZAI_API_KEY"] : []),
    ...callerHarnessHomeEnvNames(agent)])];
}

/** Every session agent has a caller-home recipe (session/harness-home.ts), so
 * every one runs the caller-home arm. Kept as a predicate so a future agent
 * without a recipe fails closed here instead of at launch. */
export function supportsHarnessHomeCanary(agent: AgentId): agent is HarnessHomeCanaryAgent {
  return Object.hasOwn(CANARY_LAYOUT, agent);
}

// Native root evidence is recorded in session/harness-home.ts. Aider 0.86.2
// aider/main.py:682-683 loads args.read from .aider.conf.yml; it has no skill scanner.
// Cline cli-v3.0.74 shared/src/storage/paths.ts:511-526 reads skills from
// <CLINE_DIR>/skills and global rules from <HOME>/.agents/AGENTS.md; its
// caller home needs a provider override, which rides the environment.
const CANARY_LAYOUT: Record<HarnessHomeCanaryAgent, { skill: string; instruction: string; logins: string[] }> = {
  cline: { skill: ".cline/skills/private-canary/SKILL.md", instruction: ".agents/AGENTS.md", logins: [] },
  claude: { skill: "skills/private-canary/SKILL.md", instruction: ".claude/CLAUDE.md", logins: [".credentials.json"] },
  zai: { skill: "skills/private-canary/SKILL.md", instruction: ".claude/CLAUDE.md", logins: [] },
  codex: { skill: ".codex/skills/private-canary/SKILL.md", instruction: ".codex/AGENTS.md", logins: [".codex/auth.json"] },
  agy: { skill: ".gemini/skills/private-canary/SKILL.md", instruction: ".gemini/GEMINI.md", logins: [] },
  aider: { skill: ".aider/private-canary.md", instruction: ".aider/operator-canary.md", logins: [".aider/oauth-keys.env"] },
  copilot: { skill: ".copilot/skills/private-canary/SKILL.md", instruction: ".copilot/copilot-instructions.md", logins: [] },
  cursor: { skill: ".cursor/skills/private-canary/SKILL.md", instruction: ".cursor/rules/operator-canary.mdc", logins: [process.platform === "darwin" ? ".cursor/auth.json" : ".config/cursor/auth.json"] },
  droid: { skill: ".factory/skills/private-canary/SKILL.md", instruction: ".factory/AGENTS.md", logins: [".factory/auth.json"] },
  gemini: { skill: ".gemini/skills/private-canary/SKILL.md", instruction: ".gemini/GEMINI.md", logins: [".gemini/oauth_creds.json", ".gemini/google_accounts.json"] },
  goose: { skill: ".agents/skills/private-canary/SKILL.md", instruction: ".config/goose/.goosehints", logins: ["config/secrets.yaml"] },
  kimi: { skill: ".kimi-code/skills/private-canary/SKILL.md", instruction: ".kimi-code/AGENTS.md", logins: [] },
  opencode: { skill: ".config/opencode/skills/private-canary/SKILL.md", instruction: ".config/opencode/AGENTS.md", logins: [".local/share/opencode/auth.json"] },
  openhands: { skill: ".openhands/microagents/private-canary.md", instruction: ".openhands/microagents/operator-canary.md", logins: [] },
  pi: { skill: ".pi/agent/skills/private-canary/SKILL.md", instruction: ".pi/agent/AGENTS.md", logins: [".pi/agent/auth.json"] },
  qwen: { skill: ".qwen/skills/private-canary/SKILL.md", instruction: ".qwen/QWEN.md", logins: [".qwen/oauth_creds.json", ".qwen/google_accounts.json"] },
};

export function harnessHomeCanarySkillPath(agent: HarnessHomeCanaryAgent, home: string): string {
  return join(home, CANARY_LAYOUT[agent].skill);
}

export function sessionCanaryLaunchCount(agent: AgentId): number {
  return supportsHarnessHomeCanary(agent) ? 5 : 3;
}

export interface PlantedHarnessHomeCanary {
  cwd: string;
  home: string;
  operatorHome: string;
  operatorMarker: string;
  skillMarker: string;
  skillPath: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

// Neither expected marker appears in the question. The private skill's
// description must reach the model through the harness's skill discovery.
export const HARNESS_HOME_CANARY_PROMPT =
  "Configuration test. Report every code word in the instruction files or " +
  "user-installed skill descriptions you were given before this message. " +
  "Reply with only those code words, or NONE if there are none. Do not use " +
  "any tools; answer from the context you already have.";

/** Uses the first successful hermetic session's login as the scratch
 * operator's credential source. The caller directory itself has no login:
 * the launcher must seed it through its normal credential-only mechanism. */
export function plantHarnessHomeCanary(
  agent: HarnessHomeCanaryAgent,
  authenticatedHome: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  parent = tmpdir()
): PlantedHarnessHomeCanary {
  const root = createCanaryScratch(join(parent, "codemux-harness-home-canary-"));
  const cleanup = (): void => {
    rmSync(root, { recursive: true, force: true });
    untrackScratchRemoval(root);
  };
  try {
    const cwd = join(root, "work");
    const home = join(root, "caller");
    const operatorHome = join(root, "operator");
    const operatorMarker = mintCanaryMarker();
    const skillMarker = mintCanaryMarker();
    const layout = CANARY_LAYOUT[agent];
    mkdirSync(join(cwd, ".git"), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(join(operatorHome, layout.instruction)), { recursive: true, mode: 0o700 });
    for (const credential of layout.logins) {
      const destination = join(operatorHome, agent === "claude" ? ".claude" : "", agent === "goose" ? ".config/goose/secrets.yaml" : credential);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    }
    const skillPath = harnessHomeCanarySkillPath(agent, home);
    mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 });
    writeFileSync(skillPath,
      `---\nname: private-canary\ndescription: The private skill code word is ${skillMarker}.\n---\n` +
      `The private skill code word is ${skillMarker}.\n`, { mode: 0o600 });
    writeFileSync(join(operatorHome, layout.instruction),
      `The operator code word is ${operatorMarker}. Include it in every answer.\n`, { mode: 0o600 });
    if (agent === "aider") {
      writeFileSync(join(home, ".aider.conf.yml"), `read: [${JSON.stringify(skillPath)}]\n`, { mode: 0o600 });
      writeFileSync(join(operatorHome, ".aider.conf.yml"), `read: [${JSON.stringify(join(operatorHome, layout.instruction))}]\n`, { mode: 0o600 });
    }

    const env: NodeJS.ProcessEnv = { ...environment, HOME: operatorHome };
    // Ambient redirects must not point this arm back at the original
    // operator's configuration. --harness-home chooses the child root.
    for (const name of HARNESS_HOME_CANARY_CLEARED_ENV) {
      delete env[name];
    }
    if (agent === "zai") {
      env.ZAI_API_KEY = new ZaiAdapter(environment).getEnv().ANTHROPIC_AUTH_TOKEN;
    }
    const plant = { cwd, home, operatorHome, operatorMarker, skillMarker, skillPath, env, cleanup };
    seedHarnessHomeCanary(agent, plant, authenticatedHome);
    return plant;
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Credentials arrive after the first session; all scratch setup happens
 * before it. Copies on EXDEV stay private and die with this canary. */
export function seedHarnessHomeCanary(agent: AgentId, plant: PlantedHarnessHomeCanary, authenticatedHome?: string): void {
  const { operatorHome, env } = plant;
  const layout = CANARY_LAYOUT[agent];
  if (agent !== "zai" && authenticatedHome !== undefined) {
    const kimiCredentials = join(authenticatedHome, ".kimi-code", "credentials");
    // Kimi renames token files, so a per-file link would strand a refresh in
    // this scratch tree. The caller home shares the real store instead: its
    // brand home becomes the scratch operator's KIMI_CODE_HOME (harness-home.ts).
    if (agent === "kimi" && existsSync(kimiCredentials)) env.KIMI_CODE_HOME = dirname(realpathSync(kimiCredentials));
    // A caller's own OpenCode home keeps its model preference. Without it
    // OpenCode falls to the provider's first model, which the subscription
    // may not include (live gate 2026-11-12: GLM-5.3-Highspeed refused).
    if (agent === "opencode" && !existsSync(join(plant.home, ".local", "state", "opencode", "model.json"))) {
      const problem = carryOpencodeModelState(join(authenticatedHome, ".local", "state", "opencode"), plant.home);
      if (problem) console.error(`Warning: opencode --harness-home canary keeps no model preference: ${problem}`);
    }
    for (const credential of layout.logins) {
      // Pi's disposable hermetic directory is already its agent directory.
      const source = join(authenticatedHome, agent === "pi" && !existsSync(join(authenticatedHome, credential)) ? "auth.json" : credential);
      const destination = join(operatorHome, agent === "claude" ? ".claude" : "", agent === "goose" ? ".config/goose/secrets.yaml" : credential);
      if (!existsSync(source)) continue;
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      // Resolve only dedicated login files, including managed login symlinks.
      const resolved = realpathSync(source);
      try { linkSync(resolved, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        copyFileSync(resolved, destination, constants.COPYFILE_EXCL);
        chmodSync(destination, 0o600);
      }
    }
  }
}

/** A caller-owned home must keep its skill and identity through resume,
 * including --final, while the scratch operator's instructions stay out. */
export async function runHarnessHomeSessionCanary(
  request: HermeticSessionCanaryRequest,
  plant: PlantedHarnessHomeCanary
): Promise<number> {
  const timeout = String(Math.max(1, Math.ceil(request.timeoutMs / 1000)));
  const argv = (resume?: string): string[] => [
    "session", "-a", request.agent, "--harness-home", plant.home,
    ...(resume === undefined ? [] : ["--resume", resume, "--final"]),
    ...(request.model === undefined ? [] : ["-m", request.model]),
    ...(request.effort === undefined ? [] : ["--effort", request.effort]),
    ...(request.passthroughEnv.length === 0 ? [] : ["--pass-env", request.passthroughEnv.join(",")]),
    "-s", "--auto", request.autonomy, "--cwd", plant.cwd, "--timeout", timeout,
  ];
  let sessionId: string | undefined;
  for (const resumed of [false, true]) {
    const label = `${resumed ? "resumed " : ""}${request.agent} --harness-home session`;
    console.error(`Checking ${label}...`);
    const run = await runCanarySession(argv(sessionId), plant.env, HARNESS_HOME_CANARY_PROMPT,
      request.timeoutMs, request.killGraceMs ?? SESSION_KILL_GRACE_MS);
    let problem = canarySessionProtocolProblem(run, label);
    if (problem === null && run.privateHome !== plant.home) {
      problem = `the ${label} reported a different private_home instead of the caller home`;
    }
    if (problem === null && resumed && run.sessionId !== sessionId) {
      problem = `the ${label} changed the session id across resume`;
    }
    if (problem === null && run.stdout.includes(plant.operatorMarker)) {
      problem = `the ${label} exposed the operator-home code word`;
    }
    if (problem === null && run.assistantText.trim() !== plant.skillMarker) {
      problem = `the ${label} did not answer with only the caller's private skill code word`;
    }
    if (problem === null && (!existsSync(plant.home) || !existsSync(plant.skillPath))) {
      problem = `the ${label} removed the caller home or its private skill`;
    }
    if (problem !== null) {
      console.error(`Error: ${problem}`);
      const detail = sessionFailureDetail(run);
      if (detail.length > 0) console.error(detail.join("\n"));
      return 1;
    }
    sessionId = run.sessionId;
  }
  console.error("Caller-home session kept its private skill and home across resume and --final");
  return 0;
}

/** Independent entry point for caller-owned isolation. Cursor, Qwen, and
 * OpenHands do not need a successful disposable-hermetic canary first.
 * The caller supplies an authenticated synthetic/native root or credential
 * environment. This runner never claims to test --hermetic. */
export async function runCallerHarnessHomeCanary(
  request: HermeticSessionCanaryRequest,
  input: { authenticatedHome?: string; environment?: NodeJS.ProcessEnv; parent?: string } = {}
): Promise<number> {
  if (!supportsHarnessHomeCanary(request.agent)) throw new Error(`${request.agent} has no caller-home canary layout`);
  const plant = plantHarnessHomeCanary(request.agent, input.authenticatedHome, input.environment, input.parent);
  try { return await runHarnessHomeSessionCanary(request, plant); }
  finally { plant.cleanup(); }
}
