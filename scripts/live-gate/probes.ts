import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId } from "../../src/types.js";
import { RESULT_ANSWER_FIELD } from "../../src/result-envelope/index.js";
import type { StdinScript } from "./runner.js";
import { EXPERIMENT_HARNESSES, type HarnessFacts } from "./facts.js";
import { PARITY } from "../../src/parity/index.js";
import { PROBE_FEATURE } from "../../src/parity/probe-features.js";
import { EXPERIMENT_MCP_HARNESS_SCHEMAS } from "../../src/experiment-mcp.js";

// The probe set the audit's release checklist names (scratch/audit/release.md
// gap 3). Letters match docs/RELEASE-GATE.md's probe table. Probe 0 (the
// version-contract column) is separate: it costs no quota and always runs.
export const PROBE_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "H2", "I", "I2", "J", "K", "P"] as const;
export type ProbeLetter = (typeof PROBE_LETTERS)[number];
// Every probe but H runs by default: H forwards real provider credentials
// into the sandbox (opt-in), while H2 — its loopback twin — synthesizes its
// own and spends no provider quota (audit D9).
export const DEFAULT_PROBES: readonly ProbeLetter[] = ["A", "B", "C", "D", "E", "F", "G", "H2", "I", "I2", "J", "K", "P"];

// Probe H forwards provider credentials into the sandbox; it runs only when
// the operator exports this variable set to exactly "1".
export const PROVIDER_OVERRIDE_OPT_IN = "LIVE_GATE_PROVIDER_OVERRIDE";

export const PROBE_LABELS: Record<ProbeLetter, string> = {
  A: "read-only reply",
  B: "medium shell",
  C: "result JSON",
  D: "hermetic check",
  E: "tools none",
  F: "session turn",
  G: "experiment MCP",
  H: "provider override",
  H2: "loopback override",
  I: "model alias",
  I2: "effort low",
  J: "sandbox policy",
  K: "hermetic session",
  P: "print-sandbox",
};

const PROBE_NAMES: Readonly<Record<string, ProbeLetter>> = {
  a: "A", "read-only": "A",
  b: "B", medium: "B", shell: "B",
  c: "C", "result-json": "C",
  d: "D", hermetic: "D", check: "D",
  e: "E", "tools-none": "E",
  f: "F", session: "F",
  g: "G", "experiment-mcp": "G",
  h: "H", "provider-override": "H",
  h2: "H2", loopback: "H2", "loopback-override": "H2",
  i: "I", alias: "I", "model-alias": "I", "alias-effort": "I",
  i2: "I2", effort: "I2", "effort-low": "I2",
  j: "J", sandbox: "J", "no-net": "J",
  k: "K", "hermetic-session": "K",
  p: "P", "print-sandbox": "P",
};

export function parseProbeList(values: (string | undefined)[], label: string): ProbeLetter[] {
  const letters: ProbeLetter[] = [];
  for (const name of values.flatMap((value) => value?.split(",") ?? [])) {
    const letter = PROBE_NAMES[name.trim().toLowerCase()];
    if (name.trim() === "") continue;
    if (!letter) throw new Error(`${label} list contains an unknown probe name.`);
    if (!letters.includes(letter)) letters.push(letter);
  }
  return letters;
}

// The harness facts (HarnessFacts, harnessFacts, the experiment and
// served-model tables) live in facts.ts now; re-exported here so every
// importer of the probe set keeps one path. EXPERIMENT_HARNESSES is also
// imported above: prepareExperimentProbe reads it as a default.
export {
  EXPERIMENT_HARNESSES,
  SERVED_MODEL_EVIDENCE,
  harnessFacts,
  type HarnessFacts,
  type CandidateExperimentFacts,
} from "./facts.js";

/** A probe runs on a harness only when a verified mechanism exists; every
 * other cell prints UNSUPPORTED with the capability that is absent. */
