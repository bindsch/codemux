import { getScodeCompatibilityStatus } from "../src/cli-runtime.js";
import { executableCheck, resolveTrustedExecutable } from "../src/executable-security.js";
import { runCapturedCommand } from "../src/process-runner.js";
import { withoutAmbientScodeEnv } from "../src/sandbox.js";
import { isNamespaceCapabilityFailure } from "../src/scode-namespace.js";

// CI greps for this exact line: the macOS runner fails when it appears
// (scode must be installed there), and the Linux runner prints a visible
// warning, so a skip is legible in the log on both platforms.
const SKIPPED_LINE = "scode contract SKIPPED on this runner";

const status = await getScodeCompatibilityStatus();
if (!status.available) {
  console.log(SKIPPED_LINE);
  process.exit(0);
}

if (status.issue) {
  console.error(status.issue);
  process.exit(1);
}

// The version probe proves the binary, not the sandbox: one trivial
// sandboxed command decides whether this runner can run the sandboxed
// contracts at all.
const resolved = Bun.which("scode", { PATH: process.env.PATH });
if (!resolved) {
  console.error("scode vanished between the version probe and the sandbox probe");
  process.exit(1);
}
let trusted: string;
try {
  trusted = resolveTrustedExecutable(resolved, "scode", process.cwd());
} catch (error) {
  // The same condition the live gate's contract column prints as UNTRUSTED
  // (round 35, contracts 8): a named verdict, not a stack trace.
  console.error(`scode is not a trusted executable: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
// This probe's own resolution, carried to the runner's pre-spawn re-stat
// (round 23, edges 1).
const scodeCheck = executableCheck(trusted);
// The payload is the POSIX shell every supported host carries at /bin/sh;
// /usr/bin/true is absent on NixOS (round 26, edges 5).
const probe = await runCapturedCommand([trusted, "--", "/bin/sh", "-c", "exit 0"], {
  cwd: process.cwd(),
  // The same scrub a real launch's scode spawn gets (review round 162,
  // finding 4): an ambient SCODE_ACCOUNT_FILE must not turn this
  // contract probe into a write to the path it names.
  env: withoutAmbientScodeEnv(process.env as unknown as Record<string, string>),
  timeoutMs: 10_000,
  requiredPaths: [trusted],
  checks: scodeCheck === null ? undefined : [scodeCheck],
});
if (probe.exitCode === 0) {
  console.log("scode sandbox contract passed");
  process.exit(0);
}
const detail = `${probe.stdout}\n${probe.stderr}`.trim();
if (isNamespaceCapabilityFailure(detail)) {
  console.log(SKIPPED_LINE);
  process.exit(0);
}
console.error(`scode could not run one sandboxed command (/bin/sh -c 'exit 0'): ${detail}`);
process.exit(1);
