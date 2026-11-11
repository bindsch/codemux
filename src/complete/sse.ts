/**
 * A server-sent-events reader: splits a byte stream into event
 * blocks at a blank line, keeping each block's raw text (so an OpenAI
 * stream can retain its event text) beside its parsed `event` name and
 * joined `data` lines. Comment lines (`: …`) stay in the raw text and add
 * no data. A block larger than the bound is refused, so a misbehaving
 * upstream cannot grow memory without limit. A reader that stops early
 * (an error, or a consumer that breaks off) cancels the body, which closes
 * the upstream connection instead of leaving the provider generating.
 */

export interface SseEvent {
  /** The block as received, without the terminating blank line. */
  raw: string;
  event: string | null;
  /** The `data:` lines joined with "\n"; null when the block had none. */
  data: string | null;
}

export const MAX_SSE_EVENT_BYTES = 16 * 1024 * 1024;

export function parseSseBlock(raw: string): SseEvent {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of raw.split(/\r\n|[\r\n]/)) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value || null;
    else if (field === "data") data.push(value);
  }
  return { raw, event, data: data.length > 0 ? data.join("\n") : null };
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  // WHATWG HTML §9.2.6: strip exactly one initial BOM. Do it explicitly:
  // Bun 1.3's default TextDecoder mishandles BOMs across decode calls.
  // https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
  // This broker does not reconnect; id/retry fields remain in raw text only.
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let firstText = true;
  let buffer = "";
  let lineStart = 0;
  let rawEnd = 0;
  let scan = 0;
  let skipLf = false;
  const newline = /[\r\n]/g;
  const reader = body.getReader();
  let ended = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      ended = done;
      let text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (firstText && text.length > 0) {
        if (text.startsWith("\uFEFF")) text = text.slice(1);
        firstText = false;
      }
      buffer += text;
      for (;;) {
        // A CR ends a line immediately. Suppress its optional following LF,
        // even across reads, without delaying a CR-only event until more data.
        if (skipLf && scan < buffer.length) {
          if (buffer[scan] === "\n") {
            scan++;
            lineStart++;
            if (rawEnd === 0) {
              buffer = buffer.slice(scan);
              scan = lineStart = 0;
            }
          }
          skipLf = false;
        }
        newline.lastIndex = scan;
        const match = newline.exec(buffer);
        if (match === null) break;
        scan = match.index + 1;
        skipLf = match[0] === "\r";
        if (match.index === lineStart) {
          const raw = buffer.slice(0, rawEnd);
          checkSize(raw);
          buffer = buffer.slice(scan);
          scan = lineStart = rawEnd = 0;
          // Non-data blocks are retained for transparent comment forwarding.
          // data:null is not a dispatched message; data:"" is an empty message.
          if (raw !== "") yield parseSseBlock(raw);
        } else {
          rawEnd = match.index;
          lineStart = scan;
        }
      }
      scan = buffer.length;
      checkSize(buffer.slice(0, lineStart === buffer.length ? rawEnd : buffer.length));
      if (done) break;
    }
    // EOF is not a blank line: discard an unfinished event.
  } finally {
    if (!ended) {
      try {
        await reader.cancel();
      } catch {
        // A body that already failed has nothing left to cancel.
      }
    }
    reader.releaseLock();
  }
}

function checkSize(raw: string): void {
  if (Buffer.byteLength(raw) > MAX_SSE_EVENT_BYTES) {
    throw new Error(`an upstream stream event exceeded ${MAX_SSE_EVENT_BYTES} bytes`);
  }
}
