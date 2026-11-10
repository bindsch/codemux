/**
 * Keychain hygiene for the live gate (2026-11-03). A sandboxed agy run gives
 * its private HOME a private Keychain and must leave the operator's user
 * search list and default keychain exactly as it found them; a mirror left
 * behind is what produces the macOS prompt "a keychain cannot be found to
 * store antigravity" the next time any process stores a credential. The gate
 * snapshots both before and after every probe and fails the probe on any
 * difference. Not macOS, or no `security` on PATH: no snapshot, no check —
 * and on macOS a snapshot that goes missing between the two observations is
 * itself a failure (review round 87): a pool that ran unobserved is never
 * certified clean.
 */

import { resolveTrustedExecutable } from "../../src/executable-security.js";

/** A snapshot is the two answers, or the reason the state could not be
 * observed (a failing `security` is a failure of the check, never a match:
 * review round 43). null: not macOS, or no `security` on PATH. The
 * platform is a parameter, like keychainCheckApplies's, so the macOS path
 * runs against a fake `security` on any host (a Linux CI run skipped it and
 * the file fell under the 80% coverage floor: CI run 42725301093). */
export type KeychainSnapshot = { ok: true; text: string } | { ok: false; reason: string };

export const keychainSnapshot = async (
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<KeychainSnapshot | null> => {
  if (platform !== "darwin") return null;
  const resolved = Bun.which("security", { PATH: environment.PATH ?? "" });
  if (resolved === null) return null;
  let security: string;
  try {
    security = resolveTrustedExecutable(resolved, "security", process.cwd());
  } catch (error) {
    return { ok: false, reason: `the security tool is not trusted: ${error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error)}` };
  }
  const parts: string[] = [];
  for (const args of [["list-keychains", "-d", "user"], ["default-keychain", "-d", "user"]]) {
    try {
      // A bounded local read through spawnSync: the signal-forwarding
      // runner would register its own signal listeners beside a running
      // probe, and a signal during the pool would then reach them too.
      const result = Bun.spawnSync([security, ...args], {
        cwd: process.cwd(),
        env: environment as unknown as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      if (result.exitCode !== 0) return { ok: false, reason: `security ${args[0]} exited ${result.exitCode}` };
      parts.push(`${args[0]}: ${result.stdout.toString("utf8").trim()}`);
    } catch (error) {
      return { ok: false, reason: `security ${args[0]}: ${error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error)}` };
    }
  }
  return { ok: true, text: parts.join("\n") };
};

/** Whether this is a platform the Keychain hygiene check covers: macOS.
 * Elsewhere the check cannot apply and never fails the gate (the
 * non-macOS behavior stays as it was). */
export const keychainCheckApplies = (platform: NodeJS.Platform = process.platform): boolean =>
  platform === "darwin";

/** Why the gate must stop before its probe pool, or null when the
 * baseline is usable: the snapshot before the pool is missing on a
 * platform the check covers, or it was attempted and failed (the
 * security tool timed out, exited nonzero, or is untrusted). A pool
 * whose starting state was never observed is not run at all (review
 * rounds 87 and 88). */
export function keychainBaselineRefusal(
  before: KeychainSnapshot | null,
  applies: boolean = keychainCheckApplies()
): string | null {
  if (before === null) {
    return applies ? "the snapshot before the pool could not be taken (no security tool on PATH)" : null;
  }
  return before.ok ? null : `the snapshot before the pool failed (${before.reason})`;
}

/** The probe failure when the snapshots differ or either could not be
 * taken; null when both were observed and match, or when there was
 * nothing to observe on this machine — both snapshots missing, the one
 * shape that says the check does not apply rather than went missing.
 * One snapshot present and the other missing means the state during the
 * pool is unknown, and the drift is reported naming the missing side
 * (review round 87): that is a failure, never a pass. */
export const keychainDrift = (before: KeychainSnapshot | null, after: KeychainSnapshot | null): string | null => {
  if (before === null && after === null) return null;
  if (before === null) {
    return "the Keychain drift is unknown: the snapshot before the pool is missing, " +
      "so the state the probes started from was never observed";
  }
  if (after === null) {
    return "the Keychain drift is unknown: the snapshot after the pool is missing, " +
      "so whether the probes restored the Keychain state was never verified";
  }
  if (!before.ok) return `the Keychain state could not be observed before the probe: ${before.reason}`;
  if (!after.ok) return `the Keychain state could not be observed after the probe: ${after.reason}`;
  if (before.text === after.text) return null;
  return `the user Keychain search list or default keychain changed during this probe\nbefore:\n${before.text}\nafter:\n${after.text}`;
};
