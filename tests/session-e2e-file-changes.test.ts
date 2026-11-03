import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanups, of, send, startSession, waitFor } from "./helpers/session-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

describe("claude session driver e2e", () => {
  test("a denied edit derives no file_change", async () => {
    // Review live10, correctness 5: the derived change used to fire at
    // the tool_use frame — before the permission round-trip — so a call
    // the caller then denied had already reported its edit. The
    // candidate now waits for the tool's own result: a denied or failed
    // call changed nothing and derives nothing.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:askedit please" });
    await waitFor(session.events, of("session_started"), "session_started");
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    expect(request.tool).toBe("Edit");
    // The tool_use frame is already on the stream: the candidate exists,
    // held back by the driver.
    await waitFor(session.events, of("tool_call"), "tool_call");
    send(session.driver, {
      type: "permission_decision",
      request_id: request.request_id,
      decision: "deny",
    });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "tool_result" && event.is_error === true),
      "the denied tool_result"
    );
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(of("file_change")(session.events)).toBeUndefined();
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("the Write add/edit split reads the workspace at the call, and the change follows the result", async () => {
    // The other half of review live10, correctness 5: the confirming
    // event fires only after the successful tool_result, and a Write's
    // action is the pre-write state of its target — an existing file is
    // an edit, a fresh one an add. The parser cannot know either (it
    // never touches the filesystem); the driver's existsSync at the
    // tool_use frame is what settles it, before the tool runs (it
    // follows symlinks — a dangling link's missing target is an add,
    // review live14).
    const session = await startSession();
    // The target of the second turn's Write pre-exists.
    writeFileSync(join(session.options.cwd, "file.txt"), "old");
    send(session.driver, { type: "user", text: "scenario:write made.txt" });
    await waitFor(session.events, of("session_started"), "session_started");
    const added = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "file_change" && event.action === "add"),
      "the add change"
    );
    expect(added.derived).toBe(true);
    expect(added.path).toBe(join(session.options.cwd, "made.txt"));
    // The confirming result came first: the change is reported when the
    // tool succeeded, never at the tool_use frame.
    expect(
      session.events.map((event) => event.type).indexOf("tool_result")
    ).toBeLessThan(session.events.indexOf(added));
    await waitFor(session.events, of("turn_completed"), "turn_completed");

    send(session.driver, { type: "user", text: "scenario:write file.txt" });
    const edited = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "file_change" && event.action === "edit"),
      "the edit change"
    );
    expect(edited.path).toBe(join(session.options.cwd, "file.txt"));
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("a relative Write target resolves against the session cwd, not codemux's own", async () => {
    // Review live15: the add/edit split's existsSync resolved a relative
    // file_path against codemux's process working directory — here the
    // repo root, which does contain a package.json the session's fresh
    // workspace does not. A relative target must resolve against the
    // session cwd the harness runs in: package.json is an add (missing
    // there), and a file that exists only in the session workspace is an
    // edit.
    const session = await startSession();
    writeFileSync(join(session.options.cwd, "session-only.txt"), "old");
    send(session.driver, { type: "user", text: "scenario:write rel:package.json" });
    await waitFor(session.events, of("session_started"), "session_started");
    const added = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) => event.type === "file_change" && event.action === "add" && event.path === "package.json"
        ),
      "the relative add"
    );
    expect(added.derived).toBe(true);
    await waitFor(session.events, of("turn_completed"), "turn_completed");

    send(session.driver, { type: "user", text: "scenario:write rel:session-only.txt" });
    const edited = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) => event.type === "file_change" && event.action === "edit" && event.path === "session-only.txt"
        ),
      "the relative edit"
    );
    expect(edited.path).toBe("session-only.txt");
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });
});
