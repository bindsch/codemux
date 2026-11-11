import { afterAll, expect, test } from "bun:test";
import { readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AiderAdapter } from "../src/adapters/aider.js";
import { aiderHistoryHeader } from "../src/aider-history-text.js";
import { aiderHistoryProviderFailure, aiderProviderFailure } from "../src/aider-failure.js";
import { enforceNonEmptyResult } from "../src/result-empty.js";
import { aliasRow } from "../src/doctor-environment.js";
import { loadConfig } from "../src/config.js";
import { gateOutcomeOnResult } from "../src/quota-gate.js";
import { POLICY, result, window } from "./helpers/quota-gate.js";
import { newRecord, makeRoot as makeRegistryRoot, registryIn } from "./helpers/session-registry.js";
import { recordSessionStart, recordSessionEnd, readRegistry } from "../src/session/registry.js";
import { nativeSessionId, scopedResumePattern } from "../src/session/scoped-id.js";
import { getAdapter } from "../src/adapters/index.js";
import { AGENT_IDS } from "../src/types.js";
import { GOOSE_SESSION_ID_PATTERN } from "../src/session/goose-session.js";
import { CLINE_SESSION_ID_PATTERN } from "../src/session/cline-session.js";
import { engineSession, fakeTurnProcess, watchingHome, wireProfile } from "./helpers/session-turn-engine.js";
import { openSessionPrivateHome } from "../src/session/private-home.js";
import { SESSION_AGENTS } from "../src/session/cli-agents.js";

const roots: string[] = [];
const makeRoot = () => { const root = makeRegistryRoot(); roots.push(root); return root; };
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

test.each(["goose", "cline"] as const)("%s scopes duplicate native IDs and restores the native resume argument", async (agent) => {
  const native = agent === "goose" ? "20261111_1" : "1794400000000_abcde_cli";
  const pattern = agent === "goose" ? GOOSE_SESSION_ID_PATTERN : CLINE_SESSION_ID_PATTERN;
  const ids: string[] = [];
  const root = makeRoot();
  const path = registryIn(root);
  const parent = join(root, "homes");
  const idPattern = SESSION_AGENTS[agent]!.resumePattern;
  for (let index = 0; index < 2; index++) {
    const child = fakeTurnProcess();
    const home = openSessionPrivateHome({ parent, resume: false, idPattern, blockedPaths: [] });
    writeFileSync(join(home.dir, "transcript"), `conversation ${index}`);
    const h = engineSession({ options: { registryPath: path, privateHome: home,
      profile: wireProfile({ sessionId: native }, { agent, identity: "deferred" }), spawnTurn: async () => child } });
    try {
      h.user(); child.exit(0);
      const start = await h.wait("session_started");
      const id = start.session_id as string;
      ids.push(id);
      expect(nativeSessionId(agent, id)).toBe(native);
      expect(scopedResumePattern(agent, pattern).test(id)).toBe(true);
      expect(scopedResumePattern(agent, pattern).test(native)).toBe(true);
      expect(scopedResumePattern(agent, pattern).test(id + "/bad")).toBe(false);
      await h.wait("turn_completed");
      expect(home.dir).toBe(join(parent, `session-${id}`));
      expect(readFileSync(join(home.dir, "transcript"), "utf8")).toBe(`conversation ${index}`);
      h.shutdown(); expect(await h.code()).toBe(0);
    } finally { h.dispose(); }
  }
  expect(ids[0]).not.toBe(ids[1]);
  const registry = readRegistry(path);
  expect(registry.outcome).toBe("ok");
  if (registry.outcome === "ok") expect(registry.file.sessions.map(s => s.id)).toEqual(ids);
  let passed: string | null = null;
  const child = fakeTurnProcess();
  const resumedHome = openSessionPrivateHome({ parent, resume: true, sessionId: ids[1], idPattern, blockedPaths: [] });
  expect(readFileSync(join(resumedHome.dir, "transcript"), "utf8")).toBe("conversation 1");
  const h = engineSession({ options: { resumeSessionId: ids[1], privateHome: resumedHome,
    profile: wireProfile({ sessionId: native }, { agent, identity: "deferred",
      buildTurnCommand: input => { passed = input.sessionId; return ["fake"]; } }),
    spawnTurn: async build => { build({}); return child; } } });
  try {
    h.user(); child.exit(0); await h.wait("turn_completed");
    expect(passed as string | null).toBe(native);
    h.shutdown(); expect(await h.code()).toBe(0);
  } finally { h.dispose(); }
});

