import { describe, expect, test } from "bun:test";
import { readOpencodeResponseModel, servedOpencodeResponseModel as served } from "../src/opencode-provider-response.js";

const chat = (model: unknown = "served-chat") => ({ object: "chat.completion", model, choices: [] });
const response = (model: unknown = "served-response") => ({ object: "response", model, output: [], status: "completed" });
const message = (model: unknown = "served-message") => ({ type: "message", role: "assistant", model, content: [] });
const google = (modelVersion: unknown = "served-google") => ({ modelVersion, candidates: [{ finishReason: "STOP" }] });
const json = (value: unknown, contentType = "application/json") => served(JSON.stringify(value), contentType);
const frame = (value: unknown, name?: string) => `${name === undefined ? "" : `event: ${name}\n`}data: ${JSON.stringify(value)}\n\n`;
const stream = (...frames: string[]) => served(frames.join(""), "text/event-stream; charset=utf-8");
const done = "data: [DONE]\n\n";
const start = () => frame({ type: "message_start", message: message() }, "message_start");
const stop = () => frame({ type: "message_stop" }, "message_stop");
const created = () => frame({ type: "response.created", response: response() }, "response.created");
const completed = () => frame({ type: "response.completed", response: response() }, "response.completed");

describe("OpenCode provider response JSON evidence", () => {
  test.each([
    [chat(), "served-chat"], [{ ...chat(), object: "text_completion" }, "served-chat"],
    [response(), "served-response"], [message(), "served-message"], [google(), "served-google"],
    [{ modelVersion: "served-google", promptFeedback: { blockReason: "SAFETY" } }, "served-google"],
  ])("reads only native response shape %#", (value, expected) => expect(json(value)).toBe(expected));

  test.each(["application/json; charset=utf-8", "APPLICATION/JSON", "application/vnd.provider+json"])("supports media type %s", (type) => {
    expect(json(chat(), type)).toBe("served-chat");
  });

  test.each([null, [], {}, { model: "requested" }, { model: "requested", messages: [] },
    { model: "requested", input: [] }, { model: "requested", contents: [] },
    { ...message(), role: "user" }, { ...chat(), choices: {} }, { ...response(), output: null },
    { ...chat(), candidates: [] }, { ...chat(), modelVersion: "another" }, { ...google(), model: "another" },
    { ...chat(), error: { message: "failed" } }, { message: message() },
    { ...google(), object: "response" }, { ...google(), type: "message_start", message: message() },
    { ...message(), candidates: "malformed" }, { ...chat(), type: "future-response" },
  ].map((value) => [value]))("rejects unproved or ambiguous model %#", (value) => expect(json(value)).toBeNull());

  test.each([undefined, null, 1, {}, [], "", " ", " bad", "bad ", "bad\nmodel", "bad\u007fmodel", "x".repeat(513)].map((value) => [value]))("rejects invalid model %#", (value) => {
    expect(json({ ...chat(), model: value })).toBeNull();
  });

  test.each(["", "text/plain", "application/x-ndjson", "application/jsonp"])("rejects unsupported content type %s", (type) => {
    expect(json(chat(), type)).toBeNull();
  });

  test("rejects malformed, duplicate, deep and oversized JSON", () => {
    expect(served('{"model":', "application/json")).toBeNull();
    expect(served('{"object":"chat.completion","choices":[],"model":"first","model":"second"}', "application/json")).toBeNull();
    expect(served('{"object":"chat.completion","choices":[],"model":"first","mo\\u0064el":"first"}', "application/json")).toBeNull();
    expect(served('{"object":"chat.completion","choices":[],"model":"first","metadata":{"a":1,"a":2}}', "application/json")).toBeNull();
    expect(served(`${JSON.stringify(chat()).slice(0, -1)},"nested":${"[".repeat(65)}0${"]".repeat(65)}}`, "application/json")).toBeNull();
    expect(json({ ...chat(), padding: "x".repeat(16 * 1024 * 1024) })).toBeNull();
    expect(json({ ...chat(), padding: "é".repeat(9 * 1024 * 1024) })).toBeNull();
    expect(json({ ...chat(), metadata: { a: [1, { a: true }, null], b: "a\\\"b" } })).toBe("served-chat");
  });
});