export function probeApplies(letter: ProbeLetter, facts: HarnessFacts): boolean {
  switch (letter) {
    case "A":
    case "B":
    // P prints the sandbox argv and exits: every harness, no quota, no
    // credential (2026-11-03: a print-only agy path reached the Keychain).
    case "P":
      return true;
    case "C":
      return facts.resultJson;
    case "D":
      if (facts.checkHermetic === undefined) {
        throw new Error("probe D requires the candidate's checkHermetic declaration; older listings cannot establish the control channel");
      }
      return facts.checkHermetic;
    case "E":
      // The plain `--tools none` probe runs wherever the adapter declares
      // the capability; the hermetic form (toolsNoneRequiresHermetic,
      // opencode) is chosen inside the probe body (run.ts).
      return facts.toolsNone;
    case "F":
      return facts.sessions;
    case "K":
      if (facts.sessionHermetic === undefined) {
        throw new Error("probe K requires the candidate's sessionHermetic declaration; a run capability does not establish session isolation");
      }
      return facts.sessionHermetic;
    case "G":
      return facts.experiment;
    case "H":
      // The override is asserted on the envelope's provider-reported
      // `codemux.served_model`, so a harness without the result-JSON
      // capability — or whose wire exposes no served-model field
      // (opencode, kimi) — has nothing the gate can verify in-band.
      return facts.providerOverride && facts.resultJson && facts.servedModelEvidence;
    case "H2":
      // The loopback twin (audit D9): the proof is the fake provider's
      // request log, not the envelope, so every override-capable harness
      // can run it — opencode and kimi included.
      return facts.providerOverride;
    case "I":
      // The alias probe carries -m alone (audit D7, split in the 2.0.0
      // parity pass): the adapter must declare model selection.
      return facts.model;
    case "I2":
      // The effort twin: --effort low on its own, so the adapter must
      // declare the effort flag.
      return facts.effort;
    case "J":
      // The sandbox policy flags apply to every harness codemux runs.
      return true;
  }
}

export function unsupportedNote(letter: ProbeLetter, facts?: HarnessFacts): string {
  const feature = PROBE_FEATURE[letter];
  if (facts !== undefined && feature !== null) {
    if (facts.declarationSource === "candidate") {
      const limitation = facts.limitations?.[feature];
      if (!limitation?.reason.trim() || !limitation.evidence.trim()) {
        throw new Error(`candidate ${facts.id} must declare the reason and evidence for ${feature}`);
      }
      return limitation.reason;
    }
    const state = PARITY[facts.id][feature];
    return state.state === "harness-limitation" ? state.reason
      : `${facts.id} supports ${feature}; a differing candidate needs its own limitation declaration`;
  }
  const notes: Record<ProbeLetter, string> = {
    A: "adapter supports headless runs",
    B: "adapter supports medium autonomy",
    C: "adapter declares no result-JSON capability (docs/harnesses.md matrix)",
    D: "adapter declares no hermetic capability (docs/harnesses.md matrix)",
    E: "adapter declares no --tools none capability (docs/harnesses.md matrix)",
    F: "no session driver for this harness (src/session/cli-agents.ts SESSION_AGENTS)",
    G: "no verified experiment MCP mechanism (src/experiment-mcp.ts)",
    H: "adapter declares no provider-override, result-JSON, and served-model-evidence triple (docs/harnesses.md matrix, docs/RELEASE-GATE.md row H); the override is asserted on the envelope's provider-reported served_model",
    H2: "adapter declares no provider-override capability (docs/harnesses.md matrix); the loopback probe verifies the override through the request the harness itself sends",
    I: "adapter declares no model selection (docs/harnesses.md matrix); probe I carries -m",
    I2: "adapter declares no effort flag (docs/harnesses.md matrix); probe I2 carries --effort",
    J: "the sandbox policy flags apply to every harness",
    K: "the hermetic session canary needs a session driver and a hermetic capability",
    P: "--print-sandbox applies to every harness",
  };
  return notes[letter];
}

export interface MediumProbe {
  expected: string;
  prompt: string;
}

/** Writes the private nonce and script Probe B's prompt names, and returns
 * the exact stdout the harness must reply with. The expected hash never
 * appears in any file the harness reads. */
