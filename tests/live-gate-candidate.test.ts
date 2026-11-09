// Candidate-mode discovery for the live gate (review round 18, edges 4):
// when --codemux names a build that is not this checkout's launcher, the
// probe matrix must come from the candidate's own `list --json`, its
// --version must match this checkout, and the report must say where the
// matrix came from. The fake candidates below are fixture scripts, not
// harness binaries.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCandidateVersion,
  candidateFacts,
  discoverCandidate,
  formatReport,
  gateFailed,
  parseOptions,
  probeApplies,
  runContractColumn,
  unsupportedNote,
} from "../scripts/live-gate.js";
import { cleanupLoggedInHomes, loggedInEnv, passRow, reportInput } from "./helpers/live-gate.js";

// runProbes reads the login state before the matrix (audit D8); the
// fixture home keeps that read off the operator's own stores.
afterAll(cleanupLoggedInHomes);
import type { ProbeLetter } from "../scripts/live-gate.js";

const passRowSubject = (agent: string): ReturnType<typeof passRow> =>
  passRow(agent, ["A" as ProbeLetter]);

const LISTING = {
  schema: "codemux-list-1",
  agents: [
    {
      id: "claude",
      available: true,
      binary: "claude",
      // The experiment and served-model facts deliberately differ from
      // this checkout's tables (opencode here has an experiment mechanism,
      // claude does not): whatever the listing says is what the gate
      // probes with (round 20, edges 2).
      capabilities: { hermetic: true, checkHermetic: false, sessionHermetic: false, resultJson: true, budgetLimit: true, toolsNoneRequiresHermetic: false, toolsNone: true, providerOverride: true, sessions: true, experimentMcp: false, experimentPrefix: null, servedModelEvidence: true, model: true, effort: true,
        limitations: {
          "check.hermetic": { reason: "Synthetic candidate has no instruction control", evidence: "Synthetic fixture 1.0.0" },
          "session.hermetic": { reason: "Synthetic candidate has no session isolation", evidence: "Synthetic fixture 1.0.0" },
          "run.experiment-mcp": { reason: "Synthetic candidate has no experiment transport", evidence: "Synthetic fixture 1.0.0" },
        } },
    },
    {
      id: "opencode",
      available: true,
      // A renamed binary this checkout's adapters never spell: the
      // contract column must still probe the id (round 19, edges 4).
      binary: "opencode-candidate",
      capabilities: { hermetic: true, checkHermetic: true, sessionHermetic: true, resultJson: true, budgetLimit: false, toolsNoneRequiresHermetic: true, toolsNone: true, providerOverride: false, sessions: true, experimentMcp: true, experimentPrefix: "opencode-wall-time", servedModelEvidence: false, model: true, effort: true,
        limitations: {
          "run.provider-override": { reason: "Synthetic candidate has no provider routing", evidence: "Synthetic fixture 1.0.0" },
          "check.provider-override.served-model": { reason: "Synthetic candidate has no provider evidence", evidence: "Synthetic fixture 1.0.0" },
        } },
    },
    {
      // Installed nowhere on the candidate's machine: listed, not probed.
      id: "aider",
      available: false,
      binary: "aider",
      capabilities: { hermetic: false, checkHermetic: false, sessionHermetic: false, limitations: {}, resultJson: false, budgetLimit: false, toolsNoneRequiresHermetic: false, toolsNone: false, providerOverride: false, sessions: true, experimentMcp: false, experimentPrefix: null, servedModelEvidence: false, model: false, effort: false },
    },
  ],
};

