// Resume guard bundle: resume probes and lookups, hold state, and the
// entry judgment that decides whether a record may be resumed.
// src/session/registry.ts owns the module surface.
import type { AutonomyLevel } from "../../types.js";
import { currentProcessIdentity, processIdentityAlive, resolveRegistryPath } from "../registry-io.js";
import { readRegistry, AUTONOMY_REACH_BY_AGENT, STRICT_AUTONOMY_REACH, TRUST_RANK, type RegistryFile, type SandboxTrust, type SessionRecord } from "./format.js";
import { updateRegistry } from "./mutations.js";

/** What a resume attempt is running as, for the guard bundle. */
export interface ResumeProbe {
  agent: string;
  harnessHome: string;
  callerOwnedHome?: boolean;
  /** The resume's validated (canonical) working directory: it must be
   * the recorded one — a resumed transcript gets no other tree. */
  cwd: string;
  /** The resume's `--pass-env` names and Playwright flag: neither may
   * add what creation lacked (review live16). */
  passEnv: readonly string[];
  playwrightMcp: boolean;
  autonomy: AutonomyLevel;
  sandboxed: boolean;
  sandboxTrust: SandboxTrust;
  sandboxStrict?: boolean;
  /** The flags the resuming command actually runs with — a resume may
   * not clear one the entry was created under. */
  sandboxNoNet: boolean;
  sandboxScrubEnv: boolean;
  /** The resume's `--sandbox-block` paths, canonicalized like the
   * record's (canonicalSandboxBlockPaths): every recorded path must be
   * present — a resume may add a block, never drop one. */
  sandboxBlock: readonly string[];
  /** The provider identity the resume runs under (review D3, security):
   * the override's base URL, or null for the operator's own login. Must
   * equal the recorded identity — the harness state directory does not
   * move with the endpoint, so this is the only guard that stops a
   * transcript replaying on another provider. */
  providerBaseUrl: string | null;
  hermetic: boolean;
  /** Whether the resuming command runs the project-settings isolation
   * (`--hermetic --experiment-project-settings`); must equal the
   * recorded mode — see SessionRecord.project_settings. */
  projectSettings: boolean;
}

export type ResumeLookup =
  | { outcome: "ok"; entry: SessionRecord }
  | { outcome: "not_found" }
  | { outcome: "refused"; reason: string }
  | { outcome: "untrusted"; reason: string }
  /** The claim could not reach the registry (a busy lock, an I/O error):
   * nothing was judged, so this is no refusal, and a retry may pass
   * (review live22). */
  | { outcome: "unavailable"; reason: string };

function stripTrailingSlash(dir: string): string {
  if (dir.length > 1 && dir.endsWith("/")) return dir.slice(0, -1);
  return dir;
}

/** Whether the registry (at `path`) sits inside `dir`, both sides
 * resolved like every registry I/O (§4.8): the containment test behind
 * both the start-time writable-set refusal and the resume-time untrusted
 * check — one rule, so the two cannot drift. A root `dir` ("/") contains
 * every absolute path; the prefix form below would otherwise demand the
 * double leading slash no real path has, letting a `--cwd /` session
 * bypass both guards (review live7). */
export function registryInside(path: string, dir: string): boolean {
  const scope = stripTrailingSlash(resolveRegistryPath(dir));
  const resolved = resolveRegistryPath(path);
  const prefix = scope === "/" ? "/" : `${scope}/`;
  return resolved === scope || resolved.startsWith(prefix);
}

/** What the registry says about a session id right now: `held` (an open
 * record whose owner identity is alive), `free` (a readable registry
 * holds no live record for the id — no record, an ended one, or a dead
 * owner), or `unknown` (the registry could not be read: a busy lock, an
 * I/O error, an untrusted or corrupt file). The file-sweepers'
 * liveness skip — a session another codemux process is running must
 * never be aged out of on-disk state however old its files look (aider
 * only ever appends to `history.md`, so a long-lived session's
 * directory mtime can sit at creation time; review D2, security 2).
 * A DELETION acts only on a positive `free`: `unknown` spares the
 * directory, because an unreadable registry turned into a false
 * "not held" deleted a live session's home during a transient read
 * failure (review D5, correctness 1). A missing registry is `free`
 * outright — no file means no session can be held. */
