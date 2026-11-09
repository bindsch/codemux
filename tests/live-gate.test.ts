// Option parsing, probe selection, and the probe matrix for the live
// gate. The runner, probe orchestration, report, contract columns, and
// main() subprocess tests live in the tests/live-gate-*.test.ts siblings;
// scripts/live-gate.ts owns the gate under test.
import { expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IDS, type AgentId } from "../src/types.js";
import { assertExperimentMcpUnavailable, EXPERIMENT_MCP_HARNESS_SCHEMAS } from "../src/experiment-mcp.js";
import { agentsSupporting, PARITY } from "../src/parity/index.js";
import { PROBE_FEATURE } from "../src/parity/probe-features.js";
import {
  DEFAULT_PROBES,
  EXPERIMENT_HARNESSES,
  PROBE_LETTERS,
  liveSessionLeak,
  parseOptions,
  prepareExperimentProbe,
  probeApplies,
  providerOverridePreflight,
  unsupportedNote,
  runProbes,
  sessionStartedId,
  type ProbeLetter,
} from "../scripts/live-gate.js";
import { ROOT, factsFor, fixtureDirectory } from "./helpers/live-gate.js";

test("live gate validates limits and combines credential skips", () => {
  const options = parseOptions(["--timeout", "12", "--jobs", "2", "--skip", "qwen"], "gemini, goose");
  expect(options.timeout).toBe(12);
  expect(options.jobs).toBe(2);
  expect([...options.skip]).toEqual(["gemini", "goose", "qwen"]);
  expect(parseOptions([], undefined).timeout).toBe(600);
  expect(parseOptions([], undefined).jobs).toBe(4);
  expect(parseOptions([], undefined).probes).toEqual([...DEFAULT_PROBES]);
  expect(parseOptions([], "").codemux).toBe(join(ROOT, "bin/codemux"));
  for (const args of [["--jobs", "5"], ["--jobs", "0"], ["--timeout", "NaN"], ["--timeout", "0"]]) {
    expect(() => parseOptions(args, undefined)).toThrow();
  }
  expect(() => parseOptions(["--skip", "unknown"], undefined)).toThrow();
});

test("live gate selects and excludes probes by letter or name", () => {
  expect(parseOptions(["--probe", "A,B"], "").probes).toEqual(["A", "B"]);
  expect(parseOptions(["--probe", "provider-override"], "").probes).toEqual(["H"]);
  expect(parseOptions(["--probe", " a , result-json "], "").probes).toEqual(["A", "C"]);
  expect(parseOptions(["--probe", "loopback-override,alias-effort,sandbox"], "").probes).toEqual(["H2", "I", "J"]);
  // The split of the old alias+effort probe: I keeps the alias names, I2
  // answers the effort spellings.
  expect(parseOptions(["--probe", "model-alias"], "").probes).toEqual(["I"]);
  expect(parseOptions(["--probe", "effort,effort-low,i2"], "").probes).toEqual(["I2"]);
  expect(parseOptions(["--skip-probe", "B,D"], "").probes).toEqual(["A", "C", "E", "F", "G", "H2", "I", "I2", "J", "K", "P"]);
  expect(parseOptions(["--probe", "print-sandbox"], "").probes).toEqual(["P"]);
  expect(parseOptions(["--probe", "A,H", "--skip-probe", "h"], "").probes).toEqual(["A"]);
  expect(parseOptions(["--allow-stale-contracts"], "").allowStaleContracts).toBe(true);
  expect(parseOptions([], "").allowStaleContracts).toBe(false);
  expect(parseOptions(["--allow-known-breaks"], "").allowKnownBreaks).toBe(true);
  expect(parseOptions([], "").allowKnownBreaks).toBe(false);
  expect([...parseOptions(["--probe-anyway", "claude,goose"], "").probeAnyway]).toEqual(["claude", "goose"]);
  expect(parseOptions([], "").probeAnyway.size).toBe(0);
  for (const selection of ["--probe unknown", "--probe 0", "--probe ,", "--probe A --skip-probe A", "--skip-probe 0", "--probe-anyway unknown"]) {
    expect(() => parseOptions(selection.split(" "), "")).toThrow();
  }
});

test("live gate refuses a provider-override opt-in that is not exactly 1", () => {
  expect(() => parseOptions(["--probe", "H"], "", { LIVE_GATE_PROVIDER_OVERRIDE: "yes" })).toThrow();
  expect(parseOptions(["--probe", "H"], "", { LIVE_GATE_PROVIDER_OVERRIDE: "1" }).probes).toEqual(["H"]);
});

