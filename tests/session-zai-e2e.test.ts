import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeSessionDriver, type SessionDriverOptions } from "../src/session/driver.js";
import { SessionProcess } from "../src/session/process.js";
import { claimForResume, lookupForResume, readRegistry } from "../src/session/registry.js";
import { buildClaudeSessionCommand } from "../src/session/claude-session.js";

// The zai sibling of the former tests/session-e2e.test.ts (audit finding
// 10): zai is
// not a second harness but the same `claude` binary pointed at the Z.AI
// endpoint through the adapter's environment (src/adapters/zai.ts,
// src/session/zai-session.ts), so the SAME fake-claude-session.ts rig
// drives it. What differs at the driver level is the identity — the
// session_started/registry `agent` is "zai" — and the launch environment;
// everything else (turns, permissions, resume) runs the shared
// claude-family code, which this file proves end to end for the zai
// spelling instead of trusting the claude tests to cover it.
const FAKE = fileURLToPath(new URL("./fixtures/live/fake-claude-session.ts", import.meta.url));

// The gateway identity the zai adapter injects (claudeGatewayEnv against
// ZAI_BASE_URL): the endpoint rides ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN,
// never the command line, and ZAI_API_KEY itself never reaches the child
// (the adapter's getEnvOmissions drops it). The fake records exactly these
// in env.jsonl, so the assertions below pin the transport identity.
const ZAI_ENV: Record<string, string> = {
  ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
  ANTHROPIC_AUTH_TOKEN: "zai-e2e-token",
};

type Event = Record<string, any>;

interface Session {
  driver: ClaudeSessionDriver;
  proc: SessionProcess;
  events: Event[];
  options: SessionDriverOptions;
  stateDir: string;
  code: Promise<number>;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

let root: string | null = null;
function workRoot(): string {
  if (root === null) root = mkdtempSync(join(tmpdir(), "codemux-session-zai-e2e-"));
  return root;
}

/** One zai driver over the fake harness. Without `harnessArgs` the child
 * gets the REAL zai session argv (buildClaudeSessionCommand with agent
 * "zai"), so argv.jsonl pins what a zai session actually spawns; the
 * adapter's endpoint identity rides the environment either way. */
async function startSession(
  overrides: Partial<SessionDriverOptions> = {},
  harnessArgs?: string[]
): Promise<Session> {
  const dir = mkdtempSync(join(workRoot(), "s-"));
  const workDir = join(dir, "work");
  const stateDir = join(dir, "state");
  const registryDir = join(dir, "registry");
  mkdirSync(workDir);
  mkdirSync(stateDir);
  mkdirSync(registryDir, { mode: 0o700 });
  const sessionId = crypto.randomUUID();
  const events: Event[] = [];
  const options: SessionDriverOptions = {
    agent: "zai",
    sessionId,
    autonomy: "high",
    cwd: workDir,
    sandboxed: false,
    sandboxTrust: "standard",
    sandboxNoNet: false,
    sandboxScrubEnv: false,
    passEnv: [],
    playwrightMcp: false,
    authorPrefix: true,
    permissionTimeoutMs: 300_000,
    turnTimeoutMs: null,
    sessionTimeoutMs: null,
    registryPath: join(registryDir, "live-sessions.json"),
    harnessHome: join(dir, "home"),
    providerBaseUrl: null,
    sink: (line) => {
      events.push(JSON.parse(line) as Event);
    },
    ...overrides,
  };
  const driver = new ClaudeSessionDriver(options);
  const args =
    harnessArgs ??
    buildClaudeSessionCommand({
      agent: "zai",
      pathEnv: process.env.PATH ?? "",
      sessionId: options.sessionId,
      autonomy: options.autonomy,
      cwd: options.cwd,
    }).argv.slice(1);
  // Spawn the fake the way the real builder spawns the harness: the
  // session-id flag is what the driver's grammar check expects it to echo.
  const proc = new SessionProcess({
    command: ["bun", FAKE, ...args],
    cwd: options.cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      FAKE_STATE_DIR: stateDir,
      FAKE_CWD: options.cwd,
      HOME: dir,
      ...ZAI_ENV,
    },
    onLine: (line) => driver.handleHarnessLine(line),
    onFatal: (fatal) => driver.handleFatal(fatal),
    graceMs: 500,
  });
  driver.attach(proc);
  const code = driver.run();
  cleanups.push(async () => {
    driver.dispose();
    proc.requestStop();
    await proc.settled;
  });
  return { driver, proc, events, options, stateDir, code };
}