export type SessionHold = "held" | "free" | "unknown";

export function sessionHoldState(path: string, id: string): SessionHold {
  const read = readRegistry(path);
  if (
    read.outcome === "unavailable" ||
    read.outcome === "untrusted" ||
    read.outcome === "corrupt"
  ) {
    return "unknown";
  }
  if (read.outcome === "missing") return "free";
  const entry = read.file.sessions.find((session) => session.id === id);
  if (entry === undefined) return "free";
  return entry.ended === null && processIdentityAlive(entry.owner_pid, entry.owner_start)
    ? "held"
    : "free";
}

/** The §4.8 resume guard bundle. Every rule is a refusal (the registry
 * bounds, it never widens): the entry exists (exit 66 at the CLI),
 * `agent` matches (the cross-agent replay guard, checked by agent so it
 * holds even on the shared claude/zai home), `harness_home` matches (no
 * account hop), the provider identity matches — the override base URL,
 * or operator login when none; a transcript recorded on one endpoint
 * never replays on another (review D3) — containment does not drop
 * (`sandboxed`, never at a
 * higher trust than creation, never clearing the recorded
 * `--sandbox-no-net`/`--sandbox-scrub-env` flags, and never dropping a
 * recorded `--sandbox-block` path), `cwd` matches, no
 * `--pass-env` name and no Playwright MCP is added (review live16), the
 * resuming `--auto` does not exceed the recorded autonomy ranked by
 * reach, `hermetic` and project-settings mode match, the owner
 * is not live (exit 78 `session_busy`), and the registry itself does
 * not sit inside the resumed entry's own `cwd` or `harness_home` — the
 * file the child could have altered is untrusted. This read takes no
 * lock: it only exits early, and `claimForResume` repeats the judgment
 * under the lock before anything spawns. */
export function lookupForResume(
  path: string,
  id: string,
  probe: ResumeProbe
): ResumeLookup {
  const read = readRegistry(path);
  if (read.outcome === "missing") return { outcome: "not_found" };
  if (read.outcome === "untrusted") return { outcome: "untrusted", reason: read.reason };
  if (read.outcome === "unavailable") return { outcome: "unavailable", reason: read.reason };
  if (read.outcome === "corrupt") {
    return { outcome: "untrusted", reason: `fail-closed on a corrupt registry: ${read.reason}` };
  }
  return judgeResumeEntry(path, read.file, id, probe);
}

/** The resume guard bundle and the ownership claim in one locked
 * update (review live19). `lookupForResume` reads without the lock, so
 * two resumes of one id could both pass it; on the claude family the
 * record was claimed only at the init frame, after the caller's first
 * input had already reached the harness, so the loser's harness acted
 * on that input before it was refused. The claim runs before the spawn:
 * it re-judges the entry under the writer lock and stamps this process
 * as the live owner, so a concurrent resume is refused `session_busy`
 * before it spawns anything. The driver's later `recordSessionStart`
 * finds its own pid and updates in place. The CLI hands the claim to the
 * driver (`adoptResumeClaim`), whose every end path stamps `ended`, and
 * releases it itself when the spawn throws (review live20). */
export function claimForResume(path: string, id: string, probe: ResumeProbe): ResumeLookup {
  let verdict: ResumeLookup | null = null;
  const identity = currentProcessIdentity();
  const outcome = updateRegistry(
    path,
    (file) => {
      verdict = judgeResumeEntry(path, file, id, probe);
      if (verdict.outcome !== "ok") return verdict.outcome;
      const entry = verdict.entry;
      entry.owner_pid = identity.pid;
      entry.owner_start = identity.start;
      entry.ended = null;
      entry.last_activity = new Date().toISOString();
      return null;
    },
    "fail"
  );
  const judged = verdict as ResumeLookup | null;
  if (judged !== null && (judged.outcome !== "ok" || outcome.ok)) return judged;
  if (!outcome.ok && (outcome.kind === "busy" || outcome.kind === "unavailable")) {
    return { outcome: "unavailable", reason: outcome.error };
  }
  return {
    outcome: "untrusted",
    reason: outcome.ok ? "the resume claim was not judged" : outcome.error,
  };
}

