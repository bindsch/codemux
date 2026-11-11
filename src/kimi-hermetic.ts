import { chmodSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { runDirectoryPrefix } from "./run-directory-owner.js";
import { writeOwnedSync } from "./fs-durable.js";
import { join, resolve } from "node:path";
import { prepareRunDirParent } from "./hermetic-home.js";
import { hasActiveSignalOwner } from "./process-runner.js";
import { readBoundedKimiFile } from "./kimi-wire-log.js";
import { recordTrustedParent, removeUnderTrustedParentOrThrow, reportingHook } from "./safe-remove.js";

export interface KimiHermeticHome {
  printOnly?: boolean;
  home: string;
  kimiHome: string;
  skillsDir: string;
  agentFile: string;
  finalize: () => void;
}

// Drop extra_skill_dirs, extra_agent_dirs, and merge_all_available_skills: discovery paths.
// Drop builtin_product_skills: retain the harness's own default for bundled skills.
// Drop hooks: lifecycle commands can execute operator code.
// Drop permission, default_permission_mode, and default_plan_mode: operator policy.
// Drop plugins, subagent, and secondary_model: operator agents and extensions.
// Drop identity and every unlisted key: custom prompts and future configuration channels.
export const KIMI_CONFIG_ALLOWLIST = [
  "default_provider", "default_model", "providers", "models", "model_overrides", "thinking",
  "loop_control", "context_token_counting", "token_counting", "background", "services", "mcp",
  "telemetry", "disable_feedback_survey",
] as const;
export const KIMI_HERMETIC_ENV_OMISSIONS = [
  "KIMI_CODE_TRUST_WORKSPACE", "KIMI_CODE_IDENTITY_NAME", "KIMI_CODE_IDENTITY_SLUG",
  "KIMI_CODE_BUILTIN_PRODUCT_SKILLS", "KIMI_MCP_TOOL_TIMEOUT_MS", "KIMI_MCP_STARTUP_TIMEOUT_MS",
] as const;
// Private update state does not stop Kimi from replacing the shared executable.
export const KIMI_HERMETIC_ENV_ASSIGNMENTS = ["KIMI_CODE_NO_AUTO_UPDATE=1", "KIMI_CODE_REPEAT_BREAKER=false"] as const;
const MCP_TIMEOUT_KEYS = ["startup_timeout_ms", "tool_timeout_ms"] as const;
const MAX_CONFIG_BYTES = 1024 * 1024;
/** `region` and `device_id` are short identifiers; 4096 bytes is ample.
 * Shared with the isolation probe (kimi-isolation-probe.ts). */
export const MAX_KIMI_STATE_BYTES = 4096;
const liveHomes = new Set<() => void>();
const signals = [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const;
const handlers = new Map<NodeJS.Signals, () => void>();
// Bun 1.4 returns Temporal values. Their normalized string loses the
// consumer's offset and fractional precision, so retain validated tokens.
const kimiTomlLiterals = new WeakMap<object, string>();
const TOML_TIME = String.raw`\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?`;
const TOML_DATETIME = new RegExp(
  String.raw`(?:\d{4}-\d{2}-\d{2}(?:[Tt ]${TOML_TIME}(?:[Zz]|[+-]\d{2}:\d{2})?)?|${TOML_TIME})(?=$|[\s,#\]}=.])`,
  "y"
);

/** Skip one already-validated TOML string, including multiline quote runs. */
function tomlStringEnd(source: string, start: number): number {
  const quote = source[start]!;
  const multiline = source.startsWith(quote.repeat(3), start);
  let end = start + (multiline ? 3 : 1);
  while (end < source.length) {
    if (quote === '"' && source[end] === "\\") { end += 2; continue; }
    if (source[end] !== quote) { end++; continue; }
    if (!multiline) return end + 1;
    const runStart = end;
    while (source[end] === quote) end++;
    if (end - runStart >= 3) return end;
  }
  return end;
}

/** Validate first, then use a second parse to associate literal spellings
 * with their exact values. Bun still owns tables, dotted keys, and arrays;
 * the scanner labels date/time values while leaving every key untouched.
 */
export function parseKimiConfig(source: string): Record<string, unknown> {
  const parsed = Bun.TOML.parse(source) as Record<string, unknown>;
  const occupied = source + JSON.stringify(parsed);
  let prefix = "__codemux_toml_literal_";
  while (occupied.includes(prefix)) prefix = `__codemux_toml_${crypto.randomUUID()}_`;
  const literals = new Map<string, string>();
  const pieces: string[] = [];
  const contexts: { kind: "root" | "array" | "table"; key: boolean }[] = [{ kind: "root", key: true }];
  for (let at = 0; at < source.length;) {
    const char = source[at];
    const context = contexts.at(-1)!;
    if (char === '"' || char === "'") {
      const end = tomlStringEnd(source, at);
      pieces.push(source.slice(at, end));
      at = end;
    } else if (char === "#" || (char === "[" && context.kind === "root" && context.key)) {
      // Validated table headers contain keys only and end on this line.
      const newline = source.indexOf("\n", at);
      const end = newline < 0 ? source.length : newline;
      pieces.push(source.slice(at, end));
      at = end;
    } else {
      TOML_DATETIME.lastIndex = at;
      const match = !context.key && (at === 0 || /[\s=,\[.{]/.test(source[at - 1]!))
        ? TOML_DATETIME.exec(source) : null;
      if (match === null) {
        if (char === "=") context.key = false;
        else if (char === "[") contexts.push({ kind: "array", key: false });
        else if (char === "{") contexts.push({ kind: "table", key: true });
        else if (char === "]" || char === "}") contexts.pop();
        else if (char === "," && context.kind === "table") context.key = true;
        else if (char === "\n" && context.kind === "root") context.key = true;
        pieces.push(char!);
        at++;
        continue;
      }
      const marker = `${prefix}${literals.size}`;
      literals.set(marker, match[0]);
      pieces.push(JSON.stringify(marker));
      at += match[0].length;
    }
  }
  if (literals.size === 0) return parsed;
  const labeled = Bun.TOML.parse(pieces.join(""));
  const retain = (value: unknown, label: unknown): void => {
    if (typeof label === "string" && literals.has(label)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("kimi hermetic config cannot preserve a TOML datetime");
      }
      kimiTomlLiterals.set(value, literals.get(label)!);
    } else if (value !== null && typeof value === "object" && label !== null && typeof label === "object") {
      for (const [key, entry] of Object.entries(label)) {
        retain((value as Record<string, unknown>)[key], entry);
      }
    }
  };
  retain(parsed, labeled);
  return parsed;
}

function track(finalize: () => void): void {
  liveHomes.add(finalize);
  process.once("exit", finalize);
  if (handlers.size) return;
  for (const [signal, code] of signals) {
    const handler = () => {
      if (hasActiveSignalOwner()) return;
      for (const dispose of [...liveHomes]) dispose();
      process.exit(code);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function untrack(finalize: () => void): void {
  liveHomes.delete(finalize);
  process.off("exit", finalize);
  if (liveHomes.size) return;
  for (const [signal, handler] of handlers) process.off(signal, handler);
  handlers.clear();
}

function isKimiTomlTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function kimiTomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return String(value);
  if (Array.isArray(value)) return `[${value.map(kimiTomlValue).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const literal = kimiTomlLiterals.get(value);
    if (literal !== undefined) return literal;
    if (isKimiTomlTable(value)) {
      return `{ ${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)} = ${kimiTomlValue(entry)}`).join(", ")} }`;
    }
  }
  throw new Error("kimi hermetic config contains an unsupported TOML value");
}

/** Retain model/login settings and MCP timeouts; never copy discovery or hooks. */
export function kimiHermeticConfig(sourceBrandHome: string): string {
  return serializeKimiConfig({ ...filteredKimiHermeticConfig(sourceBrandHome), auto_session_title: false });
}

export function serializeKimiConfig(config: Record<string, unknown>): string {
  return Object.entries(config).map(([key, value]) => `${JSON.stringify(key)} = ${kimiTomlValue(value)}\n`).join("");
}

/** The allowlist filter over one parsed config: the run path's rule,
 * extracted so the session's merge reuses it unchanged. */
function filterKimiConfigKeys(parsed: Record<string, unknown>, path: string): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const key of KIMI_CONFIG_ALLOWLIST) {
    if (!Object.hasOwn(parsed, key)) continue;
    if (key === "mcp") {
      const mcp = parsed.mcp;
      if (mcp === null || typeof mcp !== "object" || Array.isArray(mcp)) {
        throw new Error(`kimi hermetic config needs an MCP timeout table: ${path}`);
      }
      filtered.mcp = Object.fromEntries(MCP_TIMEOUT_KEYS
        .filter((name) => Object.hasOwn(mcp, name))
        .map((name) => [name, (mcp as Record<string, unknown>)[name]]));
    } else filtered[key] = parsed[key];
  }
  return filtered;
}

function readBrandConfig(sourceBrandHome: string | null): { parsed: Record<string, unknown>; path: string } {
  const path = join(sourceBrandHome ?? ".", "config.toml");
  if (sourceBrandHome === null) return { parsed: {}, path };
  let source = "";
  try {
    // The file descriptor reader also rejects files that grow past the bound.
    source = readBoundedKimiFile(path, MAX_CONFIG_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { parsed: parseKimiConfig(source), path };
}

function filteredKimiHermeticConfig(sourceBrandHome: string | null): Record<string, unknown> {
  const { parsed, path } = readBrandConfig(sourceBrandHome);
  return filterKimiConfigKeys(parsed, path);
}

/** The brand home a hermetic session's private home carries kimi's state
 * in (the store lives at `<dir>/.kimi-code/sessions`, so the session's
 * lifetime IS the private home's lifetime). Shared by the driver's
 * record (the registry's `harness_home` names it) and the per-turn
 * command (KIMI_CODE_HOME points at it). */
export function kimiPrivateBrandHome(privateHomeDir: string): string {
  return join(privateHomeDir, ".kimi-code");
}

/** The empty skills directory the per-turn `--skills-dir` names: private,
 * so no operator skill loads, and the only skills a session sees are the
 * harness's own bundled defaults. */
export function kimiPrivateSkillsDir(privateHomeDir: string): string {
  return join(privateHomeDir, "skills-dir");
}

/**
 * The config a hermetic SESSION's private brand home runs on. Like the
 * run path, the operator's config is filtered by the allowlist at
 * generation time; unlike the run path, the generation runs at the FIRST
 * TURN — after the consumer's pre-write window — so a config.toml the
 * consumer already placed in `destBrandHome` joins the merge: its
 * allowlisted keys win over the operator's (the consumer chose them for
 * this session), and its `permission` table is kept whole. `permission`
 * is the one key the allowlist drops by design (operator policy); a
 * consumer-added `[[permission.rules]]` is the caller's own policy
 * channel, so the generation preserves it instead of filtering it. The
 * file is written once, on the first turn of a FRESH home; later turns
 * and resumes never rewrite it, so the consumer's edits stand.
 */
export function kimiSessionHermeticConfig(sourceBrandHome: string | null, destBrandHome: string): string {
  const config = filteredKimiHermeticConfig(sourceBrandHome);
  const destPath = join(destBrandHome, "config.toml");
  let existing = "";
  try {
    existing = readBoundedKimiFile(destPath, MAX_CONFIG_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing !== "") {
    const parsed = parseKimiConfig(existing);
    Object.assign(config, filterKimiConfigKeys(parsed, destPath));
    if (Object.hasOwn(parsed, "permission")) config.permission = parsed.permission;
  }
  config.auto_session_title = false;
  return serializeKimiConfig(config);
}

/** Writes the session config into the private brand home (once, from the
 * driver's first-turn spawn; the caller owns the once). */
export function writeKimiSessionHermeticConfig(destBrandHome: string, sourceBrandHome: string | null): void {
  writeOwnedSync(join(destBrandHome, "config.toml"), kimiSessionHermeticConfig(sourceBrandHome, destBrandHome), 0o600);
}

/** Kimi 2.5.2's bundled agent-core-v2/src/agent/permissionRules/matchesRule.ts:
 * `if (openIdx === -1) return { toolName: trimmed };`
 * `if (parsed.toolName !== "*" && !import_picomatch.default.isMatch(toolName, parsed.toolName)) return;`
 * `if (parsed.argPattern === void 0) return {` then `strategy: "tool_name_only"`.
 * Thus `pattern: "*"` covers every tool and every argument, including Bash,
 * Write, Edit, reads, and extension tools. configSection.ts accepts `decision`,
 * `scope` (default "user"), `pattern`, and `reason`; permissionPolicyService.ts
 * places UserConfiguredDenyPermissionPolicyService before AutoModeApprovePermissionPolicyService.
 * Build evidence: `version: optionalBuildString("2.5.2")` in the installed bundle.
 */
export const KIMI_SESSION_DENY_RULE = {
  decision: "deny", scope: "user", pattern: "*", reason: "codemux --permission-policy deny",
} as const;

/** Enforce the native deny before each turn, including resumes. Consumer
 * rules and every other config key survive. Existing native catch-all denies
 * avoid rewriting the file. Generated denies persist until the consumer removes
 * them; a default-policy session never removes or weakens private policy.
 */
export function enforceKimiSessionDenyPolicy(destBrandHome: string): void {
  const { parsed: config, path } = readBrandConfig(destBrandHome);
  const permission = config.permission === undefined ? {} : config.permission;
  if (!isKimiTomlTable(permission)) {
    throw new Error("kimi deny policy requires a permission table in config.toml");
  }
  const table = permission;
  // configSection.ts: `const entries = Array.isArray(value) ? value : [value]`.
  // A single inline rule is valid native syntax; preserve it when appending.
  const rules = table.rules === undefined ? [] : Array.isArray(table.rules) ? table.rules : [table.rules];
  if (rules.some((rule) => !isKimiTomlTable(rule))) {
    throw new Error("kimi deny policy requires permission.rules to contain rule tables");
  }
  if (rules.some((rule: Record<string, unknown>) =>
    rule.decision === "deny" && rule.pattern === "*" && rule.tool === undefined &&
    (rule.scope === undefined || rule.scope === "user" || rule.scope === "project" || rule.scope === "turn-override")
  )) return;
  config.permission = { ...table, rules: [...rules, KIMI_SESSION_DENY_RULE] };
  writeOwnedSync(path, serializeKimiConfig(config), 0o600);
}

/**
 * Populates the launcher's per-session private home for a hermetic kimi
 * session (the SessionPrivateHome the driver consumes,
 * src/session/private-home-types.ts): the `.kimi-code` brand home (the
 * session store lives in it, so the session's turns and resumes share
 * the home's lifetime), the credential symlink, the copied short state
 * files, and the empty skills directory the per-turn `--skills-dir`
 * names. config.toml is deliberately NOT written here — the first turn
 * generates it, after the consumer's pre-write window
 * (`kimiSessionHermeticConfig`). The default profile needs no agent file.
 * Tools-none profiles are supplied only on creation; native resume
 * restores their bound tool allowlist without --agent-file.
 */
export function populateKimiHermeticSessionHome(
  dir: string,
  sourceBrandHome: string | null,
  printOnly = false
): { brandHome: string; skillsDir: string } {
  const brandHome = kimiPrivateBrandHome(dir);
  const skillsDir = join(dir, "skills-dir");
  mkdirSync(brandHome, { mode: 0o700 });
  chmodSync(brandHome, 0o700);
  mkdirSync(skillsDir, { mode: 0o700 });
  chmodSync(skillsDir, 0o700);
  if (!printOnly && sourceBrandHome !== null) {
    symlinkSync(resolve(sourceBrandHome, "credentials"), join(brandHome, "credentials"), "dir");
    for (const name of ["region", "device_id"]) {
      const source = join(sourceBrandHome, name);
      try {
        writeOwnedSync(join(brandHome, name), readBoundedKimiFile(source, MAX_KIMI_STATE_BYTES), 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return { brandHome, skillsDir };
}

/** Each private brand home shares the credential directory, including atomic token renames. */
export function createKimiHermeticHome(sourceBrandHome: string, toolsNone = false, printOnly = false): KimiHermeticHome {
  if (printOnly) {
    const home = join(sourceBrandHome, ".codemux-hermetic", "preview");
    return { home, kimiHome: join(home, ".kimi-code"), skillsDir: join(home, "skills-dir"),
      agentFile: join(home, "agent.md"), printOnly: true, finalize: () => {} };
  }
  const config = kimiHermeticConfig(sourceBrandHome);
  const parent = prepareRunDirParent(sourceBrandHome, ".codemux-hermetic");
  // Recorded for the finalizer's revalidation (src/safe-remove.ts).
  const parentRecord = recordTrustedParent(parent);
  const home = mkdtempSync(join(parent, runDirectoryPrefix()));
  // mkdtemp's and mkdir's modes are masked by the umask; each is stated
  // right after creation, whatever the umask (review round 401, item 1).
  chmodSync(home, 0o700);
  const kimiHome = join(home, ".kimi-code");
  const skillsDir = join(home, "skills-dir");
  const agentFile = join(home, "agent.md");
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    // Thrown when refused or failed, so cleanupHome reports the kept home;
    // it stays retryable, and the tracked hook retries and reports
    // (review round 97).
    removeUnderTrustedParentOrThrow(home, parentRecord, `the private kimi home ${home}`);
    finalized = true;
    untrack(hook);
  };
  const hook = reportingHook(finalize);
  track(hook);
  try {
    mkdirSync(kimiHome, { mode: 0o700 });
    chmodSync(kimiHome, 0o700);
    mkdirSync(skillsDir, { mode: 0o700 });
    chmodSync(skillsDir, 0o700);
    writeOwnedSync(join(kimiHome, "config.toml"), config, 0o600);
    symlinkSync(resolve(sourceBrandHome, "credentials"), join(kimiHome, "credentials"), "dir");
    // `region` and `device_id` sit in the brand home a previous kimi child
    // could write, so they are read through the bounded no-follow reader:
    // a symlink or a FIFO swapped in for either is refused (the launch
    // fails and the private home is removed) instead of followed or
    // blocked on, and the bytes are copied only after every file passed
    // (review round 100). An absent file is skipped as before.
    const stateFiles = ["region", "device_id"].map((name) => {
      const source = join(sourceBrandHome, name);
      try { return { name, bytes: readBoundedKimiFile(source, MAX_KIMI_STATE_BYTES) }; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    });
    for (const file of stateFiles) {
      if (file) writeOwnedSync(join(kimiHome, file.name), file.bytes, 0o600);
    }
    // Modes stated on the descriptor, whatever the umask (round 401, item 1).
    writeOwnedSync(agentFile, ["---", "name: codemux-hermetic",
      "description: Private profile with the default prompt.",
      ...(toolsNone ? ["tools: []"] : []), "---", "", "${base_prompt}", ""].join("\n"), 0o600);
    return { home, kimiHome, skillsDir, agentFile, finalize };
  } catch (error) { finalize(); throw error; }
}