/** What the fake harness recorded, re-read so late appends are visible. */
function fakeRecord(session: Session, name: string): unknown[] {
  const path = join(session.stateDir, name);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

/** Wait until the event stream satisfies `want`, or fail with what came. */
async function waitFor<T>(
  events: Event[],
  want: (events: Event[]) => T | undefined,
  label: string,
  timeoutMs = 8_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = want(events);
    if (found !== undefined) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${label}; saw: ${events.map((event) => event.type).join(",")}`
      );
    }
    await Bun.sleep(10);
  }
}

const of = (type: string) => (events: Event[]) =>
  events.find((event) => event.type === type);

const send = (driver: ClaudeSessionDriver, message: unknown): void => {
  driver.handleCallerLine(JSON.stringify(message));
};

describe("zai session driver e2e", () => {
  test("session start, one turn with the reply, and shutdown carry the zai identity", async () => {
    const session = await startSession();
    // The per-turn init means the first user line is what produces
    // session_started, exactly as on the claude path.
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe(session.options.sessionId);
    // The one field that differs from a claude session: the identity.
    expect(started.agent).toBe("zai");
    expect(started.autonomy).toBe("high");
    expect(started.cwd).toBe(session.options.cwd);
    expect(started.protocol).toBe("codemux-live-session/1");
    // A session names no model unless -m gave one (the run path's always
    // `--model opus` default is run-only), so the announcement carries
    // null and the argv below carries no --model.
    expect(started.model).toBeNull();

    const turn = await waitFor(session.events, of("turn_started"), "turn_started");
    expect(turn.turn_id).toBe("t1");
    const echo = await waitFor(session.events, of("user_message"), "user_message");
    expect(echo.text).toBe("scenario:basic hello");
    expect(echo.input_seq).toBe(1);
    const delta = await waitFor(session.events, of("assistant_delta"), "assistant_delta");
    expect(delta.delta).toBe("Hel");
    const message = await waitFor(session.events, of("assistant_message"), "assistant_message");
    expect(message.text).toBe("Done.");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    expect(completed.turn_id).toBe("t1");
    expect(completed.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cached_input_tokens: 3,
      total_tokens: 18,
      cost_usd: null,
    });

    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.resumable).toBe(true);
    expect(await session.code).toBe(0);

    // The registry entry names zai against the shared claude home — the
    // store is one, the identity is not (§4.8).
    const read = readRegistry(session.options.registryPath as string);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") {
      const entry = read.file.sessions.find((record) => record.id === started.session_id);
      expect(entry?.agent).toBe("zai");
      expect(entry?.ended).not.toBe(null);
    }

    // The Z.AI identity rode the adapter's environment, never the argv:
    // the fake saw the endpoint and the token, never the raw key.
    const env = fakeRecord(session, "env.jsonl") as Array<Record<string, unknown>>;
    expect(env[env.length - 1]?.anthropic_base_url).toBe("https://api.z.ai/api/anthropic");
    expect(env[env.length - 1]?.anthropic_auth_token).toBe(true);
    expect(env[env.length - 1]?.zai_api_key_present).toBe(false);
    // The argv is the claude-family one verbatim: the same `claude`
    // binary (no zai executable exists), the session flags, and no
    // endpoint, credential, or model on the command line.
    const built = buildClaudeSessionCommand({
      agent: "zai",
      pathEnv: process.env.PATH ?? "",
      sessionId: session.options.sessionId,
      autonomy: session.options.autonomy,
      cwd: session.options.cwd,
    });
    expect(built.argv[0]).toBe("claude");
    const spawned = fakeRecord(session, "argv.jsonl") as Array<{ args: string[] }>;
    // The fake records its own argv after the script path, so the binary
    // name never reaches it: what it saw is the flags the builder emits.
    expect(spawned[0]?.args).toEqual(built.argv.slice(1));
    expect(built.argv.join(" ")).not.toContain("z.ai");
    expect(built.argv).not.toContain("--model");
  }, 30_000);

  test("a permission request is answered and the turn continues", async () => {
    const session = await startSession({ permissionTimeoutMs: 60_000 });
    send(session.driver, { type: "user", text: "scenario:ask bash please" });
    await waitFor(session.events, of("session_started"), "session_started");
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    expect(request.tool).toBe("Bash");
    expect(request.input).toEqual({ command: "echo hi", description: "say hi" });
    send(session.driver, {
      type: "permission_decision",
      request_id: request.request_id,
      decision: "allow",
      updated_input: { command: "echo rewritten" },
    });
    const resolved = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "permission_resolved" && event.resolution === "allow"),
      "permission_resolved allow"
    );
    expect(resolved.request_id).toBe(request.request_id);
    // The turn continues past the answer: the tool ran with the
    // substituted input and the turn completed.
    const result = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "tool_result" && event.output === "allowed:echo rewritten"),
      "tool_result with the substituted command"
    );
    expect(result.is_error).toBe(false);
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    expect(completed.turn_id).toBe("t1");
    // The harness saw the substituted input, not the requested one.
    const responses = fakeRecord(session, "responses.jsonl") as Array<{
      request_id: string;
      behavior: string;
      updatedInput: Record<string, unknown> | null;
      message: string | null;
    }>;
    expect(responses[responses.length - 1]).toEqual({
      request_id: "toolu_ask_1",
      behavior: "allow",
      updatedInput: { command: "echo rewritten" },
      message: expect.any(String),
    });
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  }, 30_000);

  test("a closed session resumes by id, and only through zai", async () => {
    // The shared-home replay hazard (§4.8, round 17): a zai session's
    // transcript lives under the same ~/.claude a claude session's does,
    // so the registry's agent match — not a separate path — is what stops
    // a claude resume from replaying it to the Z.AI endpoint. Pinned here
    // at the seam the CLI resume runs through, then the real zai resume.
    const created = await startSession();
    send(created.driver, { type: "user", text: "scenario:basic first" });
    await waitFor(created.events, of("session_started"), "session_started");
    await waitFor(created.events, of("turn_completed"), "turn_completed");
    send(created.driver, { type: "shutdown" });
    await waitFor(created.events, of("session_ended"), "session_ended");
    expect(await created.code).toBe(0);

    const id = created.options.sessionId;
    const probe = {
      agent: "zai",
      harnessHome: created.options.harnessHome,
      autonomy: created.options.autonomy,
      sandboxed: false,
      sandboxTrust: "standard" as const,
      sandboxNoNet: false,
      sandboxScrubEnv: false,
      sandboxBlock: [],
      cwd: created.options.cwd,
      passEnv: [],
      playwrightMcp: false,
      providerBaseUrl: null,
      hermetic: false,
      projectSettings: false,
    };
    // The same session through the claude agent is refused — the record
    // names zai, and the shared home never makes it a claude session.
    const crossAgent = lookupForResume(created.options.registryPath as string, id, {
      ...probe,
      agent: "claude",
    });
    expect(crossAgent.outcome).toBe("refused");
    if (crossAgent.outcome === "refused") {
      expect(crossAgent.reason).toContain("belongs to agent zai, not claude");
    }
    // Through zai the claim succeeds and the resume runs.
    const claim = claimForResume(created.options.registryPath as string, id, probe);
    expect(claim.outcome).toBe("ok");

    const argv = buildClaudeSessionCommand({
      agent: "zai",
      pathEnv: process.env.PATH ?? "",
      resumeId: id,
      autonomy: probe.autonomy,
      cwd: created.options.cwd,
    }).argv;
    const resumed = await startSession(
      {
        sessionId: id,
        autonomy: probe.autonomy,
        cwd: created.options.cwd,
        registryPath: created.options.registryPath,
        harnessHome: created.options.harnessHome,
        permissionTimeoutMs: 60_000,
      },
      argv.slice(1)
    );
    resumed.driver.adoptResumeClaim();
    send(resumed.driver, { type: "user", text: "scenario:basic back" });
    const started = await waitFor(resumed.events, of("session_started"), "resumed session_started");
    // The resumed session is still a zai session under the same id.
    expect(started.agent).toBe("zai");
    expect(started.session_id).toBe(id);
    const completed = await waitFor(resumed.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    expect(completed.turn_id).toBe("t1");
    // The harness got the real resume argv: --resume names the id, ahead
    // of every autonomy-derived flag, and no fresh --session-id exists.
    const spawned = fakeRecord(resumed, "argv.jsonl") as Array<{ args: string[] }>;
    const args = spawned[0]?.args ?? [];
    expect(args).toEqual(argv.slice(1));
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe(id);
    expect(args).not.toContain("--session-id");
    send(resumed.driver, { type: "shutdown" });
    await waitFor(resumed.events, of("session_ended"), "session_ended");
    expect(await resumed.code).toBe(0);
  }, 30_000);
});
