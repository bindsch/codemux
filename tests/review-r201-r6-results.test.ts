import { expect, spyOn, test } from "bun:test";
import { durableFs, openStagingSync } from "../src/fs-durable.js";
import { parseGooseResultEnvelope } from "../src/result-envelope/goose.js";
import { GOOSE_SESSION_ID_PATTERN, parseGooseSessionTurn } from "../src/session/goose-session.js";
import { GOOSE_DRIVER_PROFILE } from "../src/session/goose-driver.js";
import { emptyUsage } from "../src/result-envelope/common.js";

const id = "20261111_120000";
const message = { role: "assistant", id: "reply", content: [{ type: "text", text: "Done" }] };
const metadata = { status: "completed", total_tokens: 135, input_tokens: 110,
  output_tokens: 20, cache_read_input_tokens: 10, cache_write_input_tokens: 5, cost_usd: 0.01 };
// goose-cli v1.50.1 session/output.rs display_session_info and session/mod.rs JsonOutput.
const banner = (sessionId = id) => `\n    __( O)>  ● new session · provider model\n   \\____)     ${sessionId} · /workspace\n     L L     goose is ready\n`;

test.each([false, true])("Goose native pretty JSON adopts the banner identity (resume=%s)", (resume) => {
  const wire = banner() + JSON.stringify({ messages: [message], metadata }, null, 2) + "\n";
  const parsed = parseGooseSessionTurn(wire, { knownSessionId: resume ? id : null });
  expect(parsed).toMatchObject({ answer: "Done", sessionId: id, noSessionId: false, noWire: false, wrongSession: false });
  expect(parsed.usage).toEqual({ input_tokens: 100, output_tokens: 20, cached_input_tokens: 15,
    total_tokens: 135, cost_usd: 0.01 });
  expect(parseGooseSessionTurn(banner("20261111_130000") + JSON.stringify({ messages: [message], metadata }),
    { knownSessionId: id }).wrongSession).toBe(true);
});

test("Goose bare JSON and stream-json retain native totals without inventing an identity", () => {
  for (const wire of [JSON.stringify({ messages: [message], metadata }, null, 2),
    [JSON.stringify({ type: "message", message }), JSON.stringify({ type: "complete", ...metadata })].join("\n")]) {
    const parsed = parseGooseResultEnvelope(wire)!;
    expect(parsed.answer).toBe("Done");
    expect(parsed.sessionId).toBeNull();
    expect(parsed.usage.total_tokens).toBe(135);
    expect(parsed.usage.cost_usd).toBe(0.01);
  }
});

test("Goose session banner parsing does not adopt an ID in assistant text", () => {
  const parsed = parseGooseResultEnvelope(JSON.stringify({ messages: [{ ...message,
    content: banner() }], metadata }));
  expect(parsed?.sessionId).toBeNull();
});

test("Goose JSON metadata failure survives answer extraction", () => {
  const wire = banner() + JSON.stringify({ messages: [message], metadata: { ...metadata, status: "error" } });
  expect(parseGooseResultEnvelope(wire)?.errorMessage).toContain("error");
  expect(GOOSE_DRIVER_PROFILE.parseTurnOutput!(wire, id)).toMatchObject({ failed: true, failureReason: "session status: error" });
});

test("Goose resumed transcripts count only the current turn's measured usage", () => {
  const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.01 };
  const messages = [{ role: "user", content: "first" }, { ...message, usage },
    { role: "user", content: "second" }, { ...message, id: "second", usage }];
  const parsed = parseGooseSessionTurn(banner() + JSON.stringify({ messages, metadata }), { knownSessionId: id });
  expect(parsed.usage).toEqual({ input_tokens: 10, output_tokens: 2, cached_input_tokens: 0, total_tokens: 12, cost_usd: 0.01 });
});

test("Goose cumulative session metadata cannot fill an unmeasured resumed turn", () => {
  const messages = [{ role: "user", content: "first" }, message,
    { role: "user", content: "second" }, { ...message, id: "second" }];
  const parsed = parseGooseSessionTurn(banner() + JSON.stringify({ messages, metadata }), { knownSessionId: id });
  expect(parsed.usage).toEqual(emptyUsage());
});

test("Goose stream-json keeps a colored banner identity outside assistant content", () => {
  const wire = banner().replace(id, `\x1b[2m${id}\x1b[0m`) +
    JSON.stringify({ type: "message", message }) + "\n" + JSON.stringify({ type: "complete", ...metadata });
  expect(parseGooseResultEnvelope(wire)?.sessionId).toBe(id);
});

test.each(["20261111_1", "20261111_12", "20261111_1234567"])("Goose accepts native date-counter ID %s", (sessionId) => {
  // v1.50.1 SessionStorage::create_session uses YYYYMMDD + an unpadded SQL counter.
  expect(GOOSE_SESSION_ID_PATTERN.test(sessionId)).toBe(true);
  const wire = banner(sessionId) + JSON.stringify({ messages: [message], metadata }, null, 2);
  expect(parseGooseSessionTurn(wire, { knownSessionId: sessionId })).toMatchObject({
    sessionId, noSessionId: false, wrongSession: false, noWire: false,
  });
});

test("staging closes its descriptor when fchmod fails and preserves the original error", () => {
  const failure = new Error("synthetic fchmod EIO");
  const open = spyOn(durableFs, "openSync").mockReturnValue(123);
  const chmod = spyOn(durableFs, "fchmodSync").mockImplementation(() => { throw failure; });
  const close = spyOn(durableFs, "closeSync").mockImplementation(() => {});
  try {
    expect(() => openStagingSync("/synthetic/staging", 0o600)).toThrow(failure);
    expect(close).toHaveBeenCalledWith(123);
    close.mockImplementation(() => { throw new Error("synthetic close EIO"); });
    expect(() => openStagingSync("/synthetic/staging", 0o600)).toThrow(failure);
    expect(close).toHaveBeenCalledTimes(2);
  } finally { open.mockRestore(); chmod.mockRestore(); close.mockRestore(); }
});