export function prepareMediumProbe(directory: string): MediumProbe {
  const nonce = randomBytes(6).toString("hex");
  const expected = createHash("sha256").update(nonce).digest("hex").slice(0, 16);
  writeFileSync(join(directory, "nonce.txt"), nonce, { mode: 0o600 });
  writeFileSync(join(directory, "probe.sh"), [
    "if command -v shasum >/dev/null 2>&1; then",
    '  printf %s "$(cat nonce.txt)" | shasum -a 256 | cut -c1-16',
    "else",
    '  printf %s "$(cat nonce.txt)" | sha256sum | cut -c1-16',
    "fi\n",
  ].join("\n"), { mode: 0o700 });
  return {
    expected,
    prompt: "Run the shell command: sh probe.sh and reply with exactly its output, nothing else.",
  };
}

export interface ExperimentProbeSpec {
  path: string;
  prompt: string;
}

/** Writes the experiment-MCP spec Probe G runs against: the repo's own echo
 * fixture server, which answers every tool call with one fixed marker. The
 * prefixes come from the CALLER's facts — a candidate build's own listing
 * when one is under test (harnessFacts already folded it in), this
 * checkout's static table otherwise — so the spec describes the binary the
 * probe launches, never the probing checkout's idea of it. */
export function prepareExperimentProbe(
  agent: AgentId,
  directory: string,
  fixtureServer: string,
  prefixes: readonly string[] = EXPERIMENT_HARNESSES[agent] ?? [],
  // The schema opt-ins come from the validator's own table: without them
  // the run refuses probe G's spec before launch (gemini's
  // wait_for_previous property).
  schemas: readonly string[] = EXPERIMENT_MCP_HARNESS_SCHEMAS[agent] ?? []
): ExperimentProbeSpec {
  const path = join(directory, "experiment-spec.json");
  writeFileSync(path, `${JSON.stringify({
    name: "gateEcho",
    command: process.execPath,
    args: [fixtureServer],
    env: [],
    recording: directory,
    ...(prefixes.length === 0 ? {} : { accept_harness_prefix: [...prefixes] }),
    ...(schemas.length === 0 ? {} : { accept_harness_schema: [...schemas] }),
  }, null, 2)}\n`);
  return {
    path,
    prompt: `Call the bash tool with command "gate", then reply with exactly the tool result text, nothing else.`,
  };
}

/** Probe C's verification: exit 0, a parseable envelope whose codemux block
 * is the documented schema (src/result-envelope/*.ts, types.ts
 * CodemuxResultBlock) for the probed agent — the agent matches, the reply
 * field the harness's shape promises is present, and every block key is
 * there with the documented type, usage with its five documented fields. A
 * cross-wired or truncated envelope builder fails instead of passing on a
 * bare agent string (review round 14, edges 5), a builder that spells the
 * answer with another harness's field fails (round 16, edges 3), and a key
 * present with the wrong type fails naming the field (round 16, edges 4).
 * Returns the failure reason, or null when the stdout passes. */
