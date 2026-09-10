import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AutonomyLevel } from "./types.js";

/**
 * Shared autonomy mapping for the adapters that drive the Claude Code CLI:
 * the `claude` agent and the `zai` agent's z.ai-hosted transport. The two
 * mappings must stay identical, so both delegate here.
 *
 * Why write-capable levels also carry --allowedTools grants: both adapters
 * set CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 (env hygiene for subprocesses).
 * Claude Code 2.1.25x couples that variable to a permission hardening:
 * when it is set, permission resolution force-returns "default" and
 * silently discards --permission-mode and --dangerously-skip-permissions
 * ("Permission mode forced to default ... (allowed_non_write_users
 * hardening)"). In headless runs, "default" denies every tool that would
 * prompt, so medium and high could no longer write files. Explicit allow
 * rules are the documented escape hatch ("Declare allowedTools
 * explicitly"), so they ride alongside the native flags.
 *
 * The native flags stay: versions without the hardening (<= the audited
 * 2.1.223) and any future upstream that decouples the variable behave
 * exactly as before. Under the hardening the grants do the work, and they
 * cannot fully reproduce --dangerously-skip-permissions: managed deny
 * rules, safety checks, and ungranted tools (WebFetch, MCP, ...) still
 * gate. The scode boundary remains the enforced limit below high.
 */
/** Claude permission rules need a double leading slash for an absolute
 * path: a single slash anchors at the working directory, and a relative
 * path tracks the child's mutable current directory. Canonicalize the
 * launch directory so neither an approved `cd` nor a symlinked `--cwd`
 * can move the grant. */
function grantRule(launchDir: string): string {
  let absolute = isAbsolute(launchDir) ? launchDir : resolve(launchDir);
  try {
    absolute = realpathSync(absolute);
  } catch {
    // An unresolvable launch directory fails the launch before this runs.
  }
  // macOS realpath keeps decomposed Unicode (NFD) while Claude normalizes
  // candidate paths to NFC; a decomposed name would produce a grant that
  // can never match its own files.
  absolute = absolute.normalize("NFC");
  // Characters the rule grammar cannot carry literally: a parenthesis
  // closes the rule early and what follows it becomes new grants (`repo
  // ),Bash,Edit(` would mint bare `Bash`), a backslash is consumed by the
  // pattern layers, and glob metacharacters would match siblings instead
  // of the launch directory. A comma or a space inside one rule value
  // stays literal (verified against the installed 2.1.258 parser). All of
  // these refuse the launch rather than misgrant.
  if (/[()\\[\]{}*?!]/.test(absolute)) {
    throw new Error(
      `cannot build a safe permission grant for "${absolute}": the path ` +
        "contains a parenthesis, a backslash, or a glob metacharacter " +
        "(* ? [ ] { } !), which the rule grammar cannot represent literally"
    );
  }
  // A tab or line break anywhere, or trailing whitespace, cannot be
  // represented: the matcher trims trailing whitespace (an escaped tab
  // even decodes back to a space), which would silently retarget the
  // grant to a sibling directory. Refuse rather than misgrant.
  if (/[\t\n\r]/.test(absolute) || /\s$/.test(absolute)) {
    throw new Error(
      `cannot build a safe permission grant for "${absolute}": the path ` +
        "contains a tab or line break, or ends with whitespace, which the " +
        "rule matcher cannot represent"
    );
  }
  // The path's own leading slash is replaced by the rule's `//` prefix.
  return `Edit(//${absolute.replace(/^\/+/, "")}/**)`;
}

/** The native Claude Code flag mapping, without any grants: what the TUI
 * emits, where a human is present to approve. */
export function claudeNativeAutonomyFlags(level: AutonomyLevel): string[] {
  switch (level) {
    case "read-only":
      // The hardening discards plan mode like every other mode: headless
      // still denies writes either way, a hardened TUI prompts instead of
      // planning, and the scode --ro boundary remains what actually
      // enforces read-only.
      return ["--permission-mode", "plan"];
    case "low":
      return ["--permission-mode", "manual"];
    case "medium":
      return ["--permission-mode", "acceptEdits"];
    case "high":
      return ["--dangerously-skip-permissions"];
  }
}

/** The headless mapping: the native flags plus explicit allow rules, the
 * hardening's documented escape hatch (see grantRule). Write and
 * NotebookEdit follow Edit rules, so the medium rule covers the three
 * editing tools; Bash stays gated there. At high the grants are a subset
 * of the bypass high always requested. Grants ride only on headless runs;
 * the TUI keeps the native flags so a human approves. */
export function claudeAutonomyFlags(
  level: AutonomyLevel,
  launchDir: string
): string[] {
  const flags = claudeNativeAutonomyFlags(level);
  if (level === "medium") {
    return [
      ...flags,
      "--allowedTools",
      grantRule(launchDir),
    ];
  }
  if (level === "high") {
    return [...flags, "--allowedTools", "Edit", "Write", "NotebookEdit", "Bash"];
  }
  return flags;
}
