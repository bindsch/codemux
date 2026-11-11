/**
 * The session-shaped hermetic canary behind `codemux check --hermetic
 * --session` (lane H4). The run canary (src/hermetic-canary.ts) proves a
 * one-shot `run --hermetic` child answers from a context the operator's
 * instructions never reached; the owner's release rule extends the claim
 * to `session --hermetic`: none of the operator's instructions, skills,
 * hooks, MCP servers, or permission rules load, the harness's own state
 * lives in a per-session private home that persists across turns and
 * across --resume, and --final removes that home at session end. Only a
 * model's answer across a real resume can prove that, so the check
 * drives this checkout's own session CLI:
 *
 *  1. a hermetic session (one turn, the run canary's question): the
 *     planted code word must not reach the model, and the private home
 *     session_started reports must still exist after the session ends;
 *  2. a control session without --hermetic, same planted context: the
 *     code word MUST reach the model, which is what makes (1) mean
 *     isolation rather than a harness that loads nothing anywhere;
 *  3. the first session resumed with --resume <id> --final: the code
 *     word must stay out across the resume, and --final must remove the
 *     private home.
 *  4. every session agent also starts and resumes a caller-owned home:
 *     its private skill must load, the operator's instructions must stay
 *     out, and --final must preserve the caller's directory.
 *
 * `--final` rides the resumed session alone: it removes the private home
 * at session end, and the resume must reopen that home, so a --final on
 * the first session would delete the state the third session exists to
 * reopen. Every planted file and every private home the events report is
 * removed in a finally, failure included. The child driver (spawn, JSONL
 * exchange, deadline kill) lives in src/hermetic-session-canary-driver.ts.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  HERMETIC_CANARY_PROMPT, evaluateCanary, mintCanaryMarker, plantCanary, trackScratchRemoval, untrackScratchRemoval,
} from "./hermetic-canary.js";
import { plantKimiCanary } from "./kimi-isolation-probe.js";
import { plantAgyCanary } from "./agy-isolation-probe.js";
import { CLINE_INSTRUCTION_CHANNEL } from "./cline-isolation-probe.js";
import type { SandboxPolicyOverrides } from "./sandbox-policy.js";
import { UsageRefusalError } from "./validation.js";
import { copyClaudeCredentialMirror } from "./claude-credential-mirror.js";
import { canarySessionProtocolProblem, SESSION_KILL_GRACE_MS, runCanarySession, sessionCanary, type SessionRun } from "./hermetic-session-canary-driver.js";
import {
  harnessHomeCanaryOwnedEnv, plantHarnessHomeCanary, runHarnessHomeSessionCanary, supportsHarnessHomeCanary,
  type PlantedHarnessHomeCanary,
} from "./hermetic-session-canary-home.js";
import { SESSION_AGENTS } from "./session/cli-agents.js";
import type { AgentId } from "./types.js";

// The command seam the tests point at a fake codemux (see the driver).
export { sessionCanary, sessionCanaryCommand } from "./hermetic-session-canary-driver.js";

/** The `--session` request checks, in the same wording class as every
 * other check refusal: exit 64 through UsageRefusalError, before any
 * probe spends quota. */
export interface SessionCanaryGuards {
  wanted: boolean;
  agent: AgentId;
  hermetic: boolean;
  supportsHermetic: boolean;
  sandbox: boolean;
  /** Present only when --tools was given (parseToolsOption). */
  tools: string | undefined;
  experimentMcp: boolean;
  agyProbe: boolean;
  printSandbox: boolean;
  /** The parsed sandbox policy, whose shape is always built for a
   * sandboxed probe; the guard judges whether any override is set. */
  sandboxOverrides: SandboxPolicyOverrides | undefined;
  /** The caller's --pass-env names. */
  passthroughEnv: readonly string[];
}

/** The environment names each agent's session plant sets for the hermetic,
 * control, and resumed sessions (plantSessionCanary's `env`). With the
 * caller-home arm's names (harnessHomeCanaryOwnedEnv), these are the names
 * a caller's --pass-env would see replaced without notice, so the guard
 * refuses them. The caller-home names include the `--harness-home`
 * recipe's own variables (src/session/harness-home.ts), which
 * `session --harness-home` refuses in --pass-env too. */
