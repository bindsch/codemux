/**
 * The session autonomy ceiling (design §4.1): pure, table-driven
 * predicates that decide whether one permission request is ALLOWABLE at
 * the session's start-time autonomy level. They never talk to a process
 * and never throw — a verdict is a value, so every driver's answer path
 * stays uniform.
 *
 * The ceiling is not the boundary (scode is); it is the rule that no
 * caller answer can exceed the autonomy the session launched with. A
 * caller `allow` on a request the ceiling denies is answered to the
 * harness as a deny and the caller line is rejected with
 * `autonomy_escalation` (the drivers, steps 5–8, do that; this module
 * only supplies the verdict).
 *
 * Fail-closed on what codemux cannot read: an unknown tool, a missing
 * tool name, an unparsable argument set, an unresolvable or unjudgeable
 * target path spelling, or an `updated_input` key outside the tool's
 * known schema all deny — when codemux cannot tell what the action is,
 * the answer is deny. Low
 * narrows that rule; it does not erase it. The level's meaning is "the
 * caller answers", so an unknown or ungranted tool is allow-able at low,
 * and so is a known tool without a schema (Read, WebFetch, Task,
 * `mcp__*`): there is nothing to check its arguments against. Only the
 * tools with a schema (Edit, Write, NotebookEdit, Bash) carrying a key
 * outside it still deny at low,
 * because the caller would be approving an action whose arguments nobody
 * parsed (the table below runs the schema check before low's fast path,
 * exactly as the tests pin it).
 */

import { lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AutonomyLevel } from "../types.js";
import { grantRule } from "../claude-autonomy.js";

/** A verdict the driver can log verbatim; `reason` is always set. */
export interface CeilingVerdict {
  allowable: boolean;
  reason: string;
}

const DENY_READ_ONLY: CeilingVerdict = {
  allowable: false,
  reason: "read-only allows no tool use",
};

const ALLOW_LOW: CeilingVerdict = {
  allowable: true,
  reason: "low allows every request",
};

/** The editing tools: judged on a target path inside the grant scope at
 * medium, on the bare grant at high. `pathKey` is the argument that names
 * the target; `inputKeys` is the tool's full known argument schema — an
 * argument outside it means codemux cannot tell what the action is. */
interface EditToolSpec {
  kind: "edit";
  pathKey: string;
  inputKeys: readonly string[];
}

/** Bash: granted bare at high, never at medium. */
interface BashToolSpec {
  kind: "bash";
  inputKeys: readonly string[];
}

/** Every other tool the recorded harnesses name: not granted at any
 * launchable level, so deny everywhere but low. */
interface OtherToolSpec {
  kind: "other";
}

type ToolSpec = EditToolSpec | BashToolSpec | OtherToolSpec;

/** The tool × level table (§4.1). Tools a harness may add without
 * codemux knowing them are NOT here — they hit the default-deny branch,
 * and the test suite diffs this table against the recorded init `tools`
 * fixture so the named set stays complete for the pinned versions. */
const TOOL_SPECS: Readonly<Record<string, ToolSpec>> = {
  Edit: { kind: "edit", pathKey: "file_path", inputKeys: ["file_path", "old_string", "new_string", "replace_all"] },
  Write: { kind: "edit", pathKey: "file_path", inputKeys: ["file_path", "content"] },
  NotebookEdit: { kind: "edit", pathKey: "notebook_path", inputKeys: ["notebook_path", "new_source", "cell_id", "cell_type", "edit_mode"] },
  Bash: { kind: "bash", inputKeys: ["command", "timeout", "description", "run_in_background"] },
  Read: { kind: "other" },
  Grep: { kind: "other" },
  Glob: { kind: "other" },
  LS: { kind: "other" },
  WebFetch: { kind: "other" },
  WebSearch: { kind: "other" },
  Task: { kind: "other" },
  Agent: { kind: "other" },
  Skill: { kind: "other" },
  SlashCommand: { kind: "other" },
  ExitPlanMode: { kind: "other" },
  TodoWrite: { kind: "other" },
  BashOutput: { kind: "other" },
  KillShell: { kind: "other" },
  AskUserQuestion: { kind: "other" },
  CronCreate: { kind: "other" },
  CronDelete: { kind: "other" },
  CronList: { kind: "other" },
  DesignSync: { kind: "other" },
  EnterPlanMode: { kind: "other" },
  EnterWorktree: { kind: "other" },
  ExitWorktree: { kind: "other" },
  ListAgents: { kind: "other" },
  Monitor: { kind: "other" },
  PushNotification: { kind: "other" },
  ReportFindings: { kind: "other" },
  ScheduleWakeup: { kind: "other" },
  SendMessage: { kind: "other" },
  TaskStop: { kind: "other" },
  Workflow: { kind: "other" },
};