test.each([...AGENT_IDS])("%s completed records cannot be replaced by another home or agent", agent => {
  const path = registryIn(makeRoot());
  expect(recordSessionStart(path, newRecord({ agent })).ok).toBe(true);
  recordSessionEnd(path, newRecord().id, false);
  const before = readFileSync(path, "utf8");
  for (const patch of [{ harness_home: "/different/home" }, { agent: agent === "goose" ? "claude" as const : "goose" as const }]) {
    const outcome = recordSessionStart(path, newRecord({ agent, ...patch }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("session_collision");
    expect(readFileSync(path, "utf8")).toBe(before);
  }
});

test("home settlement failure fails the turn and session", async () => {
  const child = fakeTurnProcess();
  const h = engineSession({ options: { privateHome: watchingHome({ settleThrows: true }), spawnTurn: async () => child } });
  try {
    h.user(); child.exit(0);
    expect((await h.wait("turn_completed")).finish).toBe("failed");
    expect(await h.code()).toBe(1);
    expect((await h.wait("session_ended")).resumable).toBe(false);
  } finally { h.dispose(); }
});

test.each([false, true])("aider requires history answer (hermetic=%s), rejects provider failure, and cleans history", (hermetic) => {
  const home = makeRoot();
  const adapter = new AiderAdapter({}, home);
  const request = { agent: "aider" as const, prompt: "first\nsecond", hermetic };
  const context = adapter.prepareRun(request);
  const path = context.aiderHistoryFile!.path;
  const raw = { stdout: "Aider v0.86.2\nMain model: test\n", stderr: "", exitCode: 0, success: true };
  const process = (stdout = raw.stdout) => enforceNonEmptyResult(adapter.processRunResult({ ...raw, stdout }, request, context), request, 0);
  try {
    expect(process().success).toBe(false);
    writeFileSync(path, aiderHistoryHeader(request.prompt) + "\n> Repo-map: disabled\n");
    expect(process().success).toBe(false);
    writeFileSync(path, aiderHistoryHeader(request.prompt) + "\nActual answer\n> Tokens: 3\n");
    expect(process().success).toBe(true);
    expect(process().reply).toBe("Actual answer");
    writeFileSync(path, aiderHistoryHeader(request.prompt) + "\n> The API provider is not able to authenticate you. Check your API key.\nPartial answer\n");
    const failure = process(raw.stdout + "The API provider is not able to authenticate you. Check your API key.\n");
    expect(failure.success).toBe(false);
    expect(failure.exitCode).toBe(1);
  } finally { adapter.cleanupRunSync(context); }
  expect(existsSync(path)).toBe(false);
});

test("aider recognizes installed provider diagnostics including wrapped output", () => {
  for (const message of ["The API provider is not able to authenticate you. Check your API key.",
    "The API provider has rate limited you. Try again later or check your quotas.",
    "Insufficient credits with the API provider. Please add credits.", "litellm.BadRequestError: invalid model"]) {
    expect(aiderProviderFailure(message.replaceAll(" ", "\n"))).not.toBeNull();
  }
  expect(aiderProviderFailure("Aider v0.86.2\nMain model: test")).toBeNull();
});

test("aider distinguishes quoted diagnostics, recovered retries, and terminal failure with partial text", () => {
  const message = "The API provider has rate limited you. Try again later or check your quotas.";
  expect(aiderHistoryProviderFailure(`\n#### q\n\n${message}\n`)).toBeNull();
  expect(aiderHistoryProviderFailure(`> ${message}\nPartial answer\n`)).toBe(message);
  expect(aiderHistoryProviderFailure(`> ${message}\n> Retrying in 0.2 seconds...\nAnswer\n`)).toBeNull();
  expect(aiderHistoryProviderFailure(`> ${message}\n> Retrying in 0.2 seconds...\n> ${message}\nPartial\n`)).toBe(message);
});

test("doctor reports empty alias mappings", () => {
  const config = loadConfig(join(makeRoot(), "absent.yaml"));
  expect(aliasRow({ ...config, models: { worker: {} } })).toMatchObject({ state: "invalid", severity: "broken" });
  expect(aliasRow({ ...config, models: { worker: {} } }).detail).toContain("worker: maps no harness");
});

test.each([...AGENT_IDS])("%s cannot certify banner/error stdout as an assistant answer", agent => {
  const request = { agent, prompt: "p" };
  const raw = { stdout: "Harness banner\nAuthentication failed\n", stderr: "", exitCode: 0, success: true };
  const processed = getAdapter(agent, { PATH: "" }).processRunResult(raw, request);
  expect(enforceNonEmptyResult(processed, request, 0).success).toBe(false);
});

test("Cursor plain runs propagate structured errors even when error text looks like an answer", () => {
  const adapter = getAdapter("cursor", { PATH: "" });
  const request = { agent: "cursor" as const, prompt: "p" };
  for (const flags of [{ is_error: true, subtype: "success" }, { is_error: false, subtype: "error" }]) {
    const raw = { stdout: JSON.stringify({ type: "result", result: "Authentication required", ...flags }),
      stderr: "", success: true, exitCode: 0 };
    expect(enforceNonEmptyResult(adapter.processRunResult(raw, request), request, 0).success).toBe(false);
  }
});

test("Kimi's legacy bullet marker alone is not an assistant answer", () => {
  const request = { agent: "kimi" as const, prompt: "p" };
  const raw = { stdout: "• \n", stderr: "", exitCode: 0, success: true };
  const processed = getAdapter("kimi", { PATH: "" }).processRunResult(raw, request);
  expect(enforceNonEmptyResult(processed, request, 0).success).toBe(false);
});

test("quota refusals and warnings name the mapped usagemux client", () => {
  const policy = { ...POLICY, spendsFrom: { opencode: "claude" } };
  const blocked = gateOutcomeOnResult("opencode", result({ windows: [window({ kind: "primary", remainingPercent: 0 })] }), policy);
  expect(blocked.refusal).toContain("opencode (usagemux client claude)");
  const warned = gateOutcomeOnResult("opencode", result({ status: "error", message: "unavailable" }), policy);
  expect(warned.notes[0]).toContain("opencode (usagemux client claude)");
});
