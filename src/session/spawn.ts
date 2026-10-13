/**
 * The session spawn path (design §4.7): a peer of `runSandboxedWithStdin`
 * in cli-runtime.ts, not a detour through it — that path writes stdin
 * once and closes it, caps capture at 16 MiB, and force-kills 2 s after
 * a signal, all wrong for a hours-long bidirectional stream. Every seam
 * that makes "codemux executes only what it validated" true is reused
 * verbatim here: the working-directory validation, the project scode
 * policy refusal, the scode resolution and compatibility probe, the
 * trusted-command resolution, the --keep-env resolution, and the scode
 * argv/env builders. A parity test asserts the scode argv prefix and
 * environment this builds match `run`'s for the same request.
 */

import {
  assertCompatibleScode,
  assertNoProjectScodePolicy,
  resolveKeepEnvSandboxOptions,
  resolveScodeExecutableForEnv,
} from "../cli-runtime.js";
import { resolveTrustedCommand } from "../executable-security.js";
import { buildSandboxEnv, buildScodeCommand, type SandboxOptions } from "../sandbox.js";
import { validateWorkingDirectory } from "../validation.js";
import type { AutonomyLevel } from "../types.js";
import type { SessionFatal } from "./process.js";
import { SessionProcess } from "./process.js";

export interface SessionSpawnOptions {
  cwd?: string;
  sandboxed: boolean;
  /** The autonomy the caller asked for; it selects the scode policy. */
  autonomy: AutonomyLevel;
  sandboxOptions?: SandboxOptions;
  graceMs?: number;
  /** Adapter env omissions, deleted from the sandbox environment like
   * `runSandboxedWithStdin` deletes them (belt over buildExecutionEnv). */
  envOmissions?: readonly string[];
}

/**
 * Spawn the session child — scode-wrapped by default, direct otherwise —
 * returning the streaming process. Every pre-spawn check mirrors
 * `runSandboxedWithStdin` (async because the scode compatibility probe
 * is), minus the capture/timeout machinery a stream must not have. The
 * one deliberate exception: run's scode-accounting checks
 * (`assertScodeSupportsAccounting`, `warnIfSinkInsideWorkdir`) have no
 * counterpart here because the session surface exposes no accounting
 * flags — `sandboxOptions.accountFile` can never be set on this path.
 */
export async function spawnSessionChild(
  command: string[],
  env: Record<string, string>,
  options: SessionSpawnOptions,
  hooks: {
    onLine: (line: string) => void;
    onFatal: (fatal: SessionFatal) => void;
  }
): Promise<SessionProcess> {
  const workdir = validateWorkingDirectory(options.cwd) ?? process.cwd();
  // The same shape rule `resolveExecutionCommand` holds the run path to:
  // a NUL in any argument can never be a real argv element.
  if (
    command.length === 0 ||
    typeof command[0] !== "string" ||
    command[0].length === 0 ||
    command.some((argument) => typeof argument !== "string" || argument.includes("\0"))
  ) {
    throw new Error("session command produced an invalid command");
  }
  if (options.sandboxed) {
    assertNoProjectScodePolicy(workdir);
    // The launch environment's PATH, the same resolver the run runner
    // uses (resolveScodeExecutableForEnv): the session's scode and the
    // run's are one binary for one launch environment, never two
    // lookups that can disagree (round al14).
    const scode = resolveScodeExecutableForEnv(env, workdir);
    if (!scode) throw new Error("scode is not installed");
    await assertCompatibleScode(scode, workdir, env);
    // The keep-env seam the run runner owns (runSandboxedWithStdin): the
    // session's sandbox options may carry the exemption for the env the
    // CLI injected (an override's credential above all), and the same
    // resolver decides — keep, drop, or refuse with the run path's
    // message — so the two spawn paths cannot drift.
    const effectiveSandboxOptions = await resolveKeepEnvSandboxOptions(
      scode,
      workdir,
      env,
      options.sandboxOptions
    );
    const resolved = resolveTrustedCommand(
      command,
      "sandbox command",
      workdir,
      env.PATH ?? ""
    );
    const scodeCmd = buildScodeCommand(
      resolved,
      workdir,
      options.autonomy,
      effectiveSandboxOptions,
      scode
    );
    const sandboxEnv = buildSandboxEnv(env, effectiveSandboxOptions);
    for (const name of options.envOmissions ?? []) delete sandboxEnv[name];
    return new SessionProcess({
      command: scodeCmd,
      cwd: workdir,
      env: sandboxEnv,
      graceMs: options.graceMs,
      ...hooks,
    });
  }
  // The direct half mirrors runDirect in launch.ts: the same trusted
  // resolution, the caller-provided execution environment, no scode.
  const resolved = resolveTrustedCommand(
    command,
    "session command",
    workdir,
    env.PATH ?? ""
  );
  return new SessionProcess({
    command: resolved,
    cwd: workdir,
    env,
    graceMs: options.graceMs,
    ...hooks,
  });
}