describe("OpenCode provider SSE evidence", () => {
  test.each(["\n", "\r\n", "\r"])("handles line ending %# and SSE metadata", (ending) => {
    const body = `\uFEFF: keepalive\nid: 1\nretry: 25\nevent: message\n${frame({ ...chat(), object: "chat.completion.chunk" })}${done}`;
    expect(stream(body.replaceAll("\n", ending))).toBe("served-chat");
  });

  test("handles multiline data and bounded matching chat chunks", () => {
    const multiline = 'data: {"object":"chat.completion.chunk",\ndata: "model":"served-chat","choices":[]}\n\n';
    expect(stream(multiline, frame(chat()), done, ": finished\n\n")).toBe("served-chat");
    expect(stream(frame(chat()), "event: message\n", done)).toBe("served-chat");
  });

  test("handles native Anthropic events without taking model from content", () => {
    expect(stream(frame({ type: "ping" }), start(), frame({ type: "content_block_start", content_block: { model: "untrusted-text" } }),
      frame({ type: "content_block_delta", delta: { text: "model: requested" } }), frame({ type: "content_block_stop" }),
      frame({ type: "message_delta" }), frame({ type: "ping" }), stop())).toBe("served-message");
  });

  test("handles native Responses events and consistent lifecycle models", () => {
    expect(stream(created(), frame({ type: "response.in_progress", response: response() }),
      frame({ type: "response.output_item.added", item: { model: "untrusted" } }),
      frame({ type: "response.output_text.delta", delta: "text" }), completed())).toBe("served-response");
  });

  test("handles Google complete streams and omitted intermediate modelVersion", () => {
    expect(stream(frame({ ...google(), candidates: [{ content: { parts: [{ text: "hello" }] } }] }),
      frame({ candidates: [{ content: { parts: [{ text: "world" }] } }] }), frame(google()))).toBe("served-google");
    expect(stream(frame({ candidates: [] }), frame(google()))).toBe("served-google");
  });

  test.each([
    "", done, frame(chat()), `${frame(chat())}data: [DONE]`, `${frame(chat())}data: [DONE]\n`,
    `${frame(chat())}${done}trailing`, `${frame(chat())}${done}${frame(chat())}`,
    `${frame(chat())}${done}${done}`, `${frame(chat())}data: malformed\n\n${done}`,
    `${frame(chat())}data: []\n\n${done}`, `${frame(chat())}data\n\n${done}`,
    `${frame(chat())}other: ignored\n\n${done}`, frame(chat(), "unknown") + done,
    `${frame(chat())}event: unknown\n${done}`, `${frame(chat())}data: {"error": {}}\n\n${done}`,
    frame(chat()) + frame(chat("other")) + done, frame(chat()) + frame(chat(null)) + done,
    start(), start() + frame({ type: "message_stop" }, "message_delta"), start() + frame({ type: "future_event", model: "injected" }) + stop(),
    frame({ type: "message_start", message: {} }) + stop(), frame({ type: "message_stop" }),
    start() + frame({ type: "message_delta", model: "different" }) + stop(),
    start() + frame({ type: "message_delta", message: {} }) + stop(),
    frame({ type: "message_start", message: message(), model: "different" }) + stop(),
    start() + frame({ type: "message_start", message: message("other") }) + stop(),
    created(), completed().replace('"completed"}', '"in_progress"}'),
    created() + frame({ type: "response.completed", response: {} }),
    created() + frame({ type: "response.output_text.delta", response: response("other") }) + completed(),
    frame({ type: "response.output_text.delta" }) + completed(),
    created() + frame({ type: "response.failed" }) + completed(),
    created() + frame({ type: "response.completed", response: response("other") }),
    frame({ ...google(), candidates: [] }), frame({ candidates: [{ finishReason: "STOP" }] }),
    frame({ ...google(), candidates: [{ finishReason: "" }] }),
    frame(google()) + frame(google("other")), frame({ ...google(), model: "requested" }),
    frame(google()) + done, frame(chat()) + start() + stop(), created() + start() + stop(),
    frame(google()) + created() + completed(),
    frame({ ...google(), object: "response" }),
    frame({ ...google(), type: "message_start", message: message() }) + stop(),
  ])("rejects incomplete, malformed, unknown or mixed stream %#", (body) => expect(stream(body)).toBeNull());

  test("bounds event and line count independently of body bytes", () => {
    expect(stream(frame(chat()).repeat(65_537), done)).toBeNull();
    expect(stream(":\n".repeat(262_145), frame(chat()), done)).toBeNull();
  });
});