/** MCP tools arrive as `mcp__<server>__<tool>`; no level grants them. */
const MCP_TOOL_PREFIX = "mcp__";

export function knownClaudeTools(): string[] {
  return Object.keys(TOOL_SPECS).sort();
}

function specFor(tool: string): ToolSpec | null {
  if (Object.hasOwn(TOOL_SPECS, tool)) return TOOL_SPECS[tool] as ToolSpec;
  if (tool.startsWith(MCP_TOOL_PREFIX)) return { kind: "other" };
  return null;
}

/**
 * The launch-directory scope, decoded from the one `grantRule`
 * implementation (src/claude-autonomy.ts) so the predicate and the
 * `--allowedTools` grant can never disagree. `grantRule` refuses unsafe
 * launch-directory grammar by throwing; here that is a deny verdict, not
 * an exception (the launch already failed such directories — this path
 * is drift, and drift denies).
 */
function launchScope(launchDir: string): string | null {
  let rule: string;
  try {
    rule = grantRule(launchDir);
  } catch {
    return null;
  }
  // The empty capture is the launch directory "/": grantRule strips the
  // root's leading slash to `Edit(///**)`, and the scope it encodes is
  // the root itself — every absolute path is inside it.
  const match = /^Edit\(\/\/(.*)\/\*\*\)$/.exec(rule);
  if (match === null) return null;
  return `/${match[1]}`;
}

/**
 * Resolve `target` to a real, comparable path: realpath the deepest
 * existing ancestor and re-attach the not-yet-existing tail (a Write
 * creating a new file must still be judgeable). A symlink anywhere on
 * the way is resolved by that realpath, which is what makes a link
 * pointing outside the scope deny — including a dangling one: a link
 * whose target does not exist makes realpathSync throw even though the
 * link itself does, and lstat distinguishes that from an ordinary
 * missing name. A link whose destination cannot be resolved is
 * unjudgeable (a Write through it would follow the link and create the
 * target wherever it points), so it denies rather than gluing the
 * link's name back onto the resolved parent. The re-attached tail is
 * normalized with `resolve` before it is returned: `..` segments that
 * survive only because the directories around them do not exist must
 * not slip past the caller's prefix comparison (`/repo/gone/../../etc`
 * is `/etc`). Returns null when nothing along the path can be resolved
 * — unresolvable is unjudgeable is deny.
 */
/** The two forms one resolution yields: the raw bytes the kernel
 * resolved, and their NFC composition. */
interface ResolvedForms {
  raw: string;
  nfc: string;
}

function resolveRealPath(target: string): ResolvedForms | null {
  let probe = target;
  for (;;) {
    try {
      const real = realpathSync(probe);
      const tail = probe === target ? "" : target.slice(probe.length);
      const resolved = resolve(real + tail);
      // NFC on the composed form: the scope is NFC (grantRule normalizes
      // it) and Claude normalizes candidate paths to NFC. The raw form
      // keeps the disk bytes for the raw containment comparison below
      // (review live11).
      return { raw: resolved, nfc: resolved.normalize("NFC") };
    } catch {
      try {
        if (lstatSync(probe).isSymbolicLink()) return null;
      } catch {
        // The component vanished between the two syscalls; the walk up
        // re-tries the parent either way.
      }
      const parent = dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}

/** Bound on symlink expansion (ELOOP's limit): a longer chain is
 * unresolvable is deny. */
const SYMLINK_EXPANSION_BOUND = 40;

/** Expand every existing symlink component of an absolute path, left to
 * right, the order the kernel's namei meets them. libc `realpath` (and
 * Node's `resolve`) both collapse a `link/..` pair lexically — the `..`
 * lands on the link's NAME — while the kernel applies it to the link's
 * RESOLVED TARGET; that disagreement is exactly where a write can hide
 * (review live5). The first existing symlink component is substituted
 * with its read target — a relative target joined onto the link's
 * directory literally, dots intact, so this walk expands any symlink
 * INSIDE the target before a `..` in it can apply (the kernel applies
 * that `..` to the target's resolution, not to the link's directory;
 * `resolve` would collapse it early — review live10) — and the walk
 * restarts, until no component is a symlink. Components past a missing
 * name are left alone (the kernel cannot reach them either; the lexical
 * spelling judges that shape). Returns null when a link's target cannot
 * be resolved where it stands (a dangling link is unjudgeable) or the
 * chain overruns the bound. */
function expandSymlinkComponents(target: string): string | null {
  let current = target;
  for (let hops = 0; hops < SYMLINK_EXPANSION_BOUND; hops += 1) {
    const components = current.split("/");
    let prefix = "";
    let substituted: string | null = null;
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index];
      if (component === "") continue;
      prefix = prefix === "" ? `/${component}` : `${prefix}/${component}`;
      let stats: Stats;
      try {
        stats = lstatSync(prefix);
      } catch {
        // A name that does not exist ends the reachable walk; the rest
        // of the path stays as written.
        break;
      }
      if (!stats.isSymbolicLink()) continue;
      let linkTarget: string;
      try {
        linkTarget = readlinkSync(prefix);
      } catch {
        return null;
      }
      // The join is literal, dots intact: `resolve` would collapse a
      // `..` in the target onto the link's directory before this walk
      // expands the links inside the target, but the kernel applies that
      // `..` only after following them (review live10).
      const absoluteTarget = isAbsolute(linkTarget)
        ? linkTarget
        : `${dirname(prefix)}/${linkTarget}`;
      // The link must resolve where it stands — a dangling one is
      // unjudgeable, the live3 rule. A dotted relative target whose
      // dotted path itself traverses a nonexistent directory fails here
      // too, which is the kernel's own failure to resolve the link.
      try {
        realpathSync(absoluteTarget);
      } catch {
        return null;
      }
      const rest = components.slice(index + 1).join("/");
      substituted = rest === "" ? absoluteTarget : `${absoluteTarget}/${rest}`;
      break;
    }
    if (substituted === null) return current;
    current = substituted;
  }
  return null;
}

