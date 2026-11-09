import { describe, expect, test } from "bun:test";
import { GEMINI_DRIVER_PROFILE } from "../src/session/gemini-driver.js";

const ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const parse = (event: unknown) => GEMINI_DRIVER_PROFILE.parseStreamLine!(JSON.stringify(event), ID);

describe("Gemini integrated driver profile", () => {
  test("uses stdin and refuses to launch without its minted identity", () => {
    expect(GEMINI_DRIVER_PROFILE.promptCarrier).toBe("stdin");
    expect(() => GEMINI_DRIVER_PROFILE.buildTurnCommand({ text: "p", sessionId: null, firstTurn: true, hermeticHome: null, autonomy: "high" }))
      .toThrow(/minted gemini identity/);
  });

  test("maps native identity, deltas, tools, errors, and completion onto the shared event grammar", () => {
    expect(parse({ type: "init", session_id: ID, model: "native" })).toEqual({ kind: "confirmed", sessionId: ID, model: "native" });
    expect(parse({ type: "message", role: "assistant", content: "text", delta: true })).toEqual({ kind: "assistant", text: "text", delta: true });
    expect(parse({ type: "tool_use", tool_id: "1", tool_name: "read_file", parameters: {} })).toEqual({ kind: "tool_use", callId: "1", name: "read_file", input: {} });
    expect(parse({ type: "tool_result", tool_id: "1", status: "success", output: "ok" })).toEqual({ kind: "tool_result", callId: "1", output: "ok", isError: false });
    expect(parse({ type: "error", severity: "warning", message: "notice" })).toEqual({ kind: "error", failsTurn: false, message: "notice" });
    expect(parse({ type: "error", message: "failure" })).toEqual({ kind: "error", failsTurn: true, message: "failure" });
    expect(parse({ type: "result", status: "error", error: { message: "failure" } })).toMatchObject({ kind: "result", failed: true, failureReason: "failure" });
    expect(parse({ type: "brand_new_event" })).toEqual({ kind: "unknown" });
    expect(GEMINI_DRIVER_PROFILE.parseStreamLine!("bad json", ID).kind).toBe("unusable");
  });

  test("malformed native events fail rather than fabricating usable frames", () => {
    const events = [
      { type: "init" }, { type: "init", session_id: "different" },
      { type: "message", role: "assistant" },
      { type: "message", role: "unknown", content: "text" },
      { type: "tool_use", tool_name: "read_file" },
      { type: "tool_use", tool_id: "1" },
      { type: "tool_result", status: "success" },
      { type: "tool_result", tool_id: "1", status: "invalid" },
      { type: "error" }, { type: "result", status: "invalid" },
    ];
    for (const event of events) expect(parse(event).kind).toBe("grammar_error");
    expect(parse(null).kind).toBe("unusable");
    expect(parse({}).kind).toBe("unknown");
  });
});
