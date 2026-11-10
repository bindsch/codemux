/**
 * Unit tests for the droid session wiring (src/session/droid-session.ts),
 * the goose-session tests' shape: no process spawning, every case a pure
 * function on pinned inputs. The wire facts themselves (the -s flag
 * registration, the v4 mint, the result object builders) live quoted in
 * the module's header, read from the installed 0.221.0 binary on
 * 2026-11-09; these tests pin the codemux side — the floor, the id
 * pattern, the capability matrix, the command spelling (against the run
 * adapter, so session turns and runs cannot drift), and the turn parse's
 * identity rules.
 */

import { describe, expect, test } from "bun:test";
import { DroidAdapter } from "../src/adapters/droid.js";
import {
  DROID_SESSION_FLOOR,
  DROID_SESSION_ID_PATTERN,
  droidSessionCapabilities,
  droidSessionEffortValue,
  buildDroidSessionCommand,
  parseDroidSessionTurn,
} from "../src/session/droid-session.js";

describe("droid session wiring", () => {
  test("the floor and the id pattern", () => {
    expect(DROID_SESSION_FLOOR).toBe("0.221.0");
    // The binary mints v4 UUIDs; the pattern accepts that shape.
    expect(DROID_SESSION_ID_PATTERN.test("0b56b1c8-6c9f-4b1f-9f5d-9a89c0d10724")).toBe(true);
    // The binary's own validation is nonempty only, so any whitespace-free
    // token resumes — codemux feeds back only ids droid itself reported.
    expect(DROID_SESSION_ID_PATTERN.test("abc123")).toBe(true);
    // Blank, whitespace-only, and whitespace-carrying ids are refused.
    expect(DROID_SESSION_ID_PATTERN.test("")).toBe(false);
    expect(DROID_SESSION_ID_PATTERN.test("   ")).toBe(false);
    expect(DROID_SESSION_ID_PATTERN.test("a b")).toBe(false);
    expect(DROID_SESSION_ID_PATTERN.test(" x")).toBe(false);
    expect(DROID_SESSION_ID_PATTERN.test("x ")).toBe(false);
  });

  test("the honest capability matrix", () => {
    expect(droidSessionCapabilities()).toEqual({
      live_input: true,
      user_during_turn: false,
      steer: false,
      interrupt: false,
      permissions: false,
      deltas: false,
      file_changes: false,
      usage_stream: false,
      resume: true,
    });
  });

  test("a fresh turn carries no session flag; a resume carries -s", () => {
    expect(buildDroidSessionCommand({})).toEqual([
      "droid",
      "exec",
      "--output-format",
      "stream-json",
    ]);
    expect(
      buildDroidSessionCommand({ resumeSessionId: "0b56b1c8-6c9f-4b1f-9f5d-9a89c0d10724" })
    ).toEqual([
      "droid",
      "exec",
      "--output-format",
      "stream-json",
      "-s",
      "0b56b1c8-6c9f-4b1f-9f5d-9a89c0d10724",
    ]);
  });

  test("--tools none reapplies the run path's only-tools carrier on every turn", () => {
    // Fresh or resumed, each turn's argv carries the same carrier, so a
    // resumed session keeps the tool set the first turn promised.
    expect(buildDroidSessionCommand({ tools: "none" })).toEqual([
      "droid",
      "exec",
      "--output-format",
      "stream-json",
      "--only-tools",
      "ToolSearch",
    ]);
    expect(
      buildDroidSessionCommand({ tools: "none", resumeSessionId: "0b56b1c8-6c9f-4b1f-9f5d-9a89c0d10724" })
    ).toEqual([
      "droid",
      "exec",
      "--output-format",
      "stream-json",
      "--only-tools",
      "ToolSearch",
      "-s",
      "0b56b1c8-6c9f-4b1f-9f5d-9a89c0d10724",
    ]);
  });

  test("model, autonomy, and effort ride argv in the run path's spelling", () => {
    expect(buildDroidSessionCommand({ model: "gpt-5.6" })).toEqual([
      "droid",
      "exec",
      "-m",
      "gpt-5.6",
      "--output-format",
      "stream-json",
    ]);
    // Read-only autonomy maps to no flag (the run adapter's mapAutonomy).
    expect(buildDroidSessionCommand({ autonomy: "read-only" })).toEqual([
      "droid",
      "exec",
      "--output-format",
      "stream-json",
    ]);
    expect(buildDroidSessionCommand({ autonomy: "low" })).toEqual([
      "droid",
      "exec",
      "--output-format",
      "stream-json",
      "--auto",
      "low",
    ]);
    expect(
      buildDroidSessionCommand({ autonomy: "high", resumeSessionId: "s1" })
    ).toEqual(["droid", "exec", "--output-format", "stream-json", "--auto", "high", "-s", "s1"]);
    expect(buildDroidSessionCommand({ effort: "medium" })).toEqual([
      "droid",
      "exec",
      "--output-format",
      "stream-json",
      "--reasoning-effort",
      "medium",
    ]);
  });

  test("an override turn rides the settings file and splits -m from the effort mapping", () => {
    // --settings is a root-level flag, so it precedes exec; -m names the
    // BYOK entry's id while --reasoning-effort still maps on the RAW
    // model (the gpt-5.6 family rule) — never one field for both.
    expect(
      buildDroidSessionCommand({
        model: "gpt-5.6",
        providerModelId: "codemux-override-gateway",
        settingsPath: "/tmp/byok-1/settings.json",
        effort: "none",
      })
    ).toEqual([
      "droid",
      "--settings",
      "/tmp/byok-1/settings.json",
      "exec",
      "-m",
      "codemux-override-gateway",
      "--output-format",
      "stream-json",
      "--reasoning-effort",
      // The RAW spelling decides: gpt-5.6 keeps the literal none.
      "none",
    ]);
    // Without the entry id the raw spelling rides -m, and the same
    // effort level maps through the raw model the same way.
    expect(
      buildDroidSessionCommand({ model: "gpt-5.6", effort: "none" })
    ).toEqual([
      "droid",
      "exec",
      "-m",
      "gpt-5.6",
      "--output-format",
      "stream-json",
      "--reasoning-effort",
      "none",
    ]);
  });

  test("a hermetic turn wraps the command in the run path's env middle", () => {
    expect(
      buildDroidSessionCommand({
        hermeticEnvAssignments: [
          "-u",
          "FACTORY_HOME_OVERRIDE",
          "HOME=/private/session-home",
        ],
      })
    ).toEqual([
      "env",
      "-u",
      "FACTORY_HOME_OVERRIDE",
      "HOME=/private/session-home",
      "droid",
      "exec",
      "--output-format",
      "stream-json",
    ]);
  });

  test("the effort value mapping, pinned against the run adapter's", () => {
    expect(droidSessionEffortValue("none")).toBe("off");
    expect(droidSessionEffortValue("none", "gpt-5.6")).toBe("none");
    expect(droidSessionEffortValue("none", "gpt-5.6-pro")).toBe("none");
    expect(droidSessionEffortValue("none", "claude-opus-4-6")).toBe("off");
    expect(droidSessionEffortValue("max")).toBe("max");
    // The adapter's own buildRunCommand agrees for the same request, so
    // the session spelling and the run spelling cannot drift.
    const adapter = new DroidAdapter({});
    for (const [model, effort] of [
      [undefined, "none"],
      ["gpt-5.6", "none"],
      ["gpt-5.6-codex", "none"],
      ["glm-5.3", "low"],
    ] as const) {
      const run = adapter.buildRunCommand({
        agent: "droid",
        prompt: "t",
        ...(model !== undefined ? { model } : {}),
        effort,
        resultJson: true,
      });
      // The output format is each surface's own wire choice (runs read
      // the stream-json transcript, lane AN1); every other token agrees.
      const withoutFormat = (argv: string[]): string[] => {
        const at = argv.indexOf("--output-format");
        return at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];
      };
      expect(withoutFormat(run)).toEqual(
        withoutFormat(buildDroidSessionCommand({
          ...(model !== undefined ? { model } : {}),
          effort,
        }))
      );
    }
  });

  test("the turn parse folds the result object and its usage", () => {
    const object = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1200,
      num_turns: 1,
      result: "the reply",
      session_id: "0b56b1c8-6c9f-4b1f-9f5d-9a89c0d10724",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
        factory_credits: 1,
        thinking_tokens: 7,
        ttft_ms: 250,
      },
    });
    const fresh = parseDroidSessionTurn(object, { knownSessionId: null });
    expect(fresh.noWire).toBe(false);
    expect(fresh.noSessionId).toBe(false);
    expect(fresh.sessionId).toBe("0b56b1c8-6c9f-4b1f-9f5d-9a89c0d10724");
    expect(fresh.answer).toBe("the reply");
    expect(fresh.usage.input_tokens).toBe(100);
    expect(fresh.usage.output_tokens).toBe(20);
    expect(fresh.usage.cached_input_tokens).toBe(15);
    expect(fresh.usage.total_tokens).toBe(135);
  });

  test("the turn parse takes the last result object when chatter precedes it", () => {
    const stdout =
      '{"type":"system","note":"chatter"}\n' +
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "final",
        session_id: "s9",
        usage: { input_tokens: 1, output_tokens: 1 },
      }) +
      "\n";
    const parsed = parseDroidSessionTurn(stdout, { knownSessionId: null });
    expect(parsed.answer).toBe("final");
    expect(parsed.sessionId).toBe("s9");
    expect(parsed.noWire).toBe(false);
  });

  test("a resumed turn must name the resumed id", () => {
    const object = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "reply",
      session_id: "s1",
      usage: {},
    });
    expect(parseDroidSessionTurn(object, { knownSessionId: "s1" }).wrongSession).toBe(false);
    expect(parseDroidSessionTurn(object, { knownSessionId: "s2" }).wrongSession).toBe(true);
    // A fresh turn has no pin yet, so any id passes.
    expect(parseDroidSessionTurn(object, { knownSessionId: null }).wrongSession).toBe(false);
  });

  test("a fresh turn owes a session id; a blank id is no id", () => {
    const noId = parseDroidSessionTurn(
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "x" }),
      { knownSessionId: null }
    );
    expect(noId.noSessionId).toBe(true);
    expect(noId.sessionId).toBeNull();
    // The early-failure builder prints session_id:"" before a session
    // exists; the binary's isValidSessionId rule folds that to no id.
    const blank = parseDroidSessionTurn(
      JSON.stringify({
        type: "result",
        subtype: "failure",
        is_error: true,
        result: "",
        session_id: "",
        usage: {},
      }),
      { knownSessionId: null }
    );
    expect(blank.noSessionId).toBe(true);
    expect(blank.sessionId).toBeNull();
    const whitespace = parseDroidSessionTurn(
      JSON.stringify({ type: "result", session_id: "  ", result: "x" }),
      { knownSessionId: null }
    );
    expect(whitespace.noSessionId).toBe(true);
  });

  test("stdout with no result object is no wire", () => {
    const parsed = parseDroidSessionTurn("droid: connection refused\n", {
      knownSessionId: null,
    });
    expect(parsed.noWire).toBe(true);
    expect(parsed.answer).toBeNull();
    expect(parsed.sessionId).toBeNull();
    expect(parsed.noSessionId).toBe(false);
    expect(parsed.wrongSession).toBe(false);
    expect(parsed.usage.total_tokens).toBeNull();
  });
});