/** Directories whose contents run code without anyone running it on
 * purpose: git hooks and config, the harnesses' project settings (claude
 * `hooks`, codex and gemini config, cursor rules and MCP), editor tasks
 * that run on folder open, and husky's git hooks. A component match
 * anywhere in the path denies at medium. Claude Code's own sensitive-path
 * set (`.git`, `.claude`, `.vscode`, `.idea`) is the floor; the rest are
 * the same class for the other harnesses (review live17). This list only
 * judges requests the harness routes to the caller (review live18): a
 * medium claude-family session carries run's `Edit(//<cwd>/**)` grant, so
 * Claude Code approves edits inside the launch directory itself, except
 * under its own sensitive set, and a sandboxed codex session never asks. For the other names medium is as wide as a medium `run`. */
const MEDIUM_PROTECTED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  ".claude",
  ".codex",
  ".gemini",
  ".cursor",
  ".vscode",
  ".idea",
  ".husky",
]);

/** Files of the same class, matched by base name: shell startup files,
 * direnv's `.envrc` (it runs on `cd`), git's per-repository config
 * carriers, and the MCP server lists harnesses load at start. */
const MEDIUM_PROTECTED_FILES: ReadonlySet<string> = new Set([
  ".envrc",
  ".gitconfig",
  ".gitmodules",
  ".mcp.json",
  ".claude.json",
  ".ripgreprc",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".profile",
]);

/** Fold a path for the protected-name lookup. Upper then lower case maps
 * the non-ASCII letters whose case fold is ASCII onto that ASCII spelling:
 * the long s `ſ` (U+017F) to `s`, the Kelvin sign (U+212A) to `k`, and the
 * `ﬆ`-style ligatures to their letters. A plain `toLowerCase` leaves those
 * unchanged, yet APFS's case-insensitive lookup treats `.vſcode` as
 * `.vscode` (review live22). */
export function foldForProtectedLookup(path: string): string {
  return path.toUpperCase().toLowerCase();
}

/** The first protected name below the launch directory in either form of
 * a resolved path, case-folded (foldForProtectedLookup), or null. Only the part under the
 * scope is judged: a launch directory that itself sits under such a name
 * was chosen by the operator, and its whole tree is the grant. The caller
 * has already established that each form is inside its scope. */
function protectedComponent(
  forms: ResolvedForms,
  scope: string,
  rawScope: string
): string | null {
  const below = (path: string, root: string): string =>
    root === "/" ? path : path.slice(root.length);
  for (const spelling of [below(forms.raw, rawScope), below(forms.nfc, scope)]) {
    const components = foldForProtectedLookup(spelling).split("/").filter((part) => part !== "");
    if (components.length === 0) continue;
    const directory = components
      .slice(0, -1)
      .find((component) => MEDIUM_PROTECTED_DIRECTORIES.has(component));
    if (directory !== undefined) return directory;
    const base = components[components.length - 1] ?? "";
    // A protected directory named as the target itself (a NotebookEdit
    // or Write aimed at `.git`) is the same refusal.
    if (MEDIUM_PROTECTED_DIRECTORIES.has(base) || MEDIUM_PROTECTED_FILES.has(base)) {
      return base;
    }
  }
  return null;
}