test("the provider-override preflight refuses an opt-in with a missing override variable", () => {
  // Review round 4, edges finding H: with a variable missing or empty the
  // probe ran WITHOUT the override and verified the operator's default
  // credentials instead. Refused before any probe spawns, naming it.
  const options = {
    probes: ["H"] as ProbeLetter[],
    skip: new Set<AgentId>(),
    only: undefined,
  };
  const complete = {
    CODEMUX_CLAUDE_PROVIDER_BASE_URL: "http://127.0.0.1:8011/v1",
    CODEMUX_CLAUDE_PROVIDER_API_KEY: "sk-test",
    CODEMUX_CLAUDE_PROVIDER_MODEL: "glm-5.3",
  };
  // Without the opt-in the preflight is silent: probe H is skipped.
  expect(providerOverridePreflight([factsFor("claude")], options, {})).toBeUndefined();
  expect(providerOverridePreflight([factsFor("claude")], options, {
    LIVE_GATE_PROVIDER_OVERRIDE: "1",
    ...complete,
  })).toBeUndefined();
  for (const name of ["CODEMUX_CLAUDE_PROVIDER_BASE_URL", "CODEMUX_CLAUDE_PROVIDER_API_KEY", "CODEMUX_CLAUDE_PROVIDER_MODEL"]) {
    const env: Record<string, string | undefined> = { LIVE_GATE_PROVIDER_OVERRIDE: "1", ...complete };
    delete env[name];
    expect(() => providerOverridePreflight([factsFor("claude")], options, env))
      .toThrow(`${name} is missing or empty`);
  }
  // An empty value is as missing.
  expect(() => providerOverridePreflight([factsFor("claude")], options, {
    LIVE_GATE_PROVIDER_OVERRIDE: "1",
    ...complete,
    CODEMUX_CLAUDE_PROVIDER_API_KEY: "",
  })).toThrow("CODEMUX_CLAUDE_PROVIDER_API_KEY is missing or empty");
  // A harness that will not run H never trips the preflight: operator
  // skip, --only exclusion, H unselected, or H unsupported for it.
  expect(providerOverridePreflight([factsFor("claude")], { ...options, skip: new Set<AgentId>(["claude"]) }, {
    LIVE_GATE_PROVIDER_OVERRIDE: "1",
  })).toBeUndefined();
  // Gemini runs probe H since its served-model evidence landed; codex's
  // served-model evidence is a declared harness limitation, so it is the
  // harness H never applies to.
  expect(PARITY.codex["check.provider-override.served-model"].state).toBe("harness-limitation");
  expect(providerOverridePreflight(
    [factsFor("claude"), factsFor("codex")],
    { ...options, only: new Set<AgentId>(["codex"]) },
    { LIVE_GATE_PROVIDER_OVERRIDE: "1" }
  )).toBeUndefined();
  expect(providerOverridePreflight([factsFor("claude")], { ...options, probes: ["A"] as ProbeLetter[] }, {
    LIVE_GATE_PROVIDER_OVERRIDE: "1",
  })).toBeUndefined();
  expect(providerOverridePreflight([factsFor("codex")], options, {
    LIVE_GATE_PROVIDER_OVERRIDE: "1",
  })).toBeUndefined();
  expect(() => providerOverridePreflight([factsFor("gemini")], options, {
    LIVE_GATE_PROVIDER_OVERRIDE: "1",
  })).toThrow("CODEMUX_GEMINI_PROVIDER_BASE_URL is missing or empty");
});