export function verifyResultEnvelope(stdout: string, agent: AgentId): string | null {
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return `result JSON does not parse: ${stdout.trim().slice(0, 80) || "(empty)"}`;
  }
  const block = envelope.codemux;
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return "result JSON has no codemux block";
  }
  const fields = block as Record<string, unknown>;
  if (fields.agent !== agent) {
    return `result JSON's codemux.agent is ${JSON.stringify(fields.agent) ?? "absent"}, not the probed ${agent}`;
  }
  // The reply field this harness's own shape promises (the shared table in
  // src/result-envelope/index.ts): an envelope spelling the answer with
  // another harness's field — kimi's `reply` on a claude envelope, or the
  // reverse — is the cross-wired builder, and fails.
  const answerField = RESULT_ANSWER_FIELD[agent];
  if (answerField === undefined) {
    return `${agent} has no documented --result-json envelope; the probe cannot verify it`;
  }
  const reply = envelope[answerField];
  if (typeof reply !== "string") {
    return `result JSON carries no '${answerField}' text: ${agent}'s envelope spells the answer '${answerField}'`;
  }
  // The probe's prompt asks the harness to reply with exactly OK (run.ts);
  // an answer that says something else is a wrong answer even though the
  // envelope around it is well formed (round 18, edges 5). Whitespace is
  // trimmed: the run probes accept a padded reply the same way.
  if (reply.trim() !== "OK") {
    return `result JSON's '${answerField}' is not the requested OK reply: ${JSON.stringify(reply.slice(0, 80))}`;
  }
  for (const key of ["model", "served_model", "session_id", "recording", "failure_code"]) {
    if (!(key in fields)) {
      return `result JSON's codemux block is missing the documented key '${key}'`;
    }
    const value = fields[key];
    if (value !== null && typeof value !== "string") {
      return `result JSON's codemux.${key} must be a string or null, not ${Array.isArray(value) ? "an array" : typeof value}`;
    }
  }
  if (!("labels" in fields)) {
    return "result JSON's codemux block is missing the documented key 'labels'";
  }
  const labels = fields.labels;
  if (
    labels !== null &&
    (typeof labels !== "object" || Array.isArray(labels) ||
      Object.values(labels).some((value) => typeof value !== "string"))
  ) {
    return `result JSON's codemux.labels must be an object of strings or null, not ${JSON.stringify(labels)}`;
  }
  const rawUsage = fields.usage;
  if (typeof rawUsage !== "object" || rawUsage === null || Array.isArray(rawUsage)) {
    return "result JSON's codemux block has no usage object";
  }
  const usage = rawUsage as Record<string, unknown>;
  for (const key of ["input_tokens", "output_tokens", "cached_input_tokens", "total_tokens", "cost_usd"]) {
    if (!(key in usage)) {
      return `result JSON's codemux.usage is missing the documented key '${key}'`;
    }
    const value = usage[key];
    // Token counts are non-negative integers; cost is a non-negative
    // number. Both may be null — never guessed (types.ts ResultUsageBlock).
    if (value === null) continue;
    const malformed = typeof value !== "number" || !Number.isFinite(value) || value < 0
      || (key !== "cost_usd" && !Number.isInteger(value));
    if (malformed) {
      return `result JSON's codemux.usage.${key} must be a non-negative ${key === "cost_usd" ? "number" : "integer"} or null, not ${JSON.stringify(value)}`;
    }
  }
  return null;
}

export interface SessionProbe {
  nonce: string;
  /** The probe's stdin exchange: the user frame opens, stdin stays open
   * while the turn runs, and the shutdown frame is the last frame, written
   * only after the turn completed on stdout. */
  exchange: StdinScript;
}

/** The scripted half of probe F's exchange: the shutdown frame answers the
 * first `turn_completed` event, and writing it ends stdin. The first
 * completion decides because the probe opens exactly one turn, so its
 * completion is the nonce turn's. */
function sessionShutdownOnCompletion(line: string): string | null {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  return event.type === "turn_completed" ? `${JSON.stringify({ type: "shutdown" })}\n` : null;
}

/** Probe F's session turn: one JSONL user frame — the session protocol's
 * only input grammar; plain text on stdin is rejected as malformed and
 * exercises no turn — whose text names a fresh nonce the harness must
 * reply with. The frame opens a scripted exchange, not a fixed stdin
 * string: closing stdin at once is EOF, which a session driver answers by
 * draining the session — one live gate watched codex reject the frame
 * outright (`input_rejected`, reason `shutting_down`) and kimi's drain
 * grace expire mid-turn — so the pipe stays open until the turn completes
 * and the shutdown frame then ends the session in an orderly way. The
 * expected nonce never appears in any file the harness reads. */
export function prepareSessionProbe(): SessionProbe {
  const nonce = randomBytes(6).toString("hex");
  const text = `Reply with exactly: ${nonce}`;
  return {
    nonce,
    exchange: {
      open: `${JSON.stringify({ type: "user", text })}\n`,
      next: sessionShutdownOnCompletion,
    },
  };
}