describe("candidate listing parsing", () => {
  test("builds the matrix from the listing, available agents only", () => {
    const parsed = candidateFacts(LISTING, "candidate list --json");
    expect(parsed.facts.map((fact) => fact.id)).toEqual(["claude", "opencode"]);
    // The fact carries the candidate's own binary name: probe P judges the
    // printed argv against it, not this checkout's spelling (review round 52).
    expect(parsed.facts.find((fact) => fact.id === "opencode")?.binaryName).toBe("opencode-candidate");
    // The capabilities are the candidate's own declarations, not this
    // checkout's adapter registry: whatever the listing says is what the
    // gate probes with, and an unavailable agent never gets a row. The
    // experiment and served-model facts follow the listing even where it
    // contradicts this checkout's tables: claude declares no experiment
    // mechanism (probe G UNSUPPORTED for it) and opencode declares one
    // with its own wall-time prefix.
    expect(parsed.facts[0]).toMatchObject({ id: "claude", hermetic: true, resultJson: true, budgetLimit: true, toolsNoneRequiresHermetic: false, sessions: true, providerOverride: true, experiment: false, experimentPrefixes: [], servedModelEvidence: true });
    expect(parsed.facts[1]).toMatchObject({ id: "opencode", budgetLimit: false, toolsNoneRequiresHermetic: true, experiment: true, experimentPrefixes: ["opencode-wall-time"], servedModelEvidence: false });
    expect(parsed.facts[0]).toMatchObject({ checkHermetic: false, sessionHermetic: false,
      declarationSource: "candidate", limitations: LISTING.agents[0]!.capabilities.limitations });
    expect(parsed.facts[1]).toMatchObject({ checkHermetic: true, sessionHermetic: true });
    for (const letter of ["D", "K"] as const) {
      expect(probeApplies(letter, parsed.facts[0]!)).toBe(false);
      expect(probeApplies(letter, parsed.facts[1]!)).toBe(true);
    }
    expect(unsupportedNote("K", parsed.facts[0]!)).toBe("Synthetic candidate has no session isolation");
    // The contract column's input covers the same available ids, each
    // with the candidate's own binary name — including one this
    // checkout's adapters never spell.
    expect(parsed.contractHarnesses).toEqual([
      { id: "claude", binaryName: "claude" },
      { id: "opencode", binaryName: "opencode-candidate" },
    ]);
  });

  test("refuses a listing this gate cannot trust", () => {
    // Wrong schema, a missing boolean, an unknown agent, a duplicate row,
    // and a malformed capability value are each refused, never guessed or
    // dropped.
    expect(() => candidateFacts({ schema: "other", agents: [] }, "src")).toThrow("not codemux-list-1");
    expect(() => candidateFacts({ schema: "codemux-list-1", agents: [{ id: "claude" }] }, "src")).toThrow("available must be a boolean");
    expect(() => candidateFacts(
      { schema: "codemux-list-1", agents: [{ id: "nope", available: true, capabilities: {} }] },
      "src"
    )).toThrow("this codemux knows no such agent");
    expect(() => candidateFacts(
      { schema: "codemux-list-1", agents: [
        { id: "claude", available: true, capabilities: LISTING.agents[0]!.capabilities },
        { id: "claude", available: true, capabilities: LISTING.agents[0]!.capabilities },
      ] },
      "src"
    )).toThrow("listed twice");
    expect(() => candidateFacts(
      { schema: "codemux-list-1", agents: [{ id: "claude", available: true, capabilities: { ...LISTING.agents[0]!.capabilities, sessions: "yes" } }] },
      "src"
    )).toThrow("sessions must be a boolean");
    // The spend-limit fact is carried, not probed, so a malformed value is
    // refused while an absent one (an older listing) reads false below.
    expect(() => candidateFacts(
      { schema: "codemux-list-1", agents: [{ id: "claude", available: true, capabilities: { ...LISTING.agents[0]!.capabilities, budgetLimit: "yes" } }] },
      "src"
    )).toThrow("budgetLimit must be a boolean");
    // Audit D7: the alias+effort facts (probe I) are required booleans —
    // a listing from an older build is refused, never patched with this
    // checkout's own capabilities.
    expect(() => candidateFacts(
      { schema: "codemux-list-1", agents: [{ id: "claude", available: true, capabilities: { ...LISTING.agents[0]!.capabilities, model: undefined } }] },
      "src"
    )).toThrow("capabilities.model is absent; the listing is from an older build");
    expect(() => candidateFacts(
      { schema: "codemux-list-1", agents: [{ id: "claude", available: true, capabilities: { ...LISTING.agents[0]!.capabilities, effort: "low" } }] },
      "src"
    )).toThrow("effort must be a boolean");
    // Probe E keys on the plain tools-none fact, so it is required the same
    // way (parity pass, 2.0.0): a candidate's E set is its own.
    expect(() => candidateFacts(
      { schema: "codemux-list-1", agents: [{ id: "claude", available: true, capabilities: { ...LISTING.agents[0]!.capabilities, toolsNone: undefined } }] },
      "src"
    )).toThrow("toolsNone is absent; the listing is from an older build");
    expect(() => candidateFacts(
      { schema: "codemux-list-1", agents: [{ id: "claude", available: true, capabilities: { ...LISTING.agents[0]!.capabilities, toolsNone: "yes" } }] },
      "src"
    )).toThrow("toolsNone must be a boolean");
    // A binary field that is not a string is refused, never guessed.
    expect(() => candidateFacts(
      { schema: "codemux-list-1", agents: [{ id: "claude", available: true, binary: 3, capabilities: LISTING.agents[0]!.capabilities }] },
      "src"
    )).toThrow("binary must be a string");
    // The experiment and served-model fields are required: a listing
    // without them is an older build, and falling back to this checkout's
    // tables is exactly the defect their presence closes (round 20,
    // edges 2).
    expect(() => candidateFacts(
      { schema: "codemux-list-1", agents: [{ id: "claude", available: true, capabilities: { ...LISTING.agents[0]!.capabilities, experimentMcp: undefined } }] },
      "src"
    )).toThrow("experimentMcp is absent");
    expect(() => candidateFacts(
      { schema: "codemux-list-1", agents: [{ id: "claude", available: true, capabilities: { ...LISTING.agents[0]!.capabilities, servedModelEvidence: undefined } }] },
      "src"
    )).toThrow("servedModelEvidence is absent");
    expect(() => candidateFacts(
      { schema: "codemux-list-1", agents: [{ id: "claude", available: true, capabilities: { ...LISTING.agents[0]!.capabilities, experimentMcp: "yes" } }] },
      "src"
    )).toThrow("experimentMcp must be a boolean");
    expect(() => candidateFacts(
      { schema: "codemux-list-1", agents: [{ id: "claude", available: true, capabilities: { ...LISTING.agents[0]!.capabilities, experimentPrefix: 7 } }] },
      "src"
    )).toThrow("experimentPrefix must be a string or null");
  });

  test("a listing without experimentPrefix is refused by name, like its siblings (round 372, item 7)", () => {
    // The field was only type-checked when present, and the cast to
    // string | null read undefined as a prefix: facts.ts built
    // experimentPrefixes [undefined], the probe spec's
    // accept_harness_prefix JSON-rendered as [null], and the candidate
    // refused it as a malformed spec — a message about the spec when the
    // defect was the older listing.
    const { experimentPrefix, ...older } = LISTING.agents[0]!.capabilities;
    expect(experimentPrefix).toBe(null);
    expect(() => candidateFacts(
      { schema: "codemux-list-1", agents: [{ id: "claude", available: true, binary: "claude", capabilities: older }] },
      "src"
    )).toThrow("experimentPrefix is absent; the listing is from an older build");
  });

  test("a listing without budgetLimit reads false instead of refusing", () => {
    // No probe keys on the spend-limit fact, so a candidate listing from
    // a build without the field is carried with the false default, the
    // same way an absent capability reads everywhere else — never patched
    // from this checkout's adapters and never refused.
    const { budgetLimit, ...older } = LISTING.agents[0]!.capabilities;
    expect(budgetLimit).toBe(true);
    const parsed = candidateFacts(
      { schema: "codemux-list-1", agents: [{ id: "claude", available: true, binary: "claude", capabilities: older }] },
      "src"
    );
    expect(parsed.facts[0]!.budgetLimit).toBe(false);
    expect(parsed.facts[0]!.checkHermetic).toBe(false);
    expect(parsed.facts[0]!.sessionHermetic).toBe(false);
    expect(parsed.facts[0]!.limitations).toEqual(older.limitations);
  });

  test.each(["checkHermetic", "sessionHermetic", "limitations"] as const)(
    "refuses a listing without %s instead of using checkout declarations", (field) => {
      const capabilities: Record<string, unknown> = { ...LISTING.agents[0]!.capabilities };
      delete capabilities[field];
      expect(() => candidateFacts({ schema: LISTING.schema,
        agents: [{ id: "claude", available: true, capabilities }],
      }, "synthetic candidate")).toThrow(`capabilities.${field}`);
    }
  );

  test.each(["checkHermetic", "sessionHermetic"] as const)(
    "refuses malformed %s declarations", (field) => {
      for (const value of [null, "yes", 1, {}]) {
        expect(() => candidateFacts({ schema: LISTING.schema, agents: [{ id: "claude", available: true,
          capabilities: { ...LISTING.agents[0]!.capabilities, [field]: value },
        }] }, "synthetic candidate")).toThrow(`capabilities.${field} must be a boolean`);
      }
    }
  );

  test("refuses malformed limitation declarations and missing evidence", () => {
    for (const limitations of [null, [], "unsupported", { unknown: {} },
      { "session.hermetic": null }, { "session.hermetic": { reason: "", evidence: "fixture" } },
      { "session.hermetic": { reason: "fixture", evidence: " " } },
      { "session.hermetic": { reason: "fixture" } }]) {
      expect(() => candidateFacts({ schema: LISTING.schema, agents: [{ id: "claude", available: true,
        capabilities: { ...LISTING.agents[0]!.capabilities, limitations },
      }] }, "synthetic candidate")).toThrow();
    }
  });

  test("the gate's static tables are the src tables, so a checkout's facts and its candidate facts cannot drift (round 20, edges 2)", async () => {
    // In default mode the gate's G and H sets come from this checkout's
    // tables; in candidate mode the same facts arrive through the
    // listing, whose fields src/info-commands.ts derives from the same
    // tables (pinned by tests/info-commands.test.ts). Both spellings are
    // the src tables themselves, never a second literal.
    const { EXPERIMENT_MCP_HARNESSES } = await import("../src/experiment-mcp.js");
    const { SERVED_MODEL_EVIDENCE_HARNESSES } = await import("../src/result-envelope/index.js");
    const { EXPERIMENT_HARNESSES, SERVED_MODEL_EVIDENCE } = await import("../scripts/live-gate.js");
    expect(EXPERIMENT_HARNESSES).toBe(EXPERIMENT_MCP_HARNESSES);
    expect(SERVED_MODEL_EVIDENCE).toBe(SERVED_MODEL_EVIDENCE_HARNESSES);
  });

  test("a listing without binary fields still earns its contract rows", () => {
    // An older candidate's listing carries no binary names: the ids stay
    // (the row is UNREADABLE, naming the id) rather than vanishing.
    const parsed = candidateFacts({
      schema: "codemux-list-1",
      agents: [
        { id: "claude", available: true, capabilities: LISTING.agents[0]!.capabilities },
      ],
    }, "src");
    expect(parsed.contractHarnesses).toEqual([{ id: "claude" }]);
  });
});