/** Judge one absolute path against the launch directory's edit scope.
 * Exported for the codex ceiling: a fileChange approval's paths are the
 * same question a claude Edit permission asks.
 *
 * One request, two spellings, both judged: the kernel spelling (every
 * symlink expanded where it stands, in namei order — a `..` after a
 * link names the target's parent) and the lexical spelling (`resolve`,
 * what a harness that cleans paths before writing would use — `..`
 * collapsed before any link is followed). A symlink named after a `..`
 * over a missing directory, or a `..` named after a symlink, makes the
 * two spellings disagree, and the write would land somewhere codemux
 * cannot pin down; that denies fail-closed instead of codemux guessing
 * which normalization the harness's own path handling matches (review
 * live5). A relative target is joined without collapsing `..` first, so
 * the kernel spelling sees the components where the kernel will apply
 * them (review live7).
 *
 * A spelling whose meaning varies by reader is likewise unjudgeable.
 * Claude Code trims surrounding whitespace and expands a leading `~` or
 * `~/…` to the home directory BEFORE it writes, while the resolve below
 * treats both as ordinary relative names inside the launch directory —
 * the harness would write somewhere this check never looked (review
 * live6). Padded and `~`-relative spellings deny; plain relative and
 * absolute targets are judged as before. Shared with the codex approval
 * ceiling, whose patch paths get the same refusal.
 *
 * Two more medium-only denials (review live11): a target whose raw and
 * composed forms disagree about containment — the NFC fold exists for an
 * NFD-spelled launch directory's own files, not for a decomposed-name
 * sibling on a normalization-preserving filesystem — and a target that is
 * executable configuration below the launch directory: a `.git`
 * component (hooks and config), and since review live17 the harnesses'
 * project settings, editor tasks, husky hooks, `.envrc`, and shell
 * startup files (MEDIUM_PROTECTED_*).
 */
export function pathInsideScope(target: string, launchDir: string): CeilingVerdict {
  const scope = launchScope(launchDir);
  if (scope === null) {
    return {
      allowable: false,
      reason: `cannot build a safe grant for the launch directory ${launchDir}`,
    };
  }
  if (target !== target.trim() || target.startsWith("~")) {
    return {
      allowable: false,
      reason: `cannot judge target path ${JSON.stringify(target)} (whitespace-padded or ~-relative)`,
    };
  }
  let rawScope: string;
  try {
    rawScope = realpathSync(launchDir);
  } catch {
    // The launch validated this directory before the session started; a
    // resolution failure here is drift, and unresolvable is unjudgeable
    // is deny.
    return { allowable: false, reason: `cannot resolve the launch directory ${launchDir}` };
  }
  // Join WITHOUT collapsing `..` first: a relative `..` must survive to
  // the kernel spelling, where it applies to a symlink's resolved target
  // (namei order), not to the link's name. Resolving the join up front
  // hands both spellings the already-collapsed lexical form and lets
  // `<cwd>/bun/../f` read through a symlinked `bun` out of the scope
  // (review live7). The lexical spelling collapses below, as it must.
  const joined = isAbsolute(target) ? target : `${launchDir}/${target}`;
  const expanded = expandSymlinkComponents(joined);
  const kernelSpelling = expanded === null ? null : resolveRealPath(expanded);
  const lexicalSpelling = resolveRealPath(resolve(joined));
  if (kernelSpelling === null || lexicalSpelling === null) {
    return { allowable: false, reason: `cannot resolve target path ${target}` };
  }
  if (spellingsInsideScope(scope, rawScope, kernelSpelling, lexicalSpelling)) {
    // Executable configuration is not editable at medium: whatever lands
    // there runs later, outside this session's sandbox, without anyone
    // running it on purpose (see MEDIUM_PROTECTED_*). Low still leaves
    // the answer to the caller and high never consults this predicate
    // (the bare grant) — this tightens medium only (review live11 for
    // `.git`, live17 for the rest). The comparison folds case: on a
    // case-insensitive filesystem (macOS's default, Windows) a `.GIT`-
    // spelled write opens the real `.git` — verified on this machine,
    // where writing `.GIT/config` lands in `.git/config` — so the
    // component check cannot depend on the case a resolution happens to
    // preserve (`realpath` of an existing mixed-case spelling rewrites
    // to the on-disk case there, but that is its manner, not a rule to
    // lean on; review live13). The fold is deliberately blanket: on a
    // case-sensitive disk it over-denies a name like `.GIT` at medium —
    // a pathological name, cheap to refuse fail-closed. The fold is
    // Unicode's, not ASCII's: `.vſcode` (long s) opens the real `.vscode`
    // on APFS too (review live22, foldForProtectedLookup).
    const protectedName =
      protectedComponent(kernelSpelling, scope, rawScope) ??
      protectedComponent(lexicalSpelling, scope, rawScope);
    if (protectedName !== null) {
      return {
        allowable: false,
        reason: `target ${target} is executable configuration (${protectedName}); not editable at medium`,
      };
    }
    return { allowable: true, reason: `target ${target} is inside the launch directory` };
  }
  return { allowable: false, reason: `target ${target} resolves outside the launch directory` };
}