/** The provider identity as a refusal names it: the override's
 * endpoint, or the operator's own login (review D3). */
function providerSurface(baseUrl: string | null): string {
  return baseUrl === null ? "the operator's own login" : `the provider override at ${baseUrl}`;
}

function judgeResumeEntry(
  path: string,
  file: RegistryFile,
  id: string,
  probe: ResumeProbe
): ResumeLookup {
  const entry = file.sessions.find((candidate) => candidate.id === id);
  if (entry === undefined) return { outcome: "not_found" };
  // A final record is unresumable forever, whatever else matches: the
  // session's private configuration directory was removed at its end
  // (transcript and credentials with it), so a resume would open a
  // fresh, transcript-less directory (review round 10, edges 4). Checked
  // before every other rule because it dominates them all.
  if (entry.final) {
    return {
      outcome: "refused",
      reason: `session ${id} ran with --final; its private configuration was removed at end and it cannot be resumed`,
    };
  }
  if (entry.agent !== probe.agent) {
    return {
      outcome: "refused",
      reason: `session ${id} belongs to agent ${entry.agent}, not ${probe.agent}`,
    };
  }
  if (entry.harness_home !== probe.harnessHome) {
    return {
      outcome: "refused",
      reason: `session ${id} was created against harness home ${entry.harness_home}, not ${probe.harnessHome}`,
    };
  }
  if ((entry.caller_owned_home === true) !== (probe.callerOwnedHome === true)) {
    return { outcome: "refused", reason: `session ${id} cannot gain or lose --harness-home on resume` };
  }
  // The provider identity (review D3, security): the harness state
  // directory does not move with the endpoint for claude, opencode, or
  // aider, so the home guard above cannot carry this rule. A transcript
  // recorded on one endpoint never replays on another, and an
  // operator-login transcript never runs under an override — either
  // direction hands the conversation to a provider the caller never
  // chose at creation.
  if (entry.provider_base_url !== probe.providerBaseUrl) {
    return {
      outcome: "refused",
      reason: `session ${id} was created against ${providerSurface(entry.provider_base_url)} and cannot resume against ${providerSurface(probe.providerBaseUrl)}`,
    };
  }
  if (entry.sandboxed && !probe.sandboxed) {
    return {
      outcome: "refused",
      reason: `session ${id} was created under scode and cannot resume unsandboxed`,
    };
  }
  if ((entry.sandbox_strict === true) !== (probe.sandboxStrict === true)) {
    return { outcome: "refused", reason: `session ${id} cannot gain or lose --sandbox-strict on resume` };
  }
  if (entry.sandboxed && TRUST_RANK[probe.sandboxTrust] > TRUST_RANK[entry.sandbox_trust]) {
    return {
      outcome: "refused",
      reason: `session ${id} was created at sandbox trust ${entry.sandbox_trust} and cannot resume at ${probe.sandboxTrust}`,
    };
  }
  // One-directional containment flags (§4.8): clearing a flag grants reach
  // creation never allowed — the resumed transcript may carry injected
  // content — while adding one only tightens.
  if (entry.sandbox_no_net && !probe.sandboxNoNet) {
    return {
      outcome: "refused",
      reason: `session ${id} was created with --sandbox-no-net and cannot resume without it`,
    };
  }
  if (entry.sandbox_scrub_env && !probe.sandboxScrubEnv) {
    return {
      outcome: "refused",
      reason: `session ${id} was created with --sandbox-scrub-env and cannot resume without it`,
    };
  }
  // The same rule, path by path: every recorded block must be present in
  // the resume's set (both sides canonical, so a symlinked spelling
  // cannot hide a dropped block or invent one), while adding a block
  // only tightens. The first missing path names the refusal.
  const droppedBlock = entry.sandbox_block.find(
    (blocked) => !probe.sandboxBlock.includes(blocked)
  );
  if (droppedBlock !== undefined) {
    return {
      outcome: "refused",
      reason: `session ${id} was created with --sandbox-block ${droppedBlock} and cannot resume without it`,
    };
  }
  // The same rule for the remaining reach a resume could add (review
  // live16): another tree, a secret, or a browser handed to a transcript
  // that may already carry injected content. Both cwds are canonical
  // (validateWorkingDirectory realpaths them), so equality is exact.
  if (entry.cwd !== probe.cwd) {
    return {
      outcome: "refused",
      reason: `session ${id} was created in ${entry.cwd} and cannot resume in ${probe.cwd}`,
    };
  }
  const added = probe.passEnv.filter((name) => !entry.pass_env.includes(name));
  if (added.length > 0) {
    return {
      outcome: "refused",
      reason: `session ${id} was created without --pass-env ${[...added].sort().join(",")} and cannot resume with it`,
    };
  }
  if (probe.playwrightMcp && !entry.playwright_mcp) {
    return {
      outcome: "refused",
      reason: `session ${id} was created without --enable-playwright-mcp and cannot resume with it`,
    };
  }
  // Ranked per agent (review live9): agy's ranking is strict, and an
  // agent without a mapping is ranked strict too — the conservative
  // reading for a name a future release may add.
  const reach = AUTONOMY_REACH_BY_AGENT[probe.agent] ?? STRICT_AUTONOMY_REACH;
  if (reach[probe.autonomy] > reach[entry.autonomy]) {
    return {
      outcome: "refused",
      reason: `session ${id} was created at autonomy ${entry.autonomy} and cannot resume above it at ${probe.autonomy}`,
    };
  }
  if (entry.hermetic !== probe.hermetic) {
    return {
      outcome: "refused",
      reason: `session ${id} was created ${entry.hermetic ? "hermetic" : "non-hermetic"} and the resume is ${probe.hermetic ? "hermetic" : "non-hermetic"}`,
    };
  }
  // Project-settings mode is containment provenance (SessionRecord's
  // field doc): it decides where the transcript lives (the private config
  // directory the record's harness_home names) and what the harness
  // loads, so neither adding it to nor removing it from a session on
  // resume is the same session.
  if (entry.project_settings !== probe.projectSettings) {
    return {
      outcome: "refused",
      reason: `session ${id} was created ${entry.project_settings ? "with" : "without"} --experiment-project-settings and cannot resume ${probe.projectSettings ? "with" : "without"} it`,
    };
  }
  // This process's own pid is never a rival owner, the same exemption
  // recordSessionStart makes: an unended record a dead process left under
  // a pid since reused by this one (start token null, so liveness is the
  // bare pid) refused every resume from it as busy (review live25).
  if (
    entry.ended === null &&
    entry.owner_pid !== process.pid &&
    processIdentityAlive(entry.owner_pid, entry.owner_start)
  ) {
    return {
      outcome: "refused",
      reason: `session ${id} is still owned by live process ${entry.owner_pid} (session_busy)`,
    };
  }
  // Containment is judged with both sides resolved: the registry path is
  // resolved like every other registry I/O, and the recorded cwd/home are
  // resolved to match, so a symlinked ancestor on either spelling cannot
  // hide a real containment.
  const insideCwd = registryInside(path, entry.cwd);
  const insideHome = registryInside(path, entry.harness_home);
  if (insideCwd || insideHome) {
    return {
      outcome: "untrusted",
      reason: `the registry sits inside the session's own ${insideCwd ? "cwd" : "harness home"} — the child could have altered it`,
    };
  }
  return { outcome: "ok", entry };
}