test.each(["kimi-candidate-wall-time", null])("probe G's spec carries the build under test's prefix: %s", async (candidatePrefix) => {
  // A candidate declaring a DIFFERENT experiment prefix than this
  // checkout's static table used to get a spec built from the static
  // prefix, so the candidate refused its own probe for a reason that was
  // the probing checkout's, not the candidate's (lane C30, item 1).
  const { harnessFacts, parseOptions, runProbes } = await import("../scripts/live-gate.js");
  const { EXPERIMENT_MCP_HARNESSES } = await import("../src/experiment-mcp.js");
  const specs: string[] = [];
  const runner = {
    run: async () => ({ status: "PASS" as const, seconds: 0, stderr: "" }),
    capture: async (command: string[]) => {
      // The spec path rides the probe's own argv; read it before the probe
      // directory is cleaned up.
      specs.push(readFileSync(command[command.indexOf("--experiment-mcp") + 1]!, "utf8"));
      return { status: "PASS" as const, seconds: 0, stderr: "" };
    },
  };
  expect(EXPERIMENT_MCP_HARNESSES.kimi).not.toContain(candidatePrefix);
  const listing = {
    schema: "codemux-list-1",
    agents: [{ id: "kimi", available: true, capabilities: {
      hermetic: true, resultJson: false, toolsNoneRequiresHermetic: true, toolsNone: true, providerOverride: false,
      sessions: false, experimentMcp: true, experimentPrefix: candidatePrefix, servedModelEvidence: false,
      model: true, effort: true, checkHermetic: false, sessionHermetic: false, limitations: {},
    } }],
  };
  const facts = candidateFacts(listing, "candidate list --json").facts;
  const options = parseOptions(["--codemux", process.execPath, "--probe", "g"], "", {});
  const report = mkdtempSync(join(tmpdir(), "codemux-live-gate-spec-"));
  try {
    await runProbes(facts, options, runner, report, loggedInEnv().env);
    expect(specs).toHaveLength(1);
    expect(JSON.parse(specs[0]!).accept_harness_prefix ?? []).toEqual(candidatePrefix === null ? [] : [candidatePrefix]);

    // Static mode (no candidate) keeps reading this checkout's table.
    specs.length = 0;
    await runProbes(
      [harnessFacts("kimi", { supportsHermetic: true, toolsNoneRequiresHermetic: true }, false)],
      options, runner, report, loggedInEnv().env
    );
    expect(specs).toHaveLength(1);
    expect(JSON.parse(specs[0]!).accept_harness_prefix).toEqual([...EXPERIMENT_MCP_HARNESSES.kimi!]);
  } finally {
    rmSync(report, { recursive: true, force: true });
  }
});