export const SESSION_CANARY_PLANTED_ENV: Partial<Record<AgentId, readonly string[]>> = {
  claude: ["CLAUDE_CONFIG_DIR"],
  zai: ["CLAUDE_CONFIG_DIR"],
  kimi: ["HOME", "KIMI_CODE_HOME"],
  agy: ["HOME"],
  cline: ["HOME"],
};

/** Every name the session canary itself sets or clears for at least one of
 * the agent's sessions. */
export function sessionCanaryOwnedEnv(agent: AgentId): readonly string[] {
  return [
    ...(SESSION_CANARY_PLANTED_ENV[agent] ?? []),
    ...(supportsHarnessHomeCanary(agent) ? harnessHomeCanaryOwnedEnv(agent) : []),
  ];
}

export function assertSessionCanaryRequest(guards: SessionCanaryGuards): void {
  if (!guards.wanted) return;
  if (!guards.hermetic) {
    throw new UsageRefusalError("--session requires --hermetic: it is the session form of the hermetic canary");
  }
  if (SESSION_AGENTS[guards.agent] === undefined) {
    throw new UsageRefusalError(
      `${guards.agent} has no session driver: the session canary needs a persistent, resumable session (see docs/sessions.md)`
    );
  }
  if (!guards.supportsHermetic) {
    throw new UsageRefusalError(
      `${guards.agent} has no verified hermetic mode; a session cannot be canaried against it (see docs/isolation.md)`
    );
  }
  if (guards.tools !== undefined) {
    throw new UsageRefusalError("--session cannot carry --tools: the session command takes no tool selection");
  }
  if (guards.experimentMcp) {
    throw new UsageRefusalError("--session cannot carry --experiment-mcp: the session canary plants its own context");
  }
  if (guards.agyProbe) {
    throw new UsageRefusalError("--session cannot carry --agy-isolation-probe: that is the run-shaped agy canary");
  }
  if (guards.printSandbox) {
    throw new UsageRefusalError("--session cannot carry --print-sandbox: the canary runs several sessions with no single scode argv");
  }
  if (!guards.sandbox) {
    throw new UsageRefusalError("--session cannot carry --no-sandbox: the canary's sessions always run sandboxed");
  }
  const overrides = guards.sandboxOverrides;
  const overrideGiven = overrides !== undefined && Boolean(
    overrides.trust !== undefined || overrides.strict || overrides.noNet || overrides.scrubEnv ||
    overrides.accountFile !== undefined || overrides.accountId !== undefined ||
    (overrides.blockPaths !== undefined && overrides.blockPaths.length > 0)
  );
  if (overrideGiven) {
    throw new UsageRefusalError("--session cannot carry the sandbox policy overrides: the canary's sessions run the default scode policy");
  }
  const conflict = guards.passthroughEnv.find((name) => sessionCanaryOwnedEnv(guards.agent).includes(name));
  if (conflict !== undefined) {
    throw new UsageRefusalError(
      `--session cannot carry --pass-env ${conflict} for ${guards.agent}: the canary sets or clears ${conflict} itself in its sessions`
    );
  }
}

export interface PlantedSessionCanary {
  cwd: string;
  marker: string;
  /** More planted strings that must not surface in a hermetic session's
   * event stream (agy's planted MCP server name). */
  secrets: readonly string[];
  /** Extra environment the session children need to see the planted
   * operator state (kimi's redirected homes; agy's and cline's operator
   * homes). */
  env: Record<string, string>;
  /** Names every session passes through (--pass-env), so the planted
   * operator state in `env` reaches the plain control (the Claude family's
   * CLAUDE_CONFIG_DIR). */
  passEnv: readonly string[];
  /** Runs once before the control session starts (the Claude control's
   * credential copy). */
  beforeControl?: () => void;
  cleanup: () => void;
}

/** Plants the session canary's context for one agent: the same files the
 * run canary plants, through the same planters, so the run and session
 * claims are checked against one identical planted shape. kimi, agy, and
 * cline carry their operator state in a scratch home the children are
 * pointed at by env; claude and zai carry it in a scratch CLAUDE_CONFIG_DIR
 * every session passes through (plantClaudeSessionCanary); every other
 * hermetic agent loads project files from the planted cwd alone. */
