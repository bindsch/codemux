import { afterEach, expect, spyOn, test } from "bun:test";
import { cleanups, of, send, startSession, waitFor } from "./helpers/session-e2e.js";

afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

test.each(["result", "errors"])("native failed %s prints one login command across repeated turns", async (field) => {
  const stderr: string[] = [];
  const capture = spyOn(console, "error").mockImplementation((...parts) => stderr.push(parts.join(" ")));
  try {
    const session = await startSession({}, {
      FAKE_DIAGNOSTIC_TEXT: "Not logged in", FAKE_DIAGNOSTIC_FAILED: "1", FAKE_DIAGNOSTIC_FIELD: field,
    });
    for (let turn = 1; turn <= 2; turn++) {
      send(session.driver, { type: "user", text: "scenario:diagnostic" });
      const complete = await waitFor(session.events,
        (events) => events.filter((event) => event.type === "turn_completed")[turn - 1], "failed turn");
      expect(complete.finish).toBe("failed");
    }
    expect(stderr.join("\n").match(/claude auth login/g)).toHaveLength(1);
    expect(stderr).toContain("claude: the harness reported a missing or invalid login; run `claude auth login`.");
    expect(session.rawLines.join("\n")).toContain("Not logged in");
    send(session.driver, { type: "shutdown" });
    await session.code;
  } finally { capture.mockRestore(); }
});

test.each([
  ["claude", "Not logged in", false],
  ["claude", "HTTP 401 Unauthorized", true],
  ["zai", "Not logged in", true],
] as const)("%s result %s, failed=%s, does not prescribe Claude login", async (agent, text, failed) => {
  const stderr: string[] = [];
  const capture = spyOn(console, "error").mockImplementation((...parts) => stderr.push(parts.join(" ")));
  try {
    const session = await startSession({ agent }, {
      FAKE_DIAGNOSTIC_TEXT: text, FAKE_DIAGNOSTIC_FAILED: failed ? "1" : "0",
    });
    send(session.driver, { type: "user", text: "scenario:diagnostic" });
    const complete = await waitFor(session.events, of("turn_completed"), "completed turn");
    expect(complete.finish).toBe(failed ? "failed" : "end");
    if (!failed) expect(of("assistant_message")(session.events)?.text).toBe(text);
    expect(stderr.join("\n")).not.toContain("claude auth login");
    send(session.driver, { type: "shutdown" });
    await session.code;
  } finally { capture.mockRestore(); }
});

test("malformed JSON cannot reach the authentication result hook", async () => {
  const stderr: string[] = [];
  const capture = spyOn(console, "error").mockImplementation((...parts) => stderr.push(parts.join(" ")));
  try {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait" });
    await waitFor(session.events, of("turn_started"), "active turn");
    expect(() => session.driver.handleHarnessLine('{"result":"Not logged in"')).not.toThrow();
    expect(await session.code).toBe(1);
    expect(stderr.join("\n")).not.toContain("claude auth login");
  } finally { capture.mockRestore(); }
});

test.each(["Not logged in", "authentication failed"])("a denied session repeats the missing grant once after %s", async (text) => {
  const stderr: string[] = [];
  const capture = spyOn(console, "error").mockImplementation((...parts) => stderr.push(parts.join(" ")));
  try {
    const session = await startSession({ sandboxLoginStoreDenied: true }, {
      FAKE_DIAGNOSTIC_TEXT: text, FAKE_DIAGNOSTIC_FAILED: "1",
    });
    for (let turn = 1; turn <= 2; turn++) {
      send(session.driver, { type: "user", text: "scenario:diagnostic" });
      await waitFor(session.events, (events) => events.filter((event) => event.type === "turn_completed")[turn - 1], "failed turn");
    }
    expect(stderr.join("\n").match(/the sandbox was not granted the login store/g)).toHaveLength(1);
    expect(stderr.join("\n")).not.toContain("claude auth login");
    send(session.driver, { type: "shutdown" });
    await session.code;
  } finally { capture.mockRestore(); }
});