/** Probe F's verification over the session's JSONL event stream: the turn
 * the frame opened must COMPLETE with `finish: "end"` — a session that
 * exits 0 without a `turn_completed` event fails, and so does one whose
 * turn completed `failed` or `interrupted`, both protocol-legal on an
 * exiting-0 session (the driver raises no exit code for them; review
 * round 5, contracts-2 finding 1) — an `assistant_message` event must
 * carry the nonce reply, and the session must END in an orderly way: one
 * `session_ended` event with `reason: "shutdown"` and `exit_code: 0`, the
 * documented result of the probe's shutdown frame (docs/sessions.md, "End
 * conditions and failures"). A session ended by stdin EOF (`stdin-close`)
 * or killed (`signal`, `crash`, `harness_failed`) never saw that frame —
 * or never finished draining before its grace expired — and fails. The
 * completing turn must be the nonce's own: paired by `turn_id`, and by
 * order — the next `turn_completed` closes the turn an
 * `assistant_message` without a `turn_id` belonged to — when the message
 * carries none. The echoed `user_message` event also names the nonce, so
 * only assistant events count as the reply. Lines that do not parse (a
 * capture truncated mid-line) are skipped, not failed: the event
 * assertions carry the verdict. */
export function verifySessionTurn(stdout: string, nonce: string): string | null {
  let echoed = false;
  let nonceTurn: string | null | undefined;
  let anyCompletion = false;
  let nonceFinish: string | undefined;
  let sessionEnd: { reason?: unknown; exitCode?: unknown } | undefined;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    // session_ended is the stream's final event (docs/sessions.md); any
    // line after it, parseable or not, is a protocol violation the probe
    // must not certify (round 26, edges 4; round 32, edges 1).
    if (sessionEnd !== undefined) {
      return `a line followed session_ended, which must be the stream's final event: ${JSON.stringify(line.slice(0, 80))}`;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // The session stream is JSONL and nothing else: a banner or a corrupt
      // line is a protocol violation, not noise to skip (round 34, edges 5).
      return `a stdout line is not a JSON event: ${JSON.stringify(line.slice(0, 80))}`;
    }
    if (
      nonceFinish === undefined &&
      event.type === "assistant_message" &&
      typeof event.text === "string" &&
      // Exactly the nonce, as requested: a reply that merely contains it
      // proves less (review round 56).
      event.text.trim() === nonce
    ) {
      echoed = true;
      nonceTurn = typeof event.turn_id === "string" ? event.turn_id : null;
      continue;
    }
    // The first session_ended decides; it is the protocol's final event,
    // so a second one is a malformed stream the later checks still judge.
    if (event.type === "session_ended" && sessionEnd === undefined) {
      sessionEnd = { reason: event.reason, exitCode: event.exit_code };
      continue;
    }
    if (event.type !== "turn_completed") continue;
    anyCompletion = true;
    if (nonceFinish !== undefined || !echoed) continue;
    if (nonceTurn !== null && event.turn_id !== nonceTurn) continue;
    nonceFinish = typeof event.finish === "string" ? event.finish : "(missing)";
  }
  if (!anyCompletion) return "session exited without a completed turn";
  if (!echoed) return "no assistant_message event carries the nonce reply";
  if (nonceFinish === undefined) return "the turn that carried the nonce reply never completed";
  if (nonceFinish !== "end") return `the nonce turn completed with finish '${nonceFinish}', not 'end'`;
  if (sessionEnd === undefined) return "session exited without a session_ended event";
  if (sessionEnd.reason !== "shutdown") {
    return `session_ended reason is ${JSON.stringify(sessionEnd.reason) ?? "absent"}, not 'shutdown' — the shutdown frame never ended the session in an orderly way`;
  }
  if (sessionEnd.exitCode !== 0) {
    return `session_ended exit_code is ${JSON.stringify(sessionEnd.exitCode) ?? "absent"}, not 0`;
  }
  return null;
}

/** The session id of the probe's own session, from the first
 * `session_started` line it printed. Undefined when the capture carries
 * none (the harness died before the event): the leak check then falls
 * back to the probe's working directory. */
export function sessionStartedId(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "session_started" && typeof event.session_id === "string") {
      return event.session_id;
    }
  }
  return undefined;
}

/** Probe G's verification lives in experiment-echo.ts: the marker reply
 * rule plus the recording-based delivery proof. Re-exported for the hub
 * and run.ts. */
export { verifyExperimentEcho } from "./experiment-echo.js";

