import { describe, expect, test } from "bun:test";
import { MAX_INPUT_LINE_BYTES } from "../src/session/process.js";
import { harness } from "./helpers/session-process.js";

describe("session process runner", () => {
  test("stdin round-trip: writeLine frames, endInput closes", async () => {
    const { proc, lines, done } = harness("while IFS= read -r line; do echo \"got:$line\"; done");
    expect(proc.writeLine('{"type":"user"}')).toEqual({ ok: true });
    expect(proc.writeLine("second")).toEqual({ ok: true });
    proc.endInput();
    await done;
    expect(lines).toEqual(['got:{"type":"user"}', "got:second"]);
  });

  test("writeLine refuses framing violations and oversize lines without corrupting the stream", async () => {
    const { proc, lines, done } = harness("while IFS= read -r line; do echo \"got:$line\"; done");
    expect(proc.writeLine("with\nnewline")).toEqual({ ok: false, reason: "framing" });
    expect(proc.writeLine("with\0nul")).toEqual({ ok: false, reason: "framing" });
    expect(proc.writeLine("with\rcr")).toEqual({ ok: false, reason: "framing" });
    const oversize = "a".repeat(MAX_INPUT_LINE_BYTES + 1);
    expect(proc.writeLine(oversize)).toEqual({ ok: false, reason: "oversize" });
    // The rejections never touched the wire: the next write round-trips.
    expect(proc.writeLine("intact")).toEqual({ ok: true });
    proc.endInput();
    await done;
    expect(lines).toEqual(["got:intact"]);
  }, 20_000);

  test("writeLine refuses past the unread stdin backlog and recovers once the harness reads", async () => {
    // Review live19 (the class of the codex pre-handshake buffer): Bun's
    // pipe sink buffers every write a harness has not read, without
    // limit, so a harness that stopped reading let the caller grow
    // codemux's memory. The backlog is now bounded; the drivers treat
    // the refusal as a codemux fatal.
    const { proc, done } = harness("sleep 1; cat >/dev/null");
    const chunk = "a".repeat(1024 * 1024);
    const results: Array<string> = [];
    for (let index = 0; index < 80; index++) {
      const result = proc.writeLine(chunk);
      results.push(result.ok ? "ok" : (result.reason as string));
      if (!result.ok) break;
    }
    expect(results.at(-1)).toBe("backlog");
    expect(results.filter((entry) => entry === "ok").length).toBeLessThanOrEqual(64);
    // Once the harness drains the pipe, the next write is accepted.
    const deadline = Date.now() + 10_000;
    let recovered = proc.writeLine("small");
    while (!recovered.ok && Date.now() < deadline) {
      await Bun.sleep(50);
      recovered = proc.writeLine("small");
    }
    expect(recovered).toEqual({ ok: true });
    proc.endInput();
    await done;
  }, 20_000);

  test("writeLine after endInput reports closed", async () => {
    const { proc, lines, done } = harness("while IFS= read -r line; do echo \"got:$line\"; done");
    proc.endInput();
    expect(proc.writeLine("late")).toEqual({ ok: false, reason: "closed" });
    await done;
    expect(lines).toEqual([]);
  });

  test("a child dying while a large line still drains reports delivery failure without an unhandled rejection", async () => {
    const { proc, fatals, done } = harness("sleep 0.2; exit 0");
    expect(proc.writeLine("x".repeat(1024 * 1024))).toEqual({ ok: true });
    await done;
    await Bun.sleep(50);
    expect((await proc.exited).code).toBe(0);
    expect(fatals).toHaveLength(1);
    expect(fatals[0]!.kind).toBe("write-error");
  });
});