describe("OpenCode bounded provider response reader", () => {
  const nativeResponse = (body: ConstructorParameters<typeof Response>[0], status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });

  test("reads a clone and preserves the native response body", async () => {
    const body = JSON.stringify(chat());
    const native = nativeResponse(body);
    expect(await readOpencodeResponseModel(native)).toBe("served-chat");
    expect(await native.text()).toBe(body);
  });

  test("handles split UTF-8 bytes without replacement", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(chat("served-é")));
    const split = bytes.indexOf(0xc3) + 1;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close();
    } });
    expect(await readOpencodeResponseModel(nativeResponse(body))).toBe("served-é");
  });

  test.each([{ maxBytes: 0 }, { maxBytes: 16 * 1024 * 1024 + 1 }, { maxBytes: 1.5 },
    { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 30_001 }])("refuses invalid reader bounds %#", async (options) => {
    expect(await readOpencodeResponseModel(nativeResponse(JSON.stringify(chat())), served, options)).toBeNull();
  });

  test("fails closed on status, missing body, consumed body and parser failure", async () => {
    expect(await readOpencodeResponseModel(nativeResponse(JSON.stringify(chat()), 500))).toBeNull();
    expect(await readOpencodeResponseModel(nativeResponse(null))).toBeNull();
    const consumed = nativeResponse(JSON.stringify(chat())); await consumed.text();
    expect(await readOpencodeResponseModel(consumed)).toBeNull();
    expect(await readOpencodeResponseModel(nativeResponse(JSON.stringify(chat())), () => { throw new Error("parse failed"); })).toBeNull();
    expect(await readOpencodeResponseModel(new Response(JSON.stringify(chat())))).toBeNull();
  });

  test("rejects byte overflow without awaiting cancellation of the native tee", async () => {
    const native = nativeResponse(JSON.stringify(chat()));
    expect(await readOpencodeResponseModel(native, served, { maxBytes: 4 })).toBeNull();
    expect(await native.text()).toBe(JSON.stringify(chat()));
  });

  test("rejects malformed UTF-8 and failed streams", async () => {
    expect(await readOpencodeResponseModel(nativeResponse(new Uint8Array([0xc3])))).toBeNull();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("stream failed")); } });
    expect(await readOpencodeResponseModel(nativeResponse(body))).toBeNull();
  });

  test("bounds an idle stream and leaves its native branch readable", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const native = nativeResponse(body);
    expect(await readOpencodeResponseModel(native, served, { timeoutMs: 5 })).toBeNull();
    controller.enqueue(new TextEncoder().encode(JSON.stringify(chat()))); controller.close();
    expect(await native.text()).toBe(JSON.stringify(chat()));
  });

  test("both functions can be embedded without module bindings", async () => {
    const embedded = new Function(`const servedOpencodeResponseModel = ${served.toString()}; return ${readOpencodeResponseModel.toString()};`)() as typeof readOpencodeResponseModel;
    expect(await embedded(nativeResponse(JSON.stringify(message())))).toBe("served-message");
  });
});