describe("candidate version refusal", () => {
  test("a matching version passes and a mismatch is refused by name", () => {
    expect(() => assertCandidateVersion("2.0.0", "2.0.0", "/candidate", false)).not.toThrow();
    expect(() => assertCandidateVersion("2.0.1", "2.0.0", "/candidate", false))
      .toThrow("reports version 2.0.1, but this checkout is 2.0.0");
    // The operator's explicit allowance lifts only the refusal.
    expect(() => assertCandidateVersion("2.0.1", "2.0.0", "/candidate", true)).not.toThrow();
  });
});

describe("candidate discovery end to end", () => {
  const root = mkdtempSync(join(tmpdir(), "codemux-live-gate-candidate-"));

  /** A fake candidate: `--version` answers the given stamp, `list --json`
   * answers the given listing, anything else exits 64. */
  const fakeCandidate = (name: string, version: string, listing: unknown): string => {
    const path = join(root, name);
    writeFileSync(path, `#!${process.execPath}
      const args = process.argv.slice(2);
      if (args[0] === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }
      if (args[0] === "list" && args[1] === "--json") { console.log(${JSON.stringify(JSON.stringify(listing))}); process.exit(0); }
      console.error("unexpected arguments"); process.exit(64);
    `, { mode: 0o700 });
    return path;
  };

  test("discovery reads the matrix from the candidate and stamps the report", async () => {
    const candidate = fakeCandidate("candidate-ok", "9.9.9", LISTING);
    const discovery = await discoverCandidate(candidate, "9.9.9", false, "9.9.9");
    expect(discovery.facts.map((fact) => fact.id)).toEqual(["claude", "opencode"]);
    expect(discovery.contractHarnesses).toEqual([
      { id: "claude", binaryName: "claude" },
      { id: "opencode", binaryName: "opencode-candidate" },
    ]);
    expect(discovery.note).toContain(candidate);
    expect(discovery.note).toContain("list --json");
    // The report header names the source of the matrix.
    const report = formatReport(reportInput({ matrixNote: discovery.note }));
    expect(report).toContain(discovery.note);
    // Without a candidate there is no NOTE line.
    expect(formatReport(reportInput())).not.toContain("NOTE: the probe matrix");
  });

  test("a candidate-available harness this checkout cannot resolve gets an UNREADABLE row (round 19, edges 4)", async () => {
    // The contract column probes the candidate's own binary names: a
    // renamed binary resolves to nothing HERE, and the row says so
    // instead of the harness vanishing from the table.
    const rows = await runContractColumn(
      [{ id: "opencode", binaryName: "opencode-candidate" }],
      { which: () => null }
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdict).toBe("UNREADABLE");
    expect(rows[0]?.detail).toContain("opencode-candidate");
  });

  test("a required contract row that is missing fails the gate and names the id", () => {
    const base = reportInput({
      rows: [passRowSubject("claude")],
      requiredContractIds: new Set(["claude", "opencode" as const]),
      contracts: [{ agent: "claude", version: "1.0.0", min: "1.0.0", ceiling: "2.0.0", verdict: "SUPPORTED", detail: "" }],
    });
    expect(gateFailed(base)).toBe(true);
    expect(formatReport(base)).toContain("no version contract row for opencode");
    // The same input with opencode's row present does not fail on THIS
    // rule; its UNREADABLE verdict fails the contract rule instead (round
    // 29, edges 1), and --allow-stale-contracts lifts that like the others.
    const complete = reportInput({
      rows: [passRowSubject("claude")],
      requiredContractIds: new Set(["claude", "opencode" as const]),
      contracts: [
        { agent: "claude", version: "1.0.0", min: "1.0.0", ceiling: "2.0.0", verdict: "SUPPORTED", detail: "" },
        { agent: "opencode", version: "1.0.0", min: "1.0.0", ceiling: "2.0.0", verdict: "UNREADABLE", detail: "could not resolve the opencode-candidate binary" },
      ],
    });
    expect(formatReport(complete)).not.toContain("no version contract row");
    expect(gateFailed(complete)).toBe(true);
    expect(gateFailed({ ...complete, allowStaleContracts: true })).toBe(false);
  });

  test("a version mismatch is refused before the listing is read", async () => {
    const candidate = fakeCandidate("candidate-mismatch", "9.9.8", LISTING);
    // The version stamp is passed in (main() reads it once); a refused
    // candidate's listing command must never run.
    await expect(discoverCandidate(candidate, "9.9.9", false, "9.9.8"))
      .rejects.toThrow("reports version 9.9.8, but this checkout is 9.9.9");
    // The allowance proceeds and reads the listing.
    const allowed = await discoverCandidate(candidate, "9.9.9", true, "9.9.8");
    expect(allowed.facts.map((fact) => fact.id)).toEqual(["claude", "opencode"]);
  });

  test("a candidate whose listing fails is refused", async () => {
    const broken = join(root, "candidate-broken");
    writeFileSync(broken, `#!${process.execPath}
      const args = process.argv.slice(2);
      if (args[0] === "--version") { console.log("9.9.9"); process.exit(0); }
      if (args[0] === "list") { console.error("no json here"); process.exit(3); }
      process.exit(64);
    `, { mode: 0o700 });
    await expect(discoverCandidate(broken, "9.9.9", false, "9.9.9"))
      .rejects.toThrow("exited 3");
  });

  test("--allow-version-mismatch parses on the gate options", () => {
    const options = parseOptions(["--codemux", join(root, "candidate-ok"), "--allow-version-mismatch"], "");
    expect(options.allowVersionMismatch).toBe(true);
    expect(parseOptions(["--codemux", join(root, "candidate-ok")], "").allowVersionMismatch).toBe(false);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
});
