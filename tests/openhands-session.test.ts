import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenHandsAdapter } from "../src/adapters/openhands.js";
import {
  OPENHANDS_CONVERSATION_ID_PATTERN,
  buildOpenhandsSessionCommand,
  openhandsSessionCapabilities,
  openhandsSessionEnvPrefix,
  parseOpenhandsSessionTurn,
} from "../src/session/openhands-session.js";
import { OPENHANDS_DRIVER_PROFILE } from "../src/session/openhands-driver.js";

// A dashed v4 uuid, the class textual_app.py's uuid.uuid4() mints.
const ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const HEX = ID.replace(/-/g, "");

/** The json event stream shape (utils.py json_callback prints
 * event.model_dump() lines) followed by the tail entrypoint.py prints
 * after every run: Goodbye, the hex id, and the resume hint. */
const turn = (events: string[], idHex = HEX): string =>
  `${events.join("\n")}\nGoodbye! 👋\nConversation ID: ${idHex}\nHint: run openhands --resume ${ID} to resume this conversation.\n`;

const agentEvent = (text: string): string =>
  JSON.stringify({
    kind: "MessageEvent",
    source: "agent",
    llm_message: { role: "assistant", content: [{ type: "text", text }] },
  });

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "codemux-openhands-session-"));
}

describe("openhands session wiring", () => {
  test("capabilities: live input and resume; nothing else", () => {
    expect(openhandsSessionCapabilities()).toEqual({
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

  test("the minted id shape: dashed lowercase v4 uuid", () => {
    expect(OPENHANDS_CONVERSATION_ID_PATTERN.test(ID)).toBe(true);
    // The hex form the Conversation ID line prints is not the resume form.
    expect(OPENHANDS_CONVERSATION_ID_PATTERN.test(HEX)).toBe(false);
    // A v1-versioned uuid is not the uuid4 mint.
    expect(OPENHANDS_CONVERSATION_ID_PATTERN.test("1a2b3c4d-5e6f-1a7b-8c9d-0e1f2a3b4c5d")).toBe(false);
    // A variant nibble outside 8/9/a/b is not a uuid.
    expect(OPENHANDS_CONVERSATION_ID_PATTERN.test("1a2b3c4d-5e6f-4a7b-cc9d-0e1f2a3b4c5d")).toBe(false);
    // Uppercase is not str(uuid)'s print.
    expect(OPENHANDS_CONVERSATION_ID_PATTERN.test(ID.toUpperCase())).toBe(false);
  });

  test("the env prefix is the run path's three assignments", () => {
    const adapter = new OpenHandsAdapter({ HOME: "/h" });
    const prefix = openhandsSessionEnvPrefix("/private/h");
    // The run command under a hermetic request carries exactly these
    // env assignments before the binary; the session prefix must not
    // drift from it.
    const run = adapter.buildRunCommand(
      { agent: "openhands", prompt: "p", hermetic: true, model: "m" },
      { openhandsHermeticHome: { home: "/private/h", finalize: () => {} } }
    );
    expect(prefix).toEqual(run.slice(0, prefix.length));
    expect(prefix).toEqual([
      "env",
      "HOME=/private/h",
      `OPENHANDS_PERSISTENCE_DIR=${join("/private/h", ".openhands")}`,
      `OPENHANDS_CONVERSATIONS_DIR=${join("/private/h", ".openhands", "conversations")}`,
    ]);
  });

  test("first turn runs the task file; later turns add --resume", () => {
    expect(
      buildOpenhandsSessionCommand({ firstTurn: true, conversationId: null, taskFile: "/tmp/task-1.txt" })
    ).toEqual(["openhands", "--headless", "--json", "--file", "/tmp/task-1.txt"]);
    expect(
      buildOpenhandsSessionCommand({ firstTurn: false, conversationId: ID, taskFile: "/tmp/task-2.txt" })
    ).toEqual(["openhands", "--headless", "--json", "--file", "/tmp/task-2.txt", "--resume", ID]);
    expect(() =>
      buildOpenhandsSessionCommand({ firstTurn: false, conversationId: null, taskFile: "/tmp/task.txt" })
    ).toThrow("names the conversation it resumes");
  });

  test("the driver writes the prompt's task file and finalizes it at the parse", () => {
    const home = scratch();
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const argv = OPENHANDS_DRIVER_PROFILE.buildTurnCommand({
        text: "do the thing",
        sessionId: null,
        firstTurn: true,
        hermeticHome: null,
        autonomy: "low",
      });
      expect(argv[argv.length - 1]).not.toBe("do the thing"); // never argv text
      const fileFlag = argv.indexOf("--file");
      expect(fileFlag).toBeGreaterThan(-1);
      const path = argv[fileFlag + 1] as string;
      expect(path.startsWith(join(home, ".openhands", ".codemux", `task-${process.pid}-`))).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("do the thing");
      // The parse finalizes the turn's file.
      OPENHANDS_DRIVER_PROFILE.parseTurnOutput!(turn([agentEvent("done")]), null);
      expect(existsSync(path)).toBe(false);
    } finally {
      process.env.HOME = realHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the task-file sweep removes only stale files of dead processes", () => {
    const home = scratch();
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const parent = join(home, ".openhands", ".codemux");
      mkdirSync(parent, { recursive: true });
      // A stale file whose pid is dead (pid 1 higher than ours is not
      // us and, being unminted, is not alive either — the pidProbeAlive
      // contract), aged past the two-day threshold.
      const stale = join(parent, "task-999999999-hex.txt");
      writeFileSync(stale, "old", { mode: 0o600 });
      const old = new Date(Date.now() - 3 * 86_400_000);
      utimesSync(stale, old, old);
      // A young file of the same dead pid stays.
      const young = join(parent, "task-999999998-hex.txt");
      writeFileSync(young, "new", { mode: 0o600 });
      // An unrelated entry stays.
      const unrelated = join(parent, "notes.txt");
      writeFileSync(unrelated, "keep", { mode: 0o600 });
      // The next write sweeps: the stale file is gone, the rest remain.
      const argv = OPENHANDS_DRIVER_PROFILE.buildTurnCommand({
        text: "fresh turn", sessionId: null, firstTurn: true,
        hermeticHome: null, autonomy: "low",
      });
      const path = argv[argv.indexOf("--file") + 1] as string;
      expect(readFileSync(path, "utf8")).toBe("fresh turn");
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(young)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
      OPENHANDS_DRIVER_PROFILE.parseTurnOutput!(turn([agentEvent("done")]), null);
    } finally {
      process.env.HOME = realHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the parse adopts the deferred id and keeps the identity rules", () => {
    const fresh = parseOpenhandsSessionTurn(turn([agentEvent("hello")]), {
      knownConversationId: null,
    });
    expect(fresh.answer).toBe("hello");
    expect(fresh.conversationId).toBe(ID);
    expect(fresh.noConversationId).toBe(false);
    expect(fresh.wrongConversation).toBe(false);
    expect(fresh.failed).toBe(false);

    const resumed = parseOpenhandsSessionTurn(turn([agentEvent("again")]), {
      knownConversationId: ID,
    });
    expect(resumed.conversationId).toBe(ID);
    expect(resumed.wrongConversation).toBe(false);

    // A turn that names another conversation breaks the pin.
    const otherHex = OTHER.replace(/-/g, "");
    const wrong = parseOpenhandsSessionTurn(turn([agentEvent("x")], otherHex), {
      knownConversationId: ID,
    });
    expect(wrong.conversationId).toBe(OTHER);
    expect(wrong.wrongConversation).toBe(true);

    // No Conversation ID line at all: the deferred identity has nothing
    // to adopt.
    const none = parseOpenhandsSessionTurn(`${agentEvent("x")}\nGoodbye! 👋\n`, {
      knownConversationId: null,
    });
    expect(none.conversationId).toBeNull();
    expect(none.noConversationId).toBe(true);
  });

  test("the id line matches through the rich style's SGR codes", () => {
    const styled =
      `${agentEvent("x")}\n` +
      `\u001b[36mConversation ID: \u001b[0m\u001b[1m${HEX}\u001b[0m\n`;
    const parsed = parseOpenhandsSessionTurn(styled, { knownConversationId: null });
    expect(parsed.conversationId).toBe(ID);
  });

  test("an error event fails the turn; no events is the no-wire fatal", () => {
    const errorEvent = JSON.stringify({
      kind: "AgentErrorEvent",
      source: "agent",
      error: "the model call failed",
    });
    const failed = parseOpenhandsSessionTurn(turn([errorEvent]), {
      knownConversationId: ID,
    });
    expect(failed.failed).toBe(true);
    expect(failed.failureReason).toContain("the model call failed");

    const noWire = parseOpenhandsSessionTurn("not json at all\n", { knownConversationId: ID });
    expect(noWire.noWire).toBe(true);
    expect(noWire.answer).toBeNull();
  });

  test("the turn's usage is the honest all-null block", () => {
    const parsed = parseOpenhandsSessionTurn(turn([agentEvent("x")]), {
      knownConversationId: ID,
    });
    expect(parsed.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
  });
});