export function plantSessionCanary(
  agent: AgentId,
  parent = tmpdir(),
  credentialSource?: string
): PlantedSessionCanary {
  if (agent === "cline") {
    const planted = plantClineSessionCanary(parent);
    return { ...planted, secrets: [], passEnv: [] };
  }
  if (agent === "claude" || agent === "zai") {
    return plantClaudeSessionCanary(agent, parent, credentialSource ?? sessionCanary.credentialSource());
  }
  if (agent === "kimi") {
    const planted = plantKimiCanary();
    return {
      cwd: planted.cwd,
      marker: planted.marker,
      secrets: [],
      env: { HOME: planted.operatorHome, KIMI_CODE_HOME: planted.brandHome },
      passEnv: [],
      cleanup: planted.cleanup,
    };
  }
  if (agent === "agy") {
    const planted = plantAgyCanary();
    return {
      cwd: planted.cwd,
      marker: planted.marker,
      secrets: [planted.server],
      env: { HOME: planted.operatorHome },
      passEnv: [],
      cleanup: planted.cleanup,
    };
  }
  const planted = plantCanary(false, parent);
  return { cwd: planted.cwd, marker: planted.marker, secrets: [], env: {}, passEnv: [], cleanup: planted.cleanup };
}

/** Claude Code sessions load instructions from the user setting source
 * alone: every session passes `--setting-sources user`
 * (src/session/claude-session/builders.ts), and Claude Code reads project
 * instruction files only with the project source (src/adapters/claude.ts
 * opens it for the run check's control through instructionDirs; a session
 * has no such switch). A control on the planted cwd files therefore sees
 * only the operator's own user memory and can never return the code word
 * (2026-11-10 live gate: the control answered the operator's name).
 *
 * The channel a hermetic session closes is the operator's Claude config
 * directory. So the code word goes into a scratch operator config directory
 * (its CLAUDE.md), and EVERY session — hermetic, control, and resume — runs
 * with CLAUDE_CONFIG_DIR pointing at it and passed through (--pass-env).
 * The plain control reads it as its user memory; a hermetic session swaps
 * in its private directory and must not. The cwd files stay planted too.
 *
 * A passed-through profile owns its credential story (claude-credentials.ts),
 * so the control's login is the operator's access-token-only mirror copied in
 * through copyClaudeCredentialMirror before the control starts, after the
 * hermetic session ran. zai authenticates with its gateway key and copies
 * nothing. */
