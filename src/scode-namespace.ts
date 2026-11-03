/** The scode namespace-probe vocabulary, shared by the machine check
 * (src/doctor-machine-check.ts) and CI's scode contract check
 * (scripts/check-scode-version.ts): one module so the two probes cannot
 * disagree about what counts as "this runner cannot sandbox" versus "the
 * sandbox is broken".
 *
 * A bubblewrap scode on a runner whose kernel refuses user namespaces
 * still answers --version, so only the sandboxed probe can detect it.
 * That refusal is bwrap's own text (scode execs bwrap and its stderr
 * rides the probe), so the skip matches exactly bwrap's user-namespace
 * failure lines at line start — every spelling verified against
 * bubblewrap's source (v0.8.0, v0.10.0, and current main; the "No
 * permissions to creating" typo form runs through v0.10.0, and current
 * main fixed it to "create a"). A defect whose message
 * merely mentions a namespace fails the gate (review round 11 edges 9;
 * round 12, contracts 2). */

export const NAMESPACE_FAILURE_PREFIXES: readonly string[] = [
  // The clone itself refused: EINVAL, EPERM, ENOSPC, and the bare-errno
  // forms all start with this (v0.9+ and older alike).
  "bwrap: Creating new namespace failed",
  "bwrap: No permissions to create a new namespace",
  // The v0.8.0–v0.10.0 spelling of the same EPERM refusal, typo intact:
  // quoted from bubblewrap.c's die() call, not corrected to grammar.
  "bwrap: No permissions to creating new namespace",
  // The user namespace formed but its identity maps could not be written.
  "bwrap: setting up uid map:",
  "bwrap: setting up gid map:",
  "bwrap: error writing to setgroups:",
];

export const isNamespaceCapabilityFailure = (output: string): boolean =>
  output.split("\n").some((line) =>
    NAMESPACE_FAILURE_PREFIXES.some((prefix) => line.startsWith(prefix))
  );
