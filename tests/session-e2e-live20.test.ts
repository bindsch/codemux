import { afterAll, describe, expect, test } from "bun:test";
import { buildClaudeSessionCommand } from "../src/session/claude-session.js";
import { claimForResume } from "../src/session/registry.js";
import {
  cleanups,
  fakeRecord,
  of,
  send,
  startSession,
  waitFor,
  waitForRecord
} from "./helpers/session-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

describe("claude session driver e2e - review live20", () => {
  test("an interrupt that missed its turn does not relabel the next turn's API failure", async () => {
    // Correctness minor 4: the missed interrupt rolls to the next turn,
    // and any error result there was labeled interrupted. A harness with
    // no turn to interrupt drops the request, so only an error result of
    // the interrupted shape (error_during_execution) is the interrupt
    // striking; an API error (is_error under subtype success) fails.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:race one" });
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    send(session.driver, { type: "interrupt" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:apierror two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "both turn_completed"
    );
    const completions = session.events.filter((event) => event.type === "turn_completed");
    expect(completions.map((event) => [event.turn_id, event.finish])).toEqual([
      ["t1", "end"],
      ["t2", "failed"],
    ]);
    expect(completions[1]!.reason).toBe("success");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("a decision whose answer cannot be written is rejected, never acked accepted", async () => {
    // The codex correctness major 3, on the claude family: the refused
    // write started the crash end, which superseded the request, and the
    // decision was still acked accepted.
    const session = await startSession({ permissionTimeoutMs: 60_000 });
    send(session.driver, { type: "user", text: "scenario:ask plain" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    session.proc.writeLine = () => ({ ok: false, reason: "backlog" });
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
    const ack = session.events.find(
      (event) => event.type.startsWith("input_") && event.input_seq === 2
    );
    expect(ack?.type).toBe("input_rejected");
    expect(ack?.reason).toBe("shutting_down");
    const resolved = session.events.filter((event) => event.type === "permission_resolved");
    expect(resolved.map((event) => event.resolution)).toEqual(["superseded"]);
  });

  test("a session created at high and resumed read-only enforces read-only's ceiling", async () => {
    // Contracts minor 2: design §4.6 names this behavioral pin next to
    // the argv assert in session-claude-command.test.ts. A high session runs a
    // turn and ends; the resume is claimed at read-only, the harness gets
    // the real resume argv, and an allow for Bash is refused by the
    // read-only ceiling, which writes the deny itself.
    const created = await startSession({ autonomy: "high" });
    send(created.driver, { type: "user", text: "scenario:basic hi" });
    await waitFor(created.events, of("turn_completed"), "turn_completed");
    send(created.driver, { type: "shutdown" });
    expect(await created.code).toBe(0);
    expect(of("session_ended")(created.events)?.resumable).toBe(true);

    const id = created.options.sessionId;
    const registryPath = created.options.registryPath as string;
    const claim = claimForResume(registryPath, id, {
      agent: "claude",
      harnessHome: created.options.harnessHome,
      cwd: created.options.cwd,
      passEnv: [],
      playwrightMcp: false,
      autonomy: "read-only",
      sandboxed: false,
      sandboxTrust: "standard",
      sandboxNoNet: false,
      sandboxScrubEnv: false,
      sandboxBlock: [],
      providerBaseUrl: null,
      hermetic: false,
      projectSettings: false,
    });
    expect(claim.outcome).toBe("ok");
    const argv = buildClaudeSessionCommand({
      agent: "claude",
      pathEnv: process.env.PATH ?? "",
      resumeId: id,
      autonomy: "read-only",
      cwd: created.options.cwd,
    }).argv;
    const resumed = await startSession(
      {
        sessionId: id,
        autonomy: "read-only",
        cwd: created.options.cwd,
        registryPath,
        harnessHome: created.options.harnessHome,
        permissionTimeoutMs: 60_000,
      },
      {},
      argv.slice(1)
    );
    resumed.driver.adoptResumeClaim();
    send(resumed.driver, { type: "user", text: "scenario:ask run it" });
    const request = await waitFor(resumed.events, of("permission_request"), "permission_request");
    expect(request.tool).toBe("Bash");
    send(resumed.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
    const rejected = await waitFor(resumed.events, of("input_rejected"), "input_rejected");
    expect(rejected.reason).toBe("autonomy_escalation");
    const resolved = await waitFor(resumed.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("deny");
    await waitFor(resumed.events, of("turn_completed"), "turn_completed");
    const responses = (await waitForRecord(resumed, "responses.jsonl")) as Array<{ behavior: string }>;
    expect(responses.map((response) => response.behavior)).toEqual(["deny"]);
    const spawned = fakeRecord(resumed, "argv.jsonl") as Array<{ args: string[] }>;
    expect(spawned[0]?.args).toEqual(argv.slice(1));
    expect(spawned[0]?.args.join(" ")).not.toContain("--allowedTools");
    send(resumed.driver, { type: "shutdown" });
    expect(await resumed.code).toBe(0);
    expect(of("session_ended")(resumed.events)?.resumable).toBe(true);
  });
});