/** The containment decision over both spellings, each in both forms.
 * The NFC forms must be inside the NFC scope, and the raw forms inside
 * the launch directory's own raw disk spelling: the NFC fold exists so
 * an NFD-spelled launch directory (macOS keeps decomposed bytes on
 * disk) still matches its own files, but on a normalization-preserving
 * filesystem (Linux) a sibling directory whose name is the decomposed
 * spelling of the launch directory's own name composes into the scope
 * string and would ride the NFC comparison to "inside" — the bytes the
 * kernel actually resolved to do not (review live11). Exported for the
 * tests: the collision needs a normalization-preserving filesystem, so
 * it cannot be built on disk on macOS.
 *
 * A root scope ("/") contains every absolute path; the prefix forms
 * would otherwise demand a double leading slash no real path has. */
export function spellingsInsideScope(
  scope: string,
  rawScope: string,
  kernel: ResolvedForms,
  lexical: ResolvedForms
): boolean {
  const prefix = scope === "/" ? "/" : `${scope}/`;
  const inside = (real: string): boolean =>
    real === scope || real.startsWith(prefix);
  const rawPrefix = rawScope === "/" ? "/" : `${rawScope}/`;
  const rawInside = (real: string): boolean =>
    rawScope === "/" || real === rawScope || real.startsWith(rawPrefix);
  return (
    inside(kernel.nfc) &&
    inside(lexical.nfc) &&
    rawInside(kernel.raw) &&
    rawInside(lexical.raw)
  );
}

/** Reject any argument key the tool's known schema does not carry — an
 * `updated_input` (or a request) codemux cannot fully read is one it
 * cannot judge. */
function schemaCheck(spec: EditToolSpec | BashToolSpec, input: Record<string, unknown>): CeilingVerdict | null {
  const unknown = Object.keys(input).find((key) => !spec.inputKeys.includes(key));
  if (unknown !== undefined) {
    return {
      allowable: false,
      reason: `argument "${unknown}" is outside the known schema for this tool`,
    };
  }
  return null;
}

/**
 * Judge one claude-family permission request (`can_use_tool`). `input`
 * is the input the answer acts on — the request's own input, or the
 * caller's `updated_input` when the decision carries one (a substitute,
 * so the ceiling judges exactly what would run). Pure: same arguments,
 * same verdict.
 */
export function claudeCeiling(
  level: AutonomyLevel,
  tool: string,
  input: Record<string, unknown>,
  launchDir: string
): CeilingVerdict {
  if (level === "read-only") return DENY_READ_ONLY;
  const spec = specFor(tool);
  if (spec === null) {
    // Default deny for unknown tools; low is the level whose meaning is
    // "the caller answers", and no schema exists to check against.
    return level === "low"
      ? ALLOW_LOW
      : { allowable: false, reason: `tool ${tool} is not granted at ${level}` };
  }
  if (spec.kind === "other") {
    return level === "low"
      ? ALLOW_LOW
      : { allowable: false, reason: `tool ${tool} is not granted at ${level}` };
  }
  const schemaFailure = schemaCheck(spec, input);
  if (schemaFailure !== null) return schemaFailure;
  if (level === "low") return ALLOW_LOW;
  if (spec.kind === "bash") {
    return level === "high"
      ? { allowable: true, reason: "high grants Bash" }
      : { allowable: false, reason: "medium keeps Bash gated" };
  }
  if (level === "high") {
    // High grants every editing tool (`--allowedTools Edit Write
    // NotebookEdit Bash`), so any path is in scope; the schema check
    // above still applies.
    return { allowable: true, reason: "high grants the editing tools" };
  }
  // medium: the editing tools, scoped to the launch directory.
  const target = input[spec.pathKey];
  if (typeof target !== "string" || target.length === 0) {
    return { allowable: false, reason: `argument "${spec.pathKey}" is missing or not a path` };
  }
  return pathInsideScope(target, launchDir);
}
