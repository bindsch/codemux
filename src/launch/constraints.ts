// The request-against-options agreement the sandboxed launch branch
// enforces before anything spawns. src/launch.ts owns the lifecycle; these
// guards live here so each file stays under its size bound.
import type { LaunchOptions } from "../launch.js";
import { SCODE_TRUST_LEVELS, sandboxRestrictsNetwork } from "../sandbox.js";
import type { RunRequest } from "../types.js";
import { UsageRefusalError, validateWorkingDirectory } from "../validation.js";

/** The trust an omitted field resolves to (src/sandbox-policy.ts). */
const DEFAULT_SANDBOX_TRUST = "standard";

/** An omitted directory means process.cwd() on both sides; comparing the
 * canonicalized args alone made an explicit cwd equal to the current
 * directory look like a mismatch (the review's cwd finding). */
export function effectiveWorkingDirectory(value?: string): string {
  return validateWorkingDirectory(value) ?? process.cwd();
}

/** The request-against-options agreement for the sandbox fields the two
 * carry twice (review round 100). Returns the refusal message naming the
 * first disagreement, or null when the pair agrees. A request that claims
 * a constraint the options do not carry is refused, and so is a timeout
 * present on only one side or different on the two; an options-only
 * constraint (an untrusted trust level or a network restriction the
 * request never claims) runs, because the spawn is then at least as
 * constrained as the validated request, and the ledger receipt records
 * the sandbox that ran. A request that names no trust validated the
 * default one, so options that name `trusted` would run a weaker
 * sandbox than the request's and are refused (review round 101). The
 * mode itself is the first pair checked (review round 162): options
 * that spawn a sandbox the request does not claim validated one set of
 * constraints while the adapters build another (an adapter that reads
 * `request.sandboxed` to pick its native mode would enable it, one that
 * rejects unsandboxed requests would refuse), so only a matching pair
 * runs. */
function sandboxConstraintRefusal(
  request: RunRequest,
  options: LaunchOptions
): string | null {
  if (options.sandbox === true && request.sandboxed !== true) {
    return "the launch options run a sandbox the request does not claim";
  }
  if (request.sandboxNoNet === true && !sandboxRestrictsNetwork(options.sandboxPolicyOverrides)) {
    return "the request asks for a network-restricted sandbox but the launch options do not carry the restriction";
  }
  if (request.sandboxTrust !== undefined && options.sandboxPolicyOverrides?.trust !== request.sandboxTrust) {
    return `the request asks for sandbox trust '${request.sandboxTrust}' but the launch options do not carry it`;
  }
  const optionsTrust = options.sandboxPolicyOverrides?.trust ?? DEFAULT_SANDBOX_TRUST;
  if (
    request.sandboxTrust === undefined &&
    SCODE_TRUST_LEVELS.indexOf(optionsTrust) < SCODE_TRUST_LEVELS.indexOf(DEFAULT_SANDBOX_TRUST)
  ) {
    return `the launch options carry sandbox trust '${optionsTrust}', weaker than the default the request validated`;
  }
  if (request.timeoutMs !== options.timeoutMs) {
    return request.timeoutMs === undefined
      ? "the launch options carry a timeout the request does not name"
      : options.timeoutMs === undefined
        ? "the request names a timeout the launch options do not carry"
        : "the request and the launch options name different timeouts";
  }
  return null;
}

/** The sandboxed branch validates the REQUEST but the scode spawn executes
 * with the OPTIONS, so two different sets could validate a read-only
 * request and execute with high autonomy in another directory (review
 * round 64), or validate a network-restricted, untrusted, time-bounded
 * request and run it unrestricted (review round 100). Refused before
 * anything spawns; the special modes in the launcher pin the same
 * agreement with their own messages, so only matching pairs pass. */
export function assertSandboxedLaunchAgreement(
  request: RunRequest,
  options: LaunchOptions
): void {
  if (
    options.requestedAutonomy !== (request.autonomy ?? "read-only") ||
    effectiveWorkingDirectory(options.cwd) !== effectiveWorkingDirectory(request.cwd)
  ) {
    throw new UsageRefusalError(
      "sandboxed launch options must match the request: the scode spawn must run the validated autonomy in the validated working directory"
    );
  }
  const constraint = sandboxConstraintRefusal(request, options);
  if (constraint !== null) {
    throw new UsageRefusalError(
      `sandboxed launch options must match the request: ${constraint}`
    );
  }
}
