// The probes the matrix grew in the 2.0.0 audit: I (the model-alias and
// effort flags, D7), J (the sandbox policy flags against a provably
// reachable loopback port, D7), and H2 (the loopback override twin of
// probe H, D9 — the proof is the fake provider's request log). The
// loopback pieces live in scripts/live-gate/loopback.ts; the probe bodies
// in scripts/live-gate/run.ts.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { getDefaultConfig } from "../src/config.js";
import type { CodemuxConfig } from "../src/types.js";
import {
  ProbeRunner,
  modelAliasFor,
  parseOptions,
  runProbes,
  verifyAliasEnvelope,
} from "../scripts/live-gate.js";
import {
  FAKE_PROVIDER_BODY_LIMIT,
  prepareNoNetProbe,
  startFakeProvider,
  startReachableListener,
  verifyOverrideLog,
} from "../scripts/live-gate/loopback.js";
import { cleanupLoggedInHomes, factsFor, fixtureDirectory, loggedInEnv } from "./helpers/live-gate.js";

afterAll(cleanupLoggedInHomes);

/** A minimal valid claude result envelope with the model under test. */
const aliasEnvelope = (model: string | null): string =>
  `${JSON.stringify({
    result: "OK\n",
    codemux: {
      agent: "claude", model, served_model: null, labels: null,
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

test("probe I carries -m and --effort, and verifies the alias target where the harness reports result JSON (audit D7)", async () => {
  const fixture = loggedInEnv();
  const reportDirectory = fixtureDirectory();
  const commands: { agent: string; command: string[] }[] = [];
  let claudeVerifier: ((captured: { exit: number | null; stdout: string }) => string | null) | undefined;
  try {
    const rows = await runProbes(
      [factsFor("claude"), factsFor("droid"), factsFor("agy")],
      parseOptions(["--probe", "I", "--timeout", "10"], ""),
      {
        async run(command) {
          commands.push({ agent: command[3]!, command });
          return { status: "PASS", seconds: 0, stderr: "" };
        },
        async capture(command, verify) {
          commands.push({ agent: command[3]!, command });
          claudeVerifier = verify;
          return { status: "PASS", seconds: 0, stderr: "" };
        },
      },
      reportDirectory, fixture.env,
      configWith({ worker: { claude: "claude-worker", droid: "droid-worker" } }));
    // claude reports result JSON: the envelope must name the alias target.
    const claude = commands.find((call) => call.agent === "claude")!.command;
    expect(claude).toContain("--result-json");
    expect(claude[claude.indexOf("-m") + 1]).toBe("worker");
    expect(claude[claude.indexOf("--effort") + 1]).toBe("low");
    expect(claudeVerifier!({ exit: 0, stdout: aliasEnvelope("claude-worker") })).toBeNull();
    expect(claudeVerifier!({ exit: 0, stdout: aliasEnvelope("some-other-model") }))
      .toContain('codemux.model is "some-other-model", not the alias\'s target "claude-worker"');
    // droid declares model and effort but no result JSON: exact output, no
    // --result-json flag.
    const droid = commands.find((call) => call.agent === "droid")!.command;
    expect(droid).not.toContain("--result-json");
    expect(droid[droid.indexOf("-m") + 1]).toBe("worker");
    expect(droid[droid.indexOf("--effort") + 1]).toBe("low");
    // agy declares the pair but no alias maps it: SKIP, nothing spawned.
    expect(commands.some((call) => call.agent === "agy")).toBe(false);
    expect(rows[2]!.results.I).toMatchObject({ status: "SKIP", note: "no model alias is configured for agy" });
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("verifyAliasEnvelope keeps probe C's checks and adds the model assertion", () => {
  expect(verifyAliasEnvelope(aliasEnvelope("claude-worker"), "claude", "claude-worker")).toBeNull();
  // A non-JSON stdout fails probe C's checks before the model is read.
  expect(verifyAliasEnvelope("OK\n", "claude", "claude-worker")).toContain("does not parse");
  expect(verifyAliasEnvelope(aliasEnvelope(null), "claude", "claude-worker"))
    .toContain('codemux.model is null, not the alias\'s target "claude-worker"');
});

test("probe J sends the sandbox policy flags together and proves the blocked port (audit D7)", async () => {
  const fixture = loggedInEnv();
  const reportDirectory = fixtureDirectory();
  const commands: string[][] = [];
  try {
    const rows = await runProbes([factsFor("kimi")], parseOptions(["--probe", "J", "--timeout", "10"], ""), {
      async run(command, expected) {
        commands.push(command);
        expect(expected).toBe("BLOCKED");
        // The script the harness runs sits in the probe directory, executable
        // by its owner only — read here, before the cleanup removes a passed
        // probe's directory.
        const cwd = command[command.indexOf("--cwd") + 1]!;
        expect(readdirSync(cwd)).toEqual(["nonet.sh"]);
        expect(statSync(join(cwd, "nonet.sh")).mode & 0o777).toBe(0o700);
        return { status: "PASS", seconds: 0, stderr: "" };
      },
      async capture() { throw new Error("probe J never captures"); },
    }, reportDirectory, fixture.env);
    const command = commands[0]!;
    // The three policy flags ride one launch: the release contract runs
    // them together, so the probe does too.
    expect(command).toContain("--sandbox-no-net");
    expect(command).toContain("--sandbox-scrub-env");
    expect(command[command.indexOf("--sandbox-trust") + 1]).toBe("standard");
    expect(command[command.indexOf("--auto") + 1]).toBe("medium");
    expect(rows[0]!.results.J).toMatchObject({ status: "PASS" });
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("the no-net script answers OPEN, BLOCKED, and NO-CURL from the curl outcome", async () => {
  // The script is a pure read of curl's outcome: exit 0 → OPEN (the
  // address was reachable), any failure → BLOCKED, no curl on PATH →
  // NO-CURL. Each branch is driven by a stub curl standing in for the
  // production outcomes, because a suite running inside a network-
  // restricted sandbox has no loopback curl to observe — the test cannot
  // depend on one. The listener itself still serves: the fetch proves the
  // address the script targets is reachable outside any sandbox.
  const listener = await startReachableListener();
  const directory = fixtureDirectory();
  try {
    const probe = prepareNoNetProbe(directory, listener.port);
    expect(probe.expected).toBe("BLOCKED");
    expect(probe.prompt).toContain("sh nonet.sh");
    expect(await (await fetch(`http://127.0.0.1:${listener.port}/`)).text()).toBe("reachable\n");
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const stubCurl = (outcome: string) =>
      writeFileSync(join(bin, "curl"), `#!/bin/sh\n${outcome}\n`, { mode: 0o700 });
    const run = () =>
      Bun.spawnSync(["/bin/sh", join(directory, "nonet.sh")], { env: { PATH: bin } }).stdout.toString();
    stubCurl("exit 0"); // curl reached the listener
    expect(run()).toBe("OPEN");
    stubCurl("exit 7"); // connection refused or blocked
    expect(run()).toBe("BLOCKED");
    rmSync(join(bin, "curl"));
    expect(run()).toBe("NO-CURL");
  } finally {
    await listener.close();
    rmSync(directory, { recursive: true, force: true });
  }
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
      { path: "/messages", auth: "other", model: "loopback-probe-model" },
      { path: "/messages", auth: "none", model: "loopback-probe-model" },
      { path: "/messages", auth: "override", model: "loopback-probe-model" },
      { path: "/messages", auth: "override", model: "loopback-probe-model" },
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
    .toBe("1 of 2 request(s) carried a credential other than the override key; the override did not isolate the run");
  expect(verifyOverrideLog([record("none", "m")], "loopback-probe-model"))
    .toBe("1 of 1 request(s) carried no credential header; the override key never reached the provider");
  expect(verifyOverrideLog([record("override", "other-model")], "loopback-probe-model"))
    .toBe('no request named the override model "loopback-probe-model"; the requests carried: "other-model"');
  expect(verifyOverrideLog([record("override", null)], "loopback-probe-model"))
    .toContain("the requests carried: null");
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
              : "no request named the override model"
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
    expect(provider.requests()).toEqual([{ path: "/v1/messages", auth: "override", model: null }]);
  } finally {
    await provider.close();
  }
});
