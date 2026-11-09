// The probes the matrix grew in the 2.0.0 audit: I (the model-alias and
// effort flags, D7) and H2 (the loopback override twin of probe H, D9 —
// the proof is the fake provider's request log). Probe J (the sandbox
// policy flags, D7) has its own file, tests/live-gate-sandbox-probe.test.ts.
// The loopback pieces live in scripts/live-gate/loopback.ts; the probe
// bodies in scripts/live-gate/run.ts.
import { afterAll, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { getDefaultConfig } from "../src/config.js";
import type { CodemuxConfig } from "../src/types.js";
import {
  LOOPBACK_TIMEOUT_SECONDS,
  ProbeRunner,
  modelAliasFor,
  modelNamesTarget,
  parseOptions,
  runProbes,
  verifyAliasEnvelope,
} from "../scripts/live-gate.js";
import {
  FAKE_PROVIDER_BODY_LIMIT,
  startFakeProvider,
  startReachableListener,
  verifyOverrideLog,
} from "../scripts/live-gate/loopback.js";
import { cleanupLoggedInHomes, factsFor, fixtureDirectory, loggedInEnv } from "./helpers/live-gate.js";

afterAll(cleanupLoggedInHomes);

/** A minimal valid result envelope for one harness, with the model under
 * test. Every capture's verifier checks the envelope's codemux.agent
 * against the probed harness, so the fake provider's answer must name
 * the harness the probe ran (droid reports result JSON since the 2.0.0
 * parity pass). */
const aliasEnvelope = (agent: string, model: string | null): string =>
  `${JSON.stringify({
    result: "OK\n",
    codemux: {
      agent, model, served_model: null, labels: null,
      usage: { input_tokens: null, output_tokens: null, cached_input_tokens: null, total_tokens: null, cost_usd: null },
      session_id: null, recording: null, failure_code: null,
    },
  })}\n`;

const configWith = (models: CodemuxConfig["models"]): CodemuxConfig => ({ ...getDefaultConfig(), models });

test("modelAliasFor prefers worker, falls back to the first mapped alias, and refuses the unmapped", () => {
  // Audit D7: the operator's tier aliases (worker, clerk, judge) name the
  // alias the probe should carry; without them the first alias mapping the
  // harness stands in, and a harness no alias maps is a SKIP, never a
  // `-m` on a name nobody resolves.
  expect(modelAliasFor("claude", configWith({ worker: { claude: "claude-worker" }, sonnet: { claude: "sonnet" } })))
    .toEqual({ alias: "worker", model: "claude-worker" });
  expect(modelAliasFor("claude", configWith({ clerk: { claude: "clerk-model" }, sonnet: { claude: "sonnet" } })))
    .toEqual({ alias: "clerk", model: "clerk-model" });
  expect(modelAliasFor("claude", getDefaultConfig())).toEqual({ alias: "sonnet", model: "sonnet" });
  expect(modelAliasFor("claude", configWith({ worker: { zai: "zai-worker" } }))).toBeNull();
});

test("probe I carries -m alone, I2 carries --effort alone, and I verifies the alias target where the harness reports result JSON (audit D7)", async () => {
  const fixture = loggedInEnv();
  const reportDirectory = fixtureDirectory();
  const commands: { agent: string; command: string[] }[] = [];
  // One verifier per harness: every result-JSON harness (claude and
  // droid) now goes through capture, and the last one in would win a
  // single variable — the claude check would then judge droid's
  // envelope and fault the agent field (the alias would go unproven).
  const verifiers = new Map<string, (captured: { exit: number | null; stdout: string }) => string | null>();
  try {
    const rows = await runProbes(
      [factsFor("claude"), factsFor("droid"), factsFor("agy")],
      parseOptions(["--probe", "I,I2", "--timeout", "10"], ""),
      {
        async run(command) {
          commands.push({ agent: command[3]!, command });
          return { status: "PASS", seconds: 0, stderr: "" };
        },
        async capture(command, verify) {
          commands.push({ agent: command[3]!, command });
          verifiers.set(command[3]!, verify);
          return { status: "PASS", seconds: 0, stderr: "" };
        },
      },
      reportDirectory, fixture.env,
      configWith({ worker: { claude: "claude-worker", droid: "droid-worker" } }));
    // claude and droid both report result JSON now (droid gained its
    // envelope in the 2.0.0 parity pass): each envelope must name its
    // own harness and the alias target.
    const claudeI = commands.find((call) => call.agent === "claude" && call.command.includes("-m"))!.command;
    expect(claudeI).toContain("--result-json");
    expect(claudeI[claudeI.indexOf("-m") + 1]).toBe("worker");
    expect(claudeI).not.toContain("--effort");
    expect(verifiers.get("claude")!({ exit: 0, stdout: aliasEnvelope("claude", "claude-worker") })).toBeNull();
    expect(verifiers.get("claude")!({ exit: 0, stdout: aliasEnvelope("claude", "some-other-model") }))
      .toContain('codemux.model is "some-other-model", not the alias\'s target "claude-worker"');
    // The envelope's agent field is judged too: a droid envelope handed
    // to claude's verifier is refused, so the alias proof cannot be
    // satisfied by the wrong harness's fixture.
    expect(verifiers.get("claude")!({ exit: 0, stdout: aliasEnvelope("droid", "claude-worker") }))
      .toContain('codemux.agent is "droid", not the probed claude');
    const droidI = commands.find((call) => call.agent === "droid" && call.command.includes("-m"))!.command;
    expect(droidI).toContain("--result-json");
    expect(droidI[droidI.indexOf("-m") + 1]).toBe("worker");
    expect(droidI).not.toContain("--effort");
    expect(verifiers.get("droid")!({ exit: 0, stdout: aliasEnvelope("droid", "droid-worker") })).toBeNull();
    // I2 carries --effort low alone, on the effort-declaring harnesses;
    // agy declares effort, so its I2 runs even though no alias maps it.
    for (const agent of ["claude", "droid", "agy"]) {
      const effort = commands.find((call) => call.agent === agent && call.command.includes("--effort"))!.command;
      expect(effort[effort.indexOf("--effort") + 1]).toBe("low");
      expect(effort).not.toContain("-m");
      expect(effort).not.toContain("--result-json");
    }
    // agy declares the model pair but no alias maps it: I SKIPs, nothing
    // spawned with -m; I2 still ran above.
    expect(commands.some((call) => call.agent === "agy" && call.command.includes("-m"))).toBe(false);
    expect(rows[2]!.results.I).toMatchObject({ status: "SKIP", note: "no model alias is configured for agy" });
    expect(rows[2]!.results.I2).toMatchObject({ status: "PASS" });
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("an alias target that is the harness's own short name is named by the full served id", () => {
  // Live gate, 2026-11-06: the worker alias maps claude to `sonnet`, the
  // provider reported `claude-sonnet-5-5`, and the exact comparison failed
  // a correct run. Whole hyphen-separated words decide; another family
  // still fails.
  expect(modelNamesTarget("claude-sonnet-5-5", "sonnet")).toBe(true);
  expect(modelNamesTarget("claude-sonnet-5-5-20261001", "claude-sonnet-5-5")).toBe(true);
  expect(modelNamesTarget("glm-5.3", "glm-5.3")).toBe(true);
  expect(modelNamesTarget("claude-opus-5-5", "sonnet")).toBe(false);
  expect(modelNamesTarget("claude-sonnets-5", "sonnet")).toBe(false);
  expect(modelNamesTarget("gpt-6-astra", "gpt-6-luna")).toBe(false);
  expect(modelNamesTarget("claude-sonnet-5-5", "")).toBe(false);
  // Only a bare family word may match inside an id (review round 180): a
  // target with a version in it names one model, and a number names none.
  expect(modelNamesTarget("claude-sonnet-5-high", "claude-sonnet-5")).toBe(false);
  expect(modelNamesTarget("claude-sonnet-5-5", "claude-sonnet-5")).toBe(false);
  expect(modelNamesTarget("claude-opus-5-5", "5")).toBe(false);
  expect(modelNamesTarget("gpt-6-astra", "gpt-6")).toBe(false);
  expect(modelNamesTarget("claude-sonnet-5-5-2026100", "claude-sonnet-5-5")).toBe(false);
  expect(modelNamesTarget("-20261001", "")).toBe(false);
  // The family word must be the id's only word beside the vendor and the
  // numbers (review round 184): a variant word names no model, and an id
  // with a variant is not the plain family.
  expect(modelNamesTarget("claude-sonnet-5-high", "high")).toBe(false);
  expect(modelNamesTarget("claude-sonnet-5-high", "sonnet")).toBe(false);
  expect(modelNamesTarget("claude-sonnet-5-5", "claude")).toBe(false);
  expect(modelNamesTarget("sonnet", "sonnet")).toBe(true);
  expect(modelNamesTarget("claude-3-5-sonnet-20241022", "sonnet")).toBe(true);
  expect(modelNamesTarget("claude-fable-5-1", "fable")).toBe(true);
  expect(verifyAliasEnvelope(aliasEnvelope("claude", "claude-sonnet-5-5"), "claude", "sonnet")).toBeNull();
  expect(verifyAliasEnvelope(aliasEnvelope("claude", "claude-opus-5-5"), "claude", "sonnet"))
    .toContain('codemux.model is "claude-opus-5-5", not the alias\'s target "sonnet"');
});

test("verifyAliasEnvelope keeps probe C's checks and adds the model assertion", () => {
  expect(verifyAliasEnvelope(aliasEnvelope("claude", "claude-worker"), "claude", "claude-worker")).toBeNull();
  // A non-JSON stdout fails probe C's checks before the model is read.
  expect(verifyAliasEnvelope("OK\n", "claude", "claude-worker")).toContain("does not parse");
  expect(verifyAliasEnvelope(aliasEnvelope("claude", null), "claude", "claude-worker"))
    .toContain('codemux.model is null, not the alias\'s target "claude-worker"');
});

test("the fake provider answers the override key and refuses every other request (audit D9)", async () => {
  const provider = await startFakeProvider({ apiKey: "loopback-key" });
  try {
    const request = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${provider.port}/messages`, {
        method: "POST", headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ model: "loopback-probe-model" }),
      });
    const refused = await request({ authorization: "Bearer operator-key" });
    expect(refused.status).toBe(401);
    expect(await refused.text()).toContain("refuses requests without the override key");
    const bare = await request({});
    expect(bare.status).toBe(401);
    // Both spellings of the override key answer 200.
    for (const headers of [["authorization", "Bearer loopback-key"], ["x-api-key", "loopback-key"]] as const) {
      const served = await request({ [headers[0]]: headers[1] });
      expect(served.status).toBe(200);
    }
    expect(provider.requests()).toEqual([
      { method: "POST", path: "/messages", auth: "other", model: "loopback-probe-model" },
      { method: "POST", path: "/messages", auth: "none", model: "loopback-probe-model" },
      { method: "POST", path: "/messages", auth: "override", model: "loopback-probe-model" },
      { method: "POST", path: "/messages", auth: "override", model: "loopback-probe-model" },
    ]);
  } finally {
    await provider.close();
  }
});

test("verifyOverrideLog fails a run that never routed, leaked a credential, or missed the model", () => {
  const record = (auth: "override" | "other" | "none", model: string | null) => ({ path: "/", auth, model });
  expect(verifyOverrideLog([], "loopback-probe-model"))
    .toBe("the harness sent no request to the loopback provider; the override did not route the run");
  expect(verifyOverrideLog([record("override", "loopback-probe-model"), record("other", "m")], "loopback-probe-model"))
    .toBe("1 of 2 request(s) carried a credential other than the override key (? /); the override did not isolate the run");
  // The leak line names the request that carried the foreign credential
  // (review round 182): that is the request an operator has to find.
  expect(verifyOverrideLog([
    record("override", "loopback-probe-model"),
    { method: "POST", path: "/v1/messages?beta=true", auth: "other" as const, model: "loopback-probe-model" },
  ], "loopback-probe-model"))
    .toBe("1 of 2 request(s) carried a credential other than the override key (POST /v1/messages); the override did not isolate the run");
  expect(verifyOverrideLog([record("none", "m")], "loopback-probe-model"))
    .toBe("none of the 1 request(s) carried a credential (? /); the override key never reached the provider");
  // The failure names which requests they were, method and path without
  // the query, each pair once (live gate, 2026-11-06: the line gave a
  // count and nothing to tell a harness probe from a model request).
  const bare = (method: string, path: string) => ({ method, path, auth: "none" as const, model: null });
  expect(verifyOverrideLog([bare("HEAD", "/"), bare("HEAD", "/"), bare("POST", "/v1/messages?beta=true")], "loopback-probe-model"))
    .toBe("none of the 3 request(s) carried a credential (HEAD /, POST /v1/messages); the override key never reached the provider");
  expect(verifyOverrideLog(["/a", "/b", "/c", "/d", "/e"].map((path) => bare("GET", path)), "loopback-probe-model"))
    .toContain("(GET /a, GET /b, GET /c, GET /d, ...)");
  // A request with no credential leaks none: Claude Code's unauthenticated
  // connectivity check beside its keyed model requests passes (live gate,
  // 2026-11-06, where `HEAD /api/hello` failed a correct run).
  expect(verifyOverrideLog([
    bare("HEAD", "/api/hello"), record("override", "loopback-probe-model"), record("override", "loopback-probe-model"),
  ], "loopback-probe-model")).toBeNull();
  // The model must be named by a request that carried the override key: a
  // bare request naming it proves nothing about the keyed ones.
  expect(verifyOverrideLog([
    { ...bare("POST", "/v1/messages"), model: "loopback-probe-model" }, record("override", "other-model"),
  ], "loopback-probe-model"))
    .toBe('no request carrying the override key named the override model "loopback-probe-model"; those requests carried: "other-model"');
  expect(verifyOverrideLog([record("override", "other-model")], "loopback-probe-model"))
    .toBe('no request carrying the override key named the override model "loopback-probe-model"; those requests carried: "other-model"');
  expect(verifyOverrideLog([record("override", null)], "loopback-probe-model"))
    .toContain("those requests carried: null");
  expect(verifyOverrideLog([record("override", "loopback-probe-model")], "loopback-probe-model")).toBeNull();
});

/** A stub codemux whose run talks to the provider override environment it
 * received: the loopback twin of a harness honoring the override. */
const loopbackStub = (behavior: "honor" | "ignore" | "wrong-model" | "silent"): string => `#!${process.execPath}
const base = process.env.CODEMUX_CLAUDE_PROVIDER_BASE_URL;
const key = process.env.CODEMUX_CLAUDE_PROVIDER_API_KEY;
const model = process.env.CODEMUX_CLAUDE_PROVIDER_MODEL;
if (base === undefined || key === undefined || model === undefined) {
  console.error("the override environment never reached the run");
  process.exit(3);
}
${behavior === "silent" ? 'process.stdout.write("no request at all"); process.exit(0);' : ""}
const response = await fetch(base + "/messages", {
  method: "POST",
  headers: {
    authorization: "Bearer " + ${behavior === "ignore" ? '"operator-key"' : "key"},
    "content-type": "application/json",
  },
  body: JSON.stringify({ model: ${behavior === "wrong-model" ? '"the-default-model"' : "model"} }),
});
process.stdout.write(await response.text());
process.exit(0);
`;

test.each(["honor", "ignore", "wrong-model", "silent"] as const)(
  "probe H2 runs against the loopback provider and judges the request log: %s (audit D9)",
  async (behavior) => {
    const fixture = loggedInEnv();
    const reportDirectory = fixtureDirectory();
    const codemux = join(reportDirectory, "codemux-stub");
    writeFileSync(codemux, loopbackStub(behavior), { mode: 0o700 });
    const commands: string[][] = [];
    try {
      const rows = await runProbes(
        [factsFor("claude")],
        parseOptions(["--probe", "H2", "--codemux", codemux, "--timeout", "10"], ""),
        {
          async run() { throw new Error("probe H2 never runs an exact-output probe"); },
          async capture(command, _verify, _timeout, _prefix, _stdin, extra) {
            commands.push(command);
            // The override environment reaches the child through the
            // runner's env seam, and the run may exit any way it likes:
            // the request log decides.
            expect(extra?.allowAnyExit).toBe(true);
            expect(extra?.env?.CODEMUX_CLAUDE_PROVIDER_BASE_URL)
              .toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
            expect(extra?.env?.CODEMUX_CLAUDE_PROVIDER_API_KEY).toMatch(/^loopback-[0-9a-f]{32}$/);
            expect(extra?.env?.CODEMUX_CLAUDE_PROVIDER_MODEL).toMatch(/^loopback-probe-[0-9a-f]{12}$/);
            return new ProbeRunner().capture(command, _verify, _timeout, _prefix, _stdin, extra);
          },
        },
        reportDirectory, fixture.env);
      const result = rows[0]!.results.H2!;
      // The override variables ride --pass-env, so a sandboxed child can
      // still see them (the scrubbed environment keeps the named set).
      const passEnv = commands[0]![commands[0]!.indexOf("--pass-env") + 1];
      expect(passEnv).toContain("CODEMUX_CLAUDE_PROVIDER_BASE_URL");
      expect(passEnv).toContain("CODEMUX_CLAUDE_PROVIDER_API_KEY");
      expect(passEnv).toContain("CODEMUX_CLAUDE_PROVIDER_MODEL");
      // The operator's real credentials are scrubbed from the child's
      // environment (review round 45); the override rides --pass-env.
      expect(commands[0]).toContain("--sandbox-scrub-env");
      if (behavior === "honor") {
        expect(result.status).toBe("PASS");
      } else {
        expect(result.status).toBe("FAIL");
        expect(result.stderr).toContain(
          behavior === "silent"
            ? "the harness sent no request to the loopback provider"
            : behavior === "ignore"
              ? "carried a credential other than the override key"
              : "no request carrying the override key named the override model"
        );
      }
    } finally {
      rmSync(reportDirectory, { recursive: true, force: true });
    }
  }
);

test("the fake provider's close resolves while a client holds an unfinished request (review round 43)", async () => {
  const provider = await startFakeProvider({ apiKey: "k" });
  const socket = connect(provider.port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  // A request line and headers that promise a body which never arrives.
  socket.write("POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n");
  const started = performance.now();
  await provider.close();
  expect(performance.now() - started).toBeLessThan(4_000);
  socket.destroy();
});

test("the reachable listener's close resolves while a client holds a connection", async () => {
  const listener = await startReachableListener();
  const socket = connect(listener.port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  const started = performance.now();
  await listener.close();
  expect(performance.now() - started).toBeLessThan(4_000);
  socket.destroy();
});

test("a real credential beside the override key is a leak, recorded as other (review round 44)", async () => {
  const provider = await startFakeProvider({ apiKey: "override-key" });
  try {
    const mixed = await fetch(`http://127.0.0.1:${provider.port}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer override-key", "x-api-key": "operator-real-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "m" }),
    });
    expect(mixed.status).toBe(401);
    const clean = await fetch(`http://127.0.0.1:${provider.port}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer override-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "m" }),
    });
    expect(clean.status).toBe(200);
    expect(provider.requests().map((record) => record.auth)).toEqual(["other", "override"]);
    expect(verifyOverrideLog(provider.requests(), "m")).not.toBeNull();
  } finally {
    await provider.close();
  }
});

test("an oversized body is refused with 413 and recorded without a model", async () => {
  const provider = await startFakeProvider({ apiKey: "override-key" });
  try {
    const response = await fetch(`http://127.0.0.1:${provider.port}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer override-key", "content-type": "application/json" },
      body: "x".repeat(FAKE_PROVIDER_BODY_LIMIT + 1024),
    }).catch(() => null);
    if (response !== null) expect(response.status).toBe(413);
    expect(provider.requests()).toEqual([{ method: "POST", path: "/v1/messages", auth: "override", model: null }]);
  } finally {
    await provider.close();
  }
});

test("probe H2's launch is bounded apart from --timeout: the request log is the proof, not the run's end", async () => {
  // Live gate, 2026-11-06: opencode retried the fake provider's minimal
  // answer for the full 600 s and still passed on the log it had after
  // seconds. The launch and its outer allowance are capped; a shorter
  // --timeout stays as given.
  const fixture = loggedInEnv();
  const reportDirectory = fixtureDirectory();
  const seen: { timeout: string; outer: number }[] = [];
  const stub = {
    async run(): Promise<never> { throw new Error("probe H2 never runs an exact-output probe"); },
    async capture(command: string[], _verify: unknown, outer: number) {
      seen.push({ timeout: command[command.indexOf("--timeout") + 1]!, outer });
      return { status: "PASS" as const, seconds: 0, stderr: "" };
    },
  };
  try {
    await runProbes([factsFor("claude")], parseOptions(["--probe", "H2", "--timeout", "600"], ""), stub, reportDirectory, fixture.env);
    await runProbes([factsFor("claude")], parseOptions(["--probe", "H2", "--timeout", "10"], ""), stub, reportDirectory, fixture.env);
    expect(LOOPBACK_TIMEOUT_SECONDS).toBe(120);
    expect(seen).toEqual([{ timeout: "120", outer: 150 }, { timeout: "10", outer: 40 }]);
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});
