/**
 * The shared turn engine's caller-facing edges (turn-driver.ts), driven
 * at the driver level over the synthetic rig: the input acknowledgements
 * (malformed, undeliverable, empty, mid-drain), the tier-3 fatals from
 * the process layer, the caller-stdin end arms, the outbound queue's
 * failure classes, the default stdout sink, and the signal path.
 */

import { expect, spyOn, test } from "bun:test";
import { MAX_ARGV_PROMPT_BYTES } from "../src/process-runner.js";
import { MAX_INPUT_LINE_BYTES } from "../src/session/process.js";
import {
  engineSession,
  fakeTurnProcess,
  wireProfile,
} from "./helpers/session-turn-engine.js";

const waitCode = async (session: ReturnType<typeof engineSession>): Promise<number> => {
  const code = await session.code();
  session.dispose();
  return code;
};

test("a line that is not JSON is acknowledged malformed", async () => {
  const session = engineSession();
  session.send("this is not json");
  // The queue flushes asynchronously; the acknowledgement is an event.
  const ack = await session.until((event) => event.type === "input_rejected");
  expect(ack).toMatchObject({ reason: "malformed" });
  session.shutdown();
  expect(await waitCode(session)).toBe(0);
});

test("an argv carrier refuses a prompt past the argv bound", async () => {
  const session = engineSession({
    options: { profile: { ...wireProfile(), promptCarrier: "argv" } },
  });
  session.user("x".repeat(MAX_ARGV_PROMPT_BYTES + 1));
  expect(await session.until((event) => event.type === "input_rejected")).toMatchObject({
    reason: "text_too_long",
  });
  session.shutdown();
  expect(await waitCode(session)).toBe(0);
});

test("a stdin carrier refuses a prompt past the line bound", async () => {
  const session = engineSession(); // the synthetic profile carries stdin
  session.user("x".repeat(MAX_INPUT_LINE_BYTES + 1));
  expect(await session.until((event) => event.type === "input_rejected")).toMatchObject({
    reason: "text_too_long",
  });
  session.shutdown();
  expect(await waitCode(session)).toBe(0);
});

test("a blank prompt is refused unsupported before any turn", async () => {
  const session = engineSession();
  session.user("   ");
  expect(await session.until((event) => event.type === "input_rejected")).toMatchObject({
    reason: "unsupported",
  });
  expect(session.events.find((event) => event.type === "turn_started")).toBeUndefined();
  session.shutdown();
  expect(await waitCode(session)).toBe(0);
});

test("a line during the drain window is acknowledged shutting_down", async () => {
  // The drain window is the finish() body between its first await and
  // settled: a spawn still pending at shutdown holds it open (the late
  // child the end path then adopts and answers).
  const late = fakeTurnProcess();
  let release!: (proc: typeof late) => void;
  const session = engineSession({
    options: {
      spawnTurn: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
  });
  session.user();
  session.shutdown();
  session.user("late");
  expect(await session.until((event) => event.type === "input_rejected")).toMatchObject({
    reason: "shutting_down",
  });
  release(late);
  late.exit(0);
  const ended = await session.wait("session_ended");
  expect(ended).toMatchObject({ reason: "shutdown", exit_code: 0 });
  expect(await waitCode(session)).toBe(0);
});

test("handleFatal reports a handler throw as codemux's own defect", async () => {
  const session = engineSession();
  const noted: string[] = [];
  const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    noted.push(values.map(String).join(" "));
  });
  try {
    session.fatal({ kind: "handler", error: new Error("handler blew up"), bytes: 5 });
    const fatal = await session.until((event) => event.type === "error" && event.fatal === true);
    expect(fatal).toMatchObject({ source: "codemux" });
    expect(fatal.message).toContain("handler blew up");
    expect(noted.join("\n")).toContain("codemux:");
    expect(await waitCode(session)).toBe(1);
  } finally {
    error.mockRestore();
  }
});

test("handleFatal reports unusable bytes as a harness defect", async () => {
  const session = engineSession();
  session.fatal({ kind: "invalid-utf8", excerpt: "�", bytes: 2 });
  const fatal = await session.until((event) => event.type === "error" && event.fatal === true);
  expect(fatal).toMatchObject({ source: "harness" });
  expect(fatal.message).toContain("unusable harness output (invalid-utf8, 2 bytes)");
  expect(await waitCode(session)).toBe(1);
});

