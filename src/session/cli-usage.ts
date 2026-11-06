// Usage and exit-code funnels for the `codemux session` action: the 64
// refusal path, the resume verdict's 66/78/1 mapping, and the optional
// timeout parse. src/session/cli.ts owns the command and its phases.
import { parseTimeoutOption } from "../cli-runtime.js";
import type { ResumeLookup } from "./registry.js";

/** Usage/validation: nothing has started (design §4.6). */
export function usageError(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(64);
}

/** A flag value one of run's shared validators refuses is usage too:
 * they throw plain errors, which the outer catch exits 1 as unexpected
 * (review live25: `--pass-env ","` and an effort or autonomy level the
 * agent lacks exited 1 where the header documents 64). */
export function asUsage<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
  }
}

export function exitWithCode(code: number, message: string): never {
  console.error(`Error: ${message}`);
  process.exit(code);
}

/** The resume verdict's exit codes (§4.8): not found is 66; refused and
 * untrusted are 78. Untrusted is a policy refusal, not a missing entry:
 * the registry exists but codemux will not vouch from it. Its message
 * names the file, because an operator told the registry is unreadable
 * or corrupt needs the path to fix it. Unavailable (a busy lock, an I/O
 * error during the claim) judged nothing and may pass on a retry, so it
 * exits 1 like the same failure on a fresh session, never the policy
 * code a broker treats as permanent (review live22). */
export function exitOnResumeRefusal(id: string, registryPath: string, lookup: ResumeLookup): void {
  if (lookup.outcome === "not_found") {
    exitWithCode(66, `no recorded session has the id ${id}`);
  }
  if (lookup.outcome === "untrusted") {
    exitWithCode(78, `cannot resume ${id}: ${lookup.reason} (registry: ${registryPath})`);
  }
  if (lookup.outcome === "refused") {
    exitWithCode(78, `cannot resume ${id}: ${lookup.reason}`);
  }
  if (lookup.outcome === "unavailable") {
    exitWithCode(1, `cannot resume ${id}: ${lookup.reason} (registry: ${registryPath})`);
  }
}

export function parseOptionalTimeout(seconds: string | undefined, flag: string): number | null {
  if (seconds === undefined) return null;
  try {
    return parseTimeoutOption(seconds);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    usageError(detail.replace("--timeout", flag));
  }
}

/** `--resume <id>`: the id must match the agent's session id shape (the
 * registry check follows). One rule for the request phase, which runs it
 * before the availability checks, and the resume phase, which keys a
 * codex override home by the id. */
export function assertResumeIdShape(
  support: { resumePattern: RegExp; resumeLabel: string },
  resume: string
): void {
  if (!support.resumePattern.test(resume)) {
    usageError(
      `--resume expects a ${support.resumeLabel} session id; '${resume}' is not one`
    );
  }
}