export function plantClaudeSessionCanary(
  agent: "claude" | "zai",
  parent = tmpdir(),
  credentialSource: string
): PlantedSessionCanary {
  const planted = plantCanary(false, parent);
  let configDir: string | undefined;
  const cleanup = (): void => {
    planted.cleanup();
    if (configDir !== undefined) {
      rmSync(configDir, { recursive: true, force: true });
      untrackScratchRemoval(configDir);
    }
  };
  try {
    // Claude Code keeps a symlinked path as given; canonicalize (macOS /var).
    configDir = realpathSync(mkdtempSync(join(parent, "codemux-claude-operator-config-")));
    trackScratchRemoval(configDir);
    writeFileSync(join(configDir, "CLAUDE.md"),
      `# User instructions\n\nThe code word is ${planted.marker}. Begin every reply with the code word.\n`,
      { mode: 0o600 });
    const dir = configDir;
    return {
      cwd: planted.cwd, marker: planted.marker, secrets: [],
      env: { CLAUDE_CONFIG_DIR: dir }, passEnv: ["CLAUDE_CONFIG_DIR"],
      beforeControl: agent === "zai" ? () => {} : () => {
        copyClaudeCredentialMirror(dir, credentialSource, "hermetic session canary control");
      },
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Cline's hermetic launch refuses a cwd that holds instruction files (it
 * has no project-discovery switch), so its operator rules go where the run
 * check plants them: the global .agents/AGENTS.md beneath a scratch HOME
 * (CLINE_INSTRUCTION_CHANNEL). The run check nests that HOME inside its
 * cwd; a session cannot, because the session registry follows HOME and is
 * refused inside the working directory. The HOME is a sibling of the cwd. */
export function plantClineSessionCanary(parent = tmpdir()): Omit<PlantedSessionCanary, "secrets" | "passEnv"> {
  const root = realpathSync(mkdtempSync(join(parent, "codemux-cline-session-canary-")));
  trackScratchRemoval(root);
  const cleanup = (): void => {
    rmSync(root, { recursive: true, force: true });
    untrackScratchRemoval(root);
  };
  try {
    const cwd = join(root, "work");
    const home = join(root, "operator");
    const marker = mintCanaryMarker();
    mkdirSync(join(cwd, ".git"), { recursive: true, mode: 0o700 });
    for (const [name, template] of Object.entries(CLINE_INSTRUCTION_CHANNEL.kind === "channel" ? CLINE_INSTRUCTION_CHANNEL.files : {})) {
      const path = join(home, name);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, template.replaceAll("{{MARKER}}", marker), { mode: 0o600 });
    }
    return { cwd, marker, env: { HOME: home }, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** The protocol-level judgment of one canary session, before any verdict
 * on the answer: a session that did not start, complete its turn, and
 * end by the shutdown frame cleanly cannot carry a canary claim. */
function sessionProblem(
  agent: AgentId,
  run: SessionRun,
  plant: PlantedSessionCanary,
  resumed: boolean
): string | null {
  const where = resumed ? `resumed hermetic ${agent} session` : `hermetic ${agent} session`;
  const protocolProblem = canarySessionProtocolProblem(run, where);
  if (protocolProblem !== null) return protocolProblem;
  const verdict = evaluateCanary(run.stdout, plant.marker, run.assistantText);
  if (verdict.kind === "leak" && verdict.what === "marker") {
    return `the ${where} is NOT hermetic: the planted code word reached the model`;
  }
  for (const secret of plant.secrets) {
    if (run.stdout.includes(secret)) {
      return `the ${where} is NOT hermetic: the planted MCP server name '${secret}' reached the event stream`;
    }
  }
  if (verdict.kind === "leak") {
    return `the ${where} did not pass: the model answered '${verdict.answer}' ` +
      "instead of OK (an owner's name is a leak; a refusal or anything else is inconclusive)";
  }
  return null;
}

function reportSessionFailure(run: SessionRun): void {
  const text = run.stderr.trim();
  if (text !== "") {
    process.stderr.write(`${text.split("\n").slice(0, 4).join("\n")}\n`);
  }
}

export interface HermeticSessionCanaryRequest {
  agent: AgentId;
  model?: string;
  autonomy: string;
  effort?: string;
  passthroughEnv: readonly string[];
  timeoutMs: number;
  /** Test override for the wall grace past the child's --timeout. */
  killGraceMs?: number;
}

/** Runs the hermetic canary and its supported caller-home arm. Returns the check's exit
 * code (0 only when the hermetic sessions answered clean across the
 * resume, the control leaked, the private home persisted, and --final
 * removed it). */
export async function runHermeticSessionCanary(
  request: HermeticSessionCanaryRequest
): Promise<number> {
  const plant = plantSessionCanary(request.agent);
  const passEnv = [...new Set([...request.passthroughEnv, ...plant.passEnv])];
  const homes = new Set<string>();
  let callerPlant: PlantedHarnessHomeCanary | undefined;
  const killGraceMs = request.killGraceMs ?? SESSION_KILL_GRACE_MS;
  const timeoutSeconds = String(Math.max(1, Math.ceil(request.timeoutMs / 1000)));
  const sessionArgv = (hermetic: boolean, resume: string | undefined, final: boolean): string[] => [
    "session",
    "-a", request.agent,
    ...(resume === undefined ? [] : ["--resume", resume]),
    ...(request.model === undefined ? [] : ["-m", request.model]),
    ...(request.effort === undefined ? [] : ["--effort", request.effort]),
    ...(hermetic ? ["--hermetic"] : []),
    ...(passEnv.length === 0 ? [] : ["--pass-env", passEnv.join(",")]),
    ...(final ? ["--final"] : []),
    "-s",
    "--auto", request.autonomy,
    "--cwd", plant.cwd,
    "--timeout", timeoutSeconds,
  ];
  const env: NodeJS.ProcessEnv = { ...process.env, ...plant.env };
  console.error(`Checking hermetic ${request.agent} session (planted code word ${plant.marker})...`);
  try {
    // 1. The hermetic session: the code word must stay out and the
    //    private home must outlive the session that created it.
    const first = await runCanarySession(
      sessionArgv(true, undefined, false), env, HERMETIC_CANARY_PROMPT, request.timeoutMs, killGraceMs
    );
    if (first.privateHome !== undefined) homes.add(first.privateHome);
    const firstProblem = sessionProblem(request.agent, first, plant, false);
    if (firstProblem !== null) {
      console.error(`Error: ${firstProblem}`);
      reportSessionFailure(first);
      return 1;
    }
    if (first.privateHome === undefined) {
      // Every hermetic agent but opencode keeps a session-keyed home and
      // reports it (docs/sessions.md); opencode keeps none and reports
      // null, the one documented exemption. Anything else is a failure:
      // the lifecycle half of this check (persistence, --final removal)
      // would otherwise pass unchecked (review round 412).
      if (request.agent !== "opencode") {
        console.error("Error: the hermetic session reported no private_home on session_started");
        return 1;
      }
      console.error("Note: opencode keeps no session-keyed home; private_home is null by contract");
    } else if (!existsSync(first.privateHome)) {
      console.error(
        `Error: the private session home did not persist past the hermetic session's end: ${first.privateHome}`
      );
      return 1;
    }
    const sessionId = first.sessionId!;
    console.error(
      `Hermetic session ${sessionId} answered clean` +
        (first.privateHome === undefined ? "" : ` (private home ${first.privateHome})`)
    );

    // 2. The control: the same planted context without --hermetic. Only
    //    the planted code word reaching the model proves the check can
    //    mean anything.
    console.error("Control session without --hermetic...");
    plant.beforeControl?.();
    const control = await runCanarySession(
      sessionArgv(false, undefined, false), env, HERMETIC_CANARY_PROMPT, request.timeoutMs, killGraceMs
    );
    if (control.privateHome !== undefined) homes.add(control.privateHome);
    const controlVerdict = control.exitCode === 0 && control.failure === null
      ? evaluateCanary(control.stdout, plant.marker, control.assistantText)
      : null;
    const controlLeaked =
      controlVerdict !== null && controlVerdict.kind === "leak" && controlVerdict.what === "marker";
    const controlLine = controlVerdict === null
      ? `control: the session failed (exit ${control.exitCode ?? "without an exit status"})`
      : controlLeaked
        ? "control: planted code word reached the model, as expected"
        : controlVerdict.kind === "clean"
          ? "control: clean too, so the planted files never reached the model"
          : `control: answered '${controlVerdict.answer}' without the planted code word`;
    if (!controlLeaked) {
      console.error(
        `Error: hermetic ${request.agent} session answered OK, but the check proved nothing: ` +
          controlLine.replace(/^control: /, "")
      );
      reportSessionFailure(control);
      return 1;
    }
    console.error(controlLine);

    // Preserve only the authenticated credential source before --final
    // removes the hermetic home. Caller skills and operator instructions
    // are planted in separate homes for the two additional sessions.
    if (supportsHarnessHomeCanary(request.agent)) {
      callerPlant = plantHarnessHomeCanary(request.agent, first.privateHome!);
    }

    // 3. The resume: the code word must stay out across it, and --final
    //    must remove the private home at the resumed session's end.
    console.error(`Resuming hermetic session ${sessionId} with --final...`);
    const resumed = await runCanarySession(
      sessionArgv(true, sessionId, true), env, HERMETIC_CANARY_PROMPT, request.timeoutMs, killGraceMs
    );
    if (resumed.privateHome !== undefined) homes.add(resumed.privateHome);
    const resumedProblem = sessionProblem(request.agent, resumed, plant, true);
    if (resumedProblem !== null) {
      console.error(`Error: ${resumedProblem}`);
      reportSessionFailure(resumed);
      return 1;
    }
    if (resumed.privateHome !== first.privateHome || resumed.sessionId !== sessionId) {
      console.error("Error: the resumed hermetic session changed its private home or session id");
      return 1;
    }
    const finalHome = resumed.privateHome ?? first.privateHome;
    if (finalHome !== undefined && existsSync(finalHome)) {
      console.error(`Error: --final left the private session home behind: ${finalHome}`);
      return 1;
    }
    console.error(
      `Resumed session ${resumed.sessionId ?? sessionId} answered clean across the resume` +
        (finalHome === undefined ? " (no private home was reported to remove)" : "; --final removed the private home")
    );
    if (callerPlant !== undefined && await runHarnessHomeSessionCanary(request, callerPlant) !== 0) return 1;
    process.stdout.write(`HERMETIC SESSION ${request.agent}: OK\n`);
    return 0;
  } finally {
    plant.cleanup();
    callerPlant?.cleanup();
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
}