test("runProbes refuses the opt-in before any probe spawns", async () => {
  // The preflight is wired into runProbes itself, so the refusal fires
  // before the runner can spend a single request.
  const options = {
    codemux: "codemux",
    timeout: 1,
    jobs: 1,
    skip: new Set<AgentId>(),
    probes: ["H"] as ProbeLetter[],
    allowStaleContracts: false,
    allowKnownBreaks: false,
    probeAnyway: new Set<AgentId>(),
    codexModel: "worker",
    allowVersionMismatch: false,
  };
  const runner = {
    run: () => { throw new Error("no probe may spawn"); },
    capture: () => { throw new Error("no probe may spawn"); },
  };
  const directory = fixtureDirectory();
  try {
    expect(runProbes([factsFor("claude")], options, runner, directory, {
      LIVE_GATE_PROVIDER_OVERRIDE: "1",
      CODEMUX_CLAUDE_PROVIDER_BASE_URL: "http://127.0.0.1:8011/v1",
      CODEMUX_CLAUDE_PROVIDER_MODEL: "glm-5.3",
    })).rejects.toThrow("CODEMUX_CLAUDE_PROVIDER_API_KEY is missing or empty");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live gate validates and deduplicates the selected harnesses", () => {
  const options = parseOptions(["--only", " agy,kimi,agy ", "--skip", "kimi"], "");
  expect([...(options.only ?? [])]).toEqual(["agy", "kimi"]);
  expect([...options.skip]).toEqual(["kimi"]);
  expect(parseOptions([], "").only).toBeUndefined();
  for (const selection of ["unknown", "", " , "]) {
    expect(() => parseOptions(["--only", selection], "")).toThrow();
  }
});

test.each([...PROBE_LETTERS])("probe %s applicability matches the parity declaration", (letter) => {
  const feature = PROBE_FEATURE[letter];
  const expected = feature === null ? [...AGENT_IDS] : agentsSupporting(feature);
  expect(AGENT_IDS.filter((id) => probeApplies(letter, factsFor(id))).sort()).toEqual(expected.sort());
});

test("the experiment probe set matches the experiment validator", () => {
  // Each harness is validated against the spec probe G itself writes, so a
  // spec the run path would refuse (gemini's schema opt-in was once
  // missing) fails here, not on the live gate.
  const directory = fixtureDirectory();
  try {
    for (const id of AGENT_IDS) {
      const spec = prepareExperimentProbe(id, directory, "/fixture/server.ts").path;
      let accepted = true;
      try {
        assertExperimentMcpUnavailable(id, spec);
      } catch {
        accepted = false;
      }
      expect(accepted, `probe G and the validator disagree about ${id}`).toBe(EXPERIMENT_HARNESSES[id] !== undefined);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("experiment specs set accept_harness_prefix per harness", () => {
  const directory = fixtureDirectory();
  try {
    for (const [agent, prefixes] of Object.entries(EXPERIMENT_HARNESSES)) {
      const spec = prepareExperimentProbe(agent as (typeof AGENT_IDS)[number], directory, "/fixture/server.ts");
      const parsed = JSON.parse(readFileSync(spec.path, "utf8"));
      expect(parsed.command).toBe(process.execPath);
      expect(parsed.args).toEqual(["/fixture/server.ts"]);
      expect(parsed.name).toBe("gateEcho");
      expect(parsed.recording).toBe(directory);
      expect(parsed.accept_harness_prefix ?? []).toEqual([...(prefixes ?? [])]);
      expect(parsed.accept_harness_schema ?? []).toEqual([...(EXPERIMENT_MCP_HARNESS_SCHEMAS[agent as AgentId] ?? [])]);
      expect(spec.prompt).toContain("bash tool");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the session leak check blames only the probe's own record (round 10, contracts 8)", () => {
  // The check used to count any live entry of the same agent since the
  // probe started, so an operator's parallel session of that agent failed
  // a healthy probe. The probe's record is matched by session id, or by
  // working directory when the capture carries no session_started line.
  const mkdtemp = Bun.spawnSync(["mktemp", "-d"]).stdout.toString().trim();
  const registry = join(mkdtemp, "live-sessions.json");
  const now = new Date().toISOString();
  const entry = (overrides: Record<string, unknown>) => ({
    id: "probe-session", agent: "claude", cwd: "/probe/cwd",
    created_at: now, ended: null, ...overrides,
  });
  try {
    // An unrelated live claude session, started after the probe: not the
    // probe's leak.
    writeFileSync(registry, JSON.stringify({
      version: 1,
      sessions: [entry({ id: "operator-session", cwd: "/operator/cwd" })],
    }));
    expect(liveSessionLeak("claude", Date.now() - 60_000, registry, "probe-session")).toBeNull();

    // The probe's own record still live: the leak is named.
    writeFileSync(registry, JSON.stringify({
      version: 1,
      sessions: [
        entry({ id: "operator-session", cwd: "/operator/cwd" }),
        entry({}),
      ],
    }));
    expect(liveSessionLeak("claude", Date.now() - 60_000, registry, "probe-session"))
      .toContain("1 live registry entry left for claude");

    // No session_started line in the capture: the working directory
    // identifies the probe's record instead.
    expect(liveSessionLeak("claude", Date.now() - 60_000, registry, undefined, "/probe/cwd"))
      .toContain("1 live registry entry left for claude");
    expect(liveSessionLeak("claude", Date.now() - 60_000, registry, undefined, "/operator/cwd"))
      .toContain("1 live registry entry left for claude");
    expect(liveSessionLeak("claude", Date.now() - 60_000, registry, undefined, "/unrelated/cwd")).toBeNull();

    // The probe's record, ended: no leak.
    writeFileSync(registry, JSON.stringify({
      version: 1,
      sessions: [entry({ ended: now })],
    }));
    expect(liveSessionLeak("claude", Date.now() - 60_000, registry, "probe-session")).toBeNull();
  } finally {
    rmSync(mkdtemp, { recursive: true, force: true });
  }
});

test("with id and cwd both known, a live entry in the probe's directory is a leak whatever id it carries (round 199)", () => {
  // A candidate that printed a wrong session id used to hide a live
  // entry sitting in the probe's own working directory: the check
  // returned on the id alone. With both facts known, either one names
  // the probe's record — the probe's cwd is its own fresh directory.
  // An operator's unrelated live session (other id, other cwd) still
  // does not.
  const mkdtemp = Bun.spawnSync(["mktemp", "-d"]).stdout.toString().trim();
  const registry = join(mkdtemp, "live-sessions.json");
  const now = new Date().toISOString();
  try {
    writeFileSync(registry, JSON.stringify({
      version: 1,
      sessions: [
        { id: "hidden-id", agent: "claude", cwd: "/probe/cwd", created_at: now, ended: null },
        { id: "operator-session", agent: "claude", cwd: "/operator/cwd", created_at: now, ended: null },
      ],
    }));
    expect(liveSessionLeak("claude", Date.now() - 60_000, registry, "printed-id", "/probe/cwd"))
      .toContain("1 live registry entry left for claude");
    expect(liveSessionLeak("claude", Date.now() - 60_000, registry, "printed-id", "/other/cwd"))
      .toBeNull();
  } finally {
    rmSync(mkdtemp, { recursive: true, force: true });
  }
});

test("an unreadable or malformed registry fails the leak check instead of reading as no leak (round 16, contracts-2 1)", () => {
  // The end-state check used to catch every read or parse failure and
  // answer null — a vacuous pass for a registry it never saw. Only an
  // absent registry file is nothing to check.
  const mkdtemp = Bun.spawnSync(["mktemp", "-d"]).stdout.toString().trim();
  const registry = join(mkdtemp, "live-sessions.json");
  try {
    writeFileSync(registry, "{not json");
    expect(liveSessionLeak("claude", Date.now() - 60_000, registry, "probe-session"))
      .toContain("could not read the live-session registry");
    chmodSync(registry, 0o000);
    expect(liveSessionLeak("claude", Date.now() - 60_000, registry, "probe-session"))
      .toContain("could not read the live-session registry");
    expect(liveSessionLeak("claude", Date.now() - 60_000, join(mkdtemp, "absent.json"), "probe-session"))
      .toBeNull();
  } finally {
    chmodSync(registry, 0o600);
    rmSync(mkdtemp, { recursive: true, force: true });
  }
});

test("the hermetic session canary's UNSUPPORTED note quotes its declaration", () => {
  for (const id of AGENT_IDS) {
    const state = PARITY[id]["session.hermetic"];
    if (state.state === "harness-limitation") {
      expect(unsupportedNote("K", factsFor(id)), id).toBe(state.reason);
    }
  }
  // Without facts the note stays generic; the run passes the fact.
  expect(unsupportedNote("K")).toContain("session driver and a hermetic capability");
});

test("sessionStartedId reads the first session_started line", () => {
  const line = (event: Record<string, unknown>) => JSON.stringify(event);
  expect(sessionStartedId(
    `${line({ type: "turn_started" })}\n\n${line({ type: "session_started", session_id: "sess-7" })}\n${line({ type: "session_started", session_id: "sess-8" })}\n`
  )).toBe("sess-7");
  expect(sessionStartedId(`${line({ type: "session_started" })}\nnot json\n`)).toBeUndefined();
  expect(sessionStartedId("")).toBeUndefined();
});

test("make live-gate forwards LIVE_GATE_ARGS", async () => {
  const result = Bun.spawnSync(["make", "-n", "live-gate", "LIVE_GATE_ARGS=--pass-env CODEMUX_CURSOR_ENTRY"], { cwd: ROOT });
  expect(result.exitCode).toBe(0);
  // GNU make on CI prints "Entering directory" lines around the recipe.
  expect(result.stdout.toString().split("\n").map((line) => line.trim()))
    .toContain("bun run scripts/live-gate.ts --pass-env CODEMUX_CURSOR_ENTRY");
});
