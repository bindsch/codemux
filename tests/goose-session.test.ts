// Unit tests for the goose session wiring (src/session/goose-session.ts):
// the floor, the legacy date_time id shape, the honest capability matrix, the
// per-turn environment and command (the both-flags-or-neither resume
// pair), and the turn parse's identity rules. No spawning — the wire
// strings below are the fixture's and the binary's shapes, rendered
// inline.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GooseAdapter } from "../src/adapters/goose.js";
import {
  GOOSE_SESSION_FLOOR,
  GOOSE_SESSION_ID_PATTERN,
  buildGooseSessionCommand,
  buildGooseSessionEnv,
  gooseSessionCapabilities,
  gooseSessionEffortEnv,
  parseGooseSessionTurn,
} from "../src/session/goose-session.js";

const ID = "20261109_120000";
const OTHER_ID = "20261109_130000";

/** One goose turn's stdout: progress chatter around the final object. */
const turn = (object: Record<string, unknown>): string =>
  `warming up\n${JSON.stringify({
    content: "Done",
    session_id: ID,
    usage: { inputTokens: 110, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 5 },
    ...object,
  })}\n`;

describe("goose session wiring", () => {
  test("the floor and the harness-minted id shape", () => {
    expect(GOOSE_SESSION_FLOOR).toBe("1.50.1");
    expect(GOOSE_SESSION_ID_PATTERN.test(ID)).toBe(true);
    // A UUID mint is not goose's id.
    expect(
      GOOSE_SESSION_ID_PATTERN.test("1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d")
    ).toBe(false);
  });

  test("capabilities: live input and resume; nothing else", () => {
    expect(gooseSessionCapabilities()).toEqual({
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

  test("the per-turn environment carries the run adapter's mode spelling", () => {
    const adapter = new GooseAdapter({});
    for (const level of ["read-only", "low", "medium", "high"] as const) {
      expect(buildGooseSessionEnv({ autonomy: level })).toEqual(
        adapter.getRunEnv({ autonomy: level } as never)
      );
    }
    // Model and effort ride the same environment, the effort with
    // codemux's none mapped onto the enum's off.
    expect(buildGooseSessionEnv({ autonomy: "low", model: "gpt-5.1" })).toEqual({
      GOOSE_MODE: "approve",
      GOOSE_MODEL: "gpt-5.1",
    });
    expect(gooseSessionEffortEnv("none")).toBe("off");
    expect(gooseSessionEffortEnv("max")).toBe("max");
    // A provider override's variables thread through untouched.
    expect(
      buildGooseSessionEnv({
        autonomy: "high",
        providerEnv: { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://gateway.example/v1" },
      })
    ).toEqual({
      GOOSE_MODE: "auto",
      OPENAI_API_KEY: "k",
      OPENAI_BASE_URL: "https://gateway.example/v1",
    });
  });

  test("a fresh turn carries no session flag; a resume carries the both-flags pair", () => {
    expect(
      buildGooseSessionCommand({ prompt: "the prompt" })
    ).toEqual(["goose", "run", "--output-format", "json", "-t", "the prompt"]);
    expect(
      buildGooseSessionCommand({ prompt: "the prompt", resumeSessionId: ID })
    ).toEqual([
      "goose",
      "run",
      "--resume",
      "--session-id",
      ID,
      "--output-format",
      "json",
      "-t",
      "the prompt",
    ]);
  });

  test("--tools none reapplies --no-profile on every turn", () => {
    // Fresh or resumed, each turn's argv carries the run path's carrier,
    // so a resumed session keeps the tool set the first turn promised.
    expect(
      buildGooseSessionCommand({ prompt: "the prompt", tools: "none" })
    ).toEqual(["goose", "run", "--output-format", "json", "--no-profile", "-t", "the prompt"]);
    expect(
      buildGooseSessionCommand({ prompt: "the prompt", resumeSessionId: ID, tools: "none" })
    ).toEqual([
      "goose",
      "run",
      "--resume",
      "--session-id",
      ID,
      "--output-format",
      "json",
      "--no-profile",
      "-t",
      "the prompt",
    ]);
  });

  test("the sandbox-scoped Playwright server rides every turn's --with-extension", () => {
    // The shared activation (the Playwright agent set and the session
    // turn threading) rides scratch/fix/w4-shared.patch; the builder's
    // per-turn carrier is landed here and tested now.
    // Canonical: the carrier resolves the binary path, and the temp root
    // is a symlink on macOS.
    const bin = realpathSync(mkdtempSync(join(tmpdir(), "codemux-goose-session-pw-")));
    const binary = join(bin, "playwright-mcp");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      expect(
        buildGooseSessionCommand({ prompt: "the prompt", playwrightMcp: true })
      ).toEqual([
        "goose",
        "run",
        "--output-format",
        "json",
        "--with-extension",
        `playwright:${binary}`,
        "-t",
        "the prompt",
      ]);
      // Without the flag no extension rides the turn.
      expect(
        buildGooseSessionCommand({ prompt: "the prompt" })
      ).toEqual(["goose", "run", "--output-format", "json", "-t", "the prompt"]);
    } finally {
      process.env.PATH = originalPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test("a hermetic turn wraps the command in the run path's env middle", () => {
    expect(
      buildGooseSessionCommand({
        prompt: "the prompt",
        hermeticEnvAssignments: [
          "GOOSE_PATH_ROOT=/private/session-home",
          "XDG_CONFIG_HOME=/private/session-home/config",
        ],
      })
    ).toEqual([
      "env",
      "GOOSE_PATH_ROOT=/private/session-home",
      "XDG_CONFIG_HOME=/private/session-home/config",
      "goose",
      "run",
      "--output-format",
      "json",
      "-t",
      "the prompt",
    ]);
  });

  test("parse folds the final object: answer, session id, the usage arithmetic", () => {
    expect(parseGooseSessionTurn(turn({}), { knownSessionId: ID })).toEqual({
      answer: "Done",
      // inputTokens includes the cache reads: 110 - 10 uncached, the
      // cached sum read+write (the agy rule), the total recomputed.
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cached_input_tokens: 15,
        total_tokens: 135,
        cost_usd: null,
      },
      sessionId: ID,
      noSessionId: false,
      wrongSession: false,
      noWire: false,
    });
  });

  test("stdout with no JSON object is the no-wire fatal", () => {
    expect(
      parseGooseSessionTurn("warming up\nstill working\n", { knownSessionId: ID })
    ).toEqual({
      answer: null,
      usage: {
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        total_tokens: null,
        cost_usd: null,
      },
      sessionId: null,
      noSessionId: false,
      wrongSession: false,
      noWire: true,
    });
  });

  test("a fresh turn owes a session id; a foreign id is the wrong-session defect", () => {
    const fresh = parseGooseSessionTurn(turn({ session_id: undefined }), {
      knownSessionId: null,
    });
    expect(fresh.sessionId).toBeNull();
    expect(fresh.noSessionId).toBe(true);
    const wrong = parseGooseSessionTurn(turn({ session_id: OTHER_ID }), {
      knownSessionId: ID,
    });
    expect(wrong.sessionId).toBe(OTHER_ID);
    expect(wrong.wrongSession).toBe(true);
  });
});
