/** WHATWG HTML §9.2.5–6, including every possible byte-chunk split. */
import { describe, expect, test } from "bun:test";
import { readSse, type SseEvent } from "../src/complete/sse.js";

const cases: [string, string, (string | null)[], (string | null)[]][] = [
  ["LF", "data: a\n\ndata: b\n\n", ["a", "b"], [null, null]],
  ["CR", "data: a\r\rdata: b\r\r", ["a", "b"], [null, null]],
  ["CRLF", "data: a\r\n\r\ndata: b\r\n\r\n", ["a", "b"], [null, null]],
  ["mixed endings", "data: a\rdata: b\r\n\ndata: c\n\r", ["a\nb", "c"], [null, null]],
  ["initial BOM", "\uFEFFdata: 界🌍\r\n\r\n", ["界🌍"], [null]],
  ["only one BOM removed", "\uFEFF\uFEFFdata: ignored\n\ndata: ok\n\n", [null, "ok"], [null, null]],
  ["later BOM retained", "data: a\n\n\uFEFFdata: ignored\ndata: \uFEFFb\n\n", ["a", "\uFEFFb"], [null, null]],
  ["comments", ": comment\rdata: a\r: data: ignored\r\r", ["a"], [null]],
  ["comment-only block", ": heartbeat\n\n", [null], [null]],
  ["colonless data", "data\n\n", [""], [null]],
  ["colonless event resets type", "event: custom\nevent\ndata: x\n\n", ["x"], [null]],
  ["first colon only", "data:a:b\n\n", ["a:b"], [null]],
  ["one leading space removed", "data:  a\n\n", [" a"], [null]],
  ["tabs retained", "data:\ta\n\n", ["\ta"], [null]],
  ["trailing spaces retained", "data: a \n\n", ["a "], [null]],
  ["empty data", "data:\n\n", [""], [null]],
  ["empty space data", "data: \n\n", [""], [null]],
  ["multiline empty data", "data\ndata:\ndata: \n\n", ["\n\n"], [null]],
  ["literal field names", "Data: no\n data: no\ndata: yes\n\n", ["yes"], [null]],
  ["ignored fields", "unknown: x\nid: a\nid: bad\0id\nretry: 5\nretry: nope\ndata: yes\n\n", ["yes"], [null]],
  ["last event field wins", "event: a\nevent: b\ndata: x\n\n", ["x"], ["b"]],
  ["event resets after dispatch", "event: a\ndata: x\n\ndata: y\n\n", ["x", "y"], ["a", null]],
  ["event resets without data", "event: a\n\ndata: x\n\n", [null, "x"], ["a", null]],
  ["blank lines", "\n\r\n\rdata: a\n\n\n", ["a"], [null]],
  ["EOF after field", "data: unfinished", [], []],
  ["EOF after single LF", "data: unfinished\n", [], []],
  ["EOF after single CR", "data: unfinished\r", [], []],
  ["EOF after single CRLF", "data: unfinished\r\n", [], []],
  ["EOF discards only final event", "data: ok\n\ndata: unfinished\n", ["ok"], [null]],
];

describe("SSE interpretation", () => {
  for (const [rule, source, data, types] of cases) {
    test(rule, async () => {
      const bytes = new TextEncoder().encode(source);
      for (let split = 0; split <= bytes.length; split++) {
        const body = new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(bytes.slice(0, split));
          controller.enqueue(bytes.slice(split));
          controller.close();
        } });
        const events: SseEvent[] = [];
        for await (const event of readSse(body)) events.push(event);
        expect(events.map((event) => event.data)).toEqual(data);
        expect(events.map((event) => event.event)).toEqual(types);
      }
    });
  }
  test("CR dispatch does not wait for another chunk, and early return cancels", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: ready\r\r")); },
      cancel() { canceled = true; },
    });
    const reader = readSse(body);
    expect((await reader.next()).value?.data).toBe("ready");
    await reader.return(undefined);
    expect(canceled).toBe(true);
    expect(body.locked).toBe(false);
  });
  test("invalid UTF-8 uses replacement decoding", async () => {
    const body = new Response(Uint8Array.from([...new TextEncoder().encode("data: "), 255, 10, 10])).body!;
    const events = [];
    for await (const event of readSse(body)) events.push(event.data);
    expect(events).toEqual(["�"]);
  });
});