test("the caller closing stdin ends the session cleanly, and with an error it ends fatal", async () => {
  const clean = engineSession();
  clean.close();
  const ended = await clean.wait("session_ended");
  expect(ended).toMatchObject({ reason: "stdin-close", exit_code: 0 });
  expect(await waitCode(clean)).toBe(0);

  const broken = engineSession();
  broken.close(new Error("broken pipe"));
  const fatal = await broken.until((event) => event.type === "error" && event.fatal === true);
  expect(fatal.message).toContain("broken pipe");
  expect(await waitCode(broken)).toBe(1);
});

test("a close during the drain reports the failure without a second fatal; after the end it only notes it", async () => {
  const session = engineSession();
  session.shutdown();
  session.close(new Error("late pipe break"));
  const ended = await session.wait("session_ended");
  expect(ended).toMatchObject({ reason: "shutdown" });
  const fatals = session.events.filter((event) => event.type === "error" && event.fatal === true);
  expect(fatals).toHaveLength(0);
  expect(await waitCode(session)).toBe(0);
  // After the end, nothing follows session_ended: only a stderr note.
  const noted: string[] = [];
  const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    noted.push(values.map(String).join(" "));
  });
  try {
    session.close(new Error("post-end pipe break"));
    expect(noted.join("\n")).toContain("post-end pipe break");
  } finally {
    error.mockRestore();
  }
});

test("a second run() on a live session breaks the announcement contract; after the end it just returns", async () => {
  const session = engineSession();
  session.shutdown();
  await session.wait("session_ended");
  // run() after finish: the same done promise, no new events.
  await expect(session.driver.run()).resolves.toBe(0);

  const live = engineSession();
  const error = await live.driver.run().then(() =>
    live.until((event) => event.type === "error" && event.fatal === true)
  );
  expect(error.message).toContain("session");
  expect(await waitCode(live)).toBe(1);
});

test("a sink that fails ends the session through the queue's error arm", async () => {
  const proc = fakeTurnProcess();
  const session = engineSession({
    options: { spawnTurn: async () => proc },
    sink: async () => {
      throw new Error("EPIPE");
    },
  });
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    session.user();
    proc.exit(1);
    expect(await session.code()).toBe(1);
  } finally {
    error.mockRestore();
    session.dispose();
  }
});

test("an idle event flood overruns the queue's bound and ends the session", async () => {
  const blocked = Promise.withResolvers<void>();
  const delivered: Record<string, unknown>[] = [];
  const session = engineSession({ sink: async (line) => {
    await blocked.promise;
    delivered.push(JSON.parse(line) as Record<string, unknown>);
  } });
  const noted: string[] = [];
  const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    noted.push(values.map(String).join(" "));
  });
  try {
    // Hold every entry until the event bound breaches. Resume the sink
    // afterward to verify the crash event without waiting out the final
    // flush budget, which the queue tests exercise independently.
    for (let index = 0; index < 1100; index += 1) {
      session.send("not json");
    }
    expect(noted.join("\n")).toContain("overran its bounds");
    blocked.resolve();
    expect(await session.code()).toBe(1);
    expect(delivered.at(-1)).toMatchObject({ type: "session_ended", reason: "crash", exit_code: 1 });
  } finally {
    blocked.resolve();
    error.mockRestore();
    session.dispose();
  }
});

test("the default sink writes one JSONL line per event on stdout", async () => {
  const written: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation(((
    chunk: Uint8Array | string,
    callback?: (error: Error | null) => void
  ) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    if (typeof callback === "function") callback(null);
    return true;
  }) as typeof process.stdout.write);
  const session = engineSession({ sink: null });
  // An explicit undefined picks the default sink (the fixture's own
  // capture is bypassed), so the assertion reads the spied stdout.
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(written.join("")).toContain("\"session_started\"");
    session.shutdown();
    expect(await session.code()).toBe(0);
    expect(written.at(-1)).toContain("\"session_ended\"");
  } finally {
    write.mockRestore();
    session.dispose();
  }
});

test("the default sink's write failure ends the session through the error arm", async () => {
  const write = spyOn(process.stdout, "write").mockImplementation(((
    _chunk: Uint8Array | string,
    callback?: (error: Error | null) => void
  ) => {
    if (typeof callback === "function") callback(new Error("stdout gone"));
    return true;
  }) as typeof process.stdout.write);
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const session = engineSession({ sink: null });
    expect(await session.code()).toBe(1);
  } finally {
    write.mockRestore();
    error.mockRestore();
  }
});

test("dispose tears the session down without ending it", () => {
  const session = engineSession();
  expect(() => session.dispose()).not.toThrow();
});
