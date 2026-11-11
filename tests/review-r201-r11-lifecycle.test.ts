import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { readRegistry, sessionHoldState, type SessionRecord } from "../src/session/registry.js";
import { populateKimiHermeticSessionHome } from "../src/kimi-hermetic.js";
import { fakePrivateHome } from "./helpers/fake-private-home.js";
import { startAndWait, cleanupSessions, waitFor, of } from "./session-codex-e2e-helpers.js";
import { startSession, cleanups, ID as KIMI_ID } from "./helpers/session-kimi-e2e.js";

afterEach(async () => {
  await cleanupSessions();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function record(path: string): SessionRecord {
  const registry = readRegistry(path);
  if (registry.outcome !== "ok" || !registry.file.sessions[0]) throw new Error("missing fixture record");
  return registry.file.sessions[0];
}

function competingClaim(path: string) {
  const entry = record(path);
  const probe = {
    agent: entry.agent, harnessHome: entry.harness_home, cwd: entry.cwd,
    passEnv: entry.pass_env, playwrightMcp: entry.playwright_mcp, autonomy: entry.autonomy,
    sandboxed: entry.sandboxed, sandboxTrust: entry.sandbox_trust,
    sandboxNoNet: entry.sandbox_no_net, sandboxScrubEnv: entry.sandbox_scrub_env,
    sandboxBlock: entry.sandbox_block, providerBaseUrl: entry.provider_base_url,
    hermetic: entry.hermetic, projectSettings: entry.project_settings,
  };
  // A real second process avoids the registry's same-owner exemption.
  const child = Bun.spawnSync([process.execPath, "-e",
    'import { claimForResume } from "./src/session/registry.ts"; console.log(JSON.stringify(claimForResume(...JSON.parse(process.argv[1]))));',
    JSON.stringify([path, entry.id, probe])], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return JSON.parse(child.stdout.toString());
}

const send = (driver: { handleCallerLine(line: string): void }, value: unknown) => driver.handleCallerLine(JSON.stringify(value));

for (const agent of ["codex", "kimi"] as const) {
  for (const resumed of [false, true]) {
    for (const failures of [0, 1, 2]) {
      test(`${agent} final ${resumed ? "resumed" : "fresh"} home: ${failures} removal failures retain ownership`, async () => {
        const home = fakePrivateHome();
        if (agent === "kimi") populateKimiHermeticSessionHome(home.dir, null);
        const id = agent === "kimi" ? KIMI_ID : "0123456789abcdef";
        if (resumed) { home.settle(id); Object.defineProperty(home, "resumed", { value: true }); }
        const options = { privateHome: home, hermetic: true, final: true };
        const session = agent === "codex"
          ? await startAndWait({ ...options, resumeThreadId: resumed ? id : null })
          : await startSession({ ...options, resumeSessionId: resumed ? id : null, permissionPolicy: "deny" });
        send(session.driver, { type: "user", text: "scenario:basic hello" });
        await waitFor(session.events, of("turn_completed"), "fixture turn");
        const path = session.options.registryPath!;
        const observations: unknown[] = [];
        const original = home.remove.bind(home);
        let attempts = 0;
        const remove = spyOn(home, "remove").mockImplementation(() => {
          attempts++;
          observations.push({ held: sessionHoldState(path, id), claim: competingClaim(path), ended: record(path).ended });
          if (attempts <= failures) throw new Error("synthetic removal failure");
          return original();
        });
        try {
          send(session.driver, { type: "shutdown" });
          expect(await session.code).toBe(failures === 2 ? 1 : 0);
          expect(attempts).toBe(failures === 0 ? 1 : 2);
          for (const observation of observations) expect(observation).toMatchObject({ held: "held", ended: null,
            claim: { outcome: "refused", reason: expect.stringContaining("session_busy") } });
          const ended = session.events.findLast((event) => event.type === "session_ended");
          expect(ended).toMatchObject({ resumable: failures === 2, exit_code: failures === 2 ? 1 : 0 });
          expect(record(path).final).toBe(failures !== 2);
          expect(record(path).ended).not.toBeNull();
          expect(existsSync(home.dir)).toBe(failures === 2);
        } finally { remove.mockRestore(); home.remove(); }
      });
    }
  }
}

test("Kimi final removal waits for an abandoned spawn and its child", async () => {
  const home = fakePrivateHome();
  populateKimiHermeticSessionHome(home.dir, null);
  const session = await startSession({ privateHome: home, final: true, permissionPolicy: "deny" }, {}, 250, 2);
  send(session.driver, { type: "user", text: "scenario:basic first" });
  await waitFor(session.events, of("turn_completed"), "first turn");
  const observations: unknown[] = [];
  const original = home.remove.bind(home);
  const remove = spyOn(home, "remove").mockImplementation(() => {
    observations.push({ spawns: session.order.filter((event) => event === "spawned").length,
      settled: session.order.filter((event) => event === "settled").length,
      held: sessionHoldState(session.options.registryPath!, KIMI_ID) });
    return original();
  });
  try {
    send(session.driver, { type: "user", text: "scenario:basic second" });
    session.driver.handleFatal({ kind: "handler", error: new Error("synthetic shutdown during preflight"), bytes: 0 });
    expect(existsSync(home.dir)).toBe(true);
    expect(await session.code).toBe(1);
    expect(observations).toEqual([{ spawns: 2, settled: 2, held: "held" }]);
    expect(record(session.options.registryPath!).final).toBe(true);
    expect(session.events.findLast((event) => event.type === "session_ended")?.resumable).toBe(false);
  } finally { remove.mockRestore(); home.remove(); }
});
