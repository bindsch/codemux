/** Read only a provider's response body. Request models and OpenCode's selected
 * model are not evidence. This function is self-contained for plugin embedding. */
export function servedOpencodeResponseModel(body: string, contentType: string): string | null {
  const maxBytes = 16 * 1024 * 1024;
  if (typeof body !== "string" || typeof contentType !== "string" ||
      body.length > maxBytes || Buffer.byteLength(body) > maxBytes) return null;
  type ObjectValue = Record<string, unknown>;
  type Family = "chat" | "responses" | "anthropic" | "google";
  const object = (value: unknown): ObjectValue | null =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
  const model = (value: unknown): string | null => typeof value === "string" &&
    value.length > 0 && value.length <= 512 && value.trim() === value && !/[\s\u0000-\u001f\u007f]/u.test(value) ? value : null;
  // JSON.parse silently keeps the last duplicate field. Check decoded keys so
  // an escaped second spelling cannot replace a conflicting served model.
  const parse = (text: string): unknown => {
    const value: unknown = JSON.parse(text);
    const stack: Array<{ keys: Set<string>; key: boolean } | null> = [];
    const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g;
    let match: RegExpExecArray | null;
    while ((match = tokens.exec(text)) !== null) {
      const token = match[0];
      const top = stack.at(-1);
      if (token === "{" || token === "[") {
        if (stack.length >= 64) throw new Error("Response nesting exceeds bound");
        stack.push(token === "{" ? { keys: new Set(), key: true } : null);
      } else if (token === "}" || token === "]") stack.pop();
      else if (token === ":" && top) top.key = false;
      else if (token === "," && top) top.key = true;
      else if (token.startsWith('"') && top?.key) {
        const key = JSON.parse(token) as string;
        if (top.keys.has(key)) throw new Error("Response has a duplicate field");
        top.keys.add(key);
      }
    }
    return value;
  };
  const familyOf = (value: ObjectValue): Family | null => {
    const googleFields = value.candidates !== undefined || value.promptFeedback !== undefined;
    if (value.type === undefined && !googleFields) {
      if (["chat.completion", "chat.completion.chunk", "text_completion"].includes(String(value.object)) &&
          Array.isArray(value.choices)) return "chat";
      if (value.object === "response" && Array.isArray(value.output)) return "responses";
    }
    if (value.object !== undefined) return null;
    if (value.type === "message" && !googleFields && value.role === "assistant" && Array.isArray(value.content)) return "anthropic";
    if (value.type === undefined && (Array.isArray(value.candidates) || object(value.promptFeedback))) return "google";
    return null;
  };
  const responseModel = (value: ObjectValue, family: Family): string | null => {
    if (value.error !== undefined && value.error !== null) return null;
    // Distinct provider model fields in one envelope are ambiguous, even when
    // their current strings agree. Never fall back to a request-model field.
    if (family === "google") return value.model === undefined ? model(value.modelVersion) : null;
    return value.modelVersion === undefined ? model(value.model) : null;
  };
  try {
    const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
    if (mediaType === "application/json" || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType)) {
      const value = object(parse(body));
      if (!value) return null;
      const family = familyOf(value);
      return family === null ? null : responseModel(value, family);
    }
    if (mediaType !== "text/event-stream") return null;
    let family: Family | null = null;
    let served: string | null = null;
    let finished = false;
    let googleFinished = false;
    let events = 0;
    let eventName = "";
    let data: string[] = [];
    let hasData = false;
    const accept = (nextFamily: Family, value?: ObjectValue): boolean => {
      if (family !== null && family !== nextFamily) return false;
      family = nextFamily;
      if (!value) return true;
      const next = responseModel(value, nextFamily);
      if (next === null || (served !== null && served !== next)) return false;
      served = next;
      return true;
    };
    const dispatch = (): boolean => {
      if (!hasData) { eventName = ""; return true; }
      if (finished || ++events > 65_536) return false;
      const text = data.join("\n");
      data = []; hasData = false;
      const name = eventName; eventName = "";
      if (text === "[DONE]") {
        if (name !== "" && name !== "message") return false;
        if (family !== "chat" || served === null) return false;
        finished = true; return true;
      }
      const value = object(parse(text));
      if (!value || value.error !== undefined) return false;
      const directFamily = familyOf(value);
      if (directFamily === "chat") {
        if (name !== "" && name !== "message") return false;
        return accept("chat", value);
      }
      if (directFamily === "google") {
        if (name !== "" && name !== "message") return false;
        // Google may omit modelVersion on intermediate chunks. A supplied
        // invalid value still poisons the evidence; no requested model is used.
        if (!accept("google", value.modelVersion === undefined ? undefined : value)) return false;
        if (value.model !== undefined) return false;
        googleFinished = Array.isArray(value.candidates) && value.candidates.length > 0 &&
          value.candidates.every((candidate) => {
            const reason = object(candidate)?.finishReason;
            return typeof reason === "string" && reason.length > 0;
          });
        return true;
      }
      const type = value.type;
      if (typeof type !== "string" || (name !== "" && name !== "message" && name !== type)) return false;
      if (value.model !== undefined || value.modelVersion !== undefined) return false;
      if (type === "message_start") {
        const message = object(value.message);
        return message !== null && familyOf(message) === "anthropic" && accept("anthropic", message);
      }
      if (["content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop", "ping"].includes(type)) {
        if (value.model !== undefined || value.message !== undefined || value.response !== undefined) return false;
        if (type === "ping" && family === null) return true;
        if (family !== "anthropic" || served === null) return false;
        if (type === "message_stop") finished = true;
        return true;
      }
      if (["response.created", "response.in_progress", "response.completed"].includes(type)) {
        const response = object(value.response);
        if (!response || familyOf(response) !== "responses" || !accept("responses", response)) return false;
        if (type === "response.completed") {
          if (response.status !== "completed") return false;
          finished = true;
        }
        return true;
      }
      const deltaTypes = ["response.output_item.added", "response.output_item.done", "response.content_part.added",
        "response.content_part.done", "response.output_text.delta", "response.output_text.done",
        "response.refusal.delta", "response.refusal.done", "response.function_call_arguments.delta",
        "response.function_call_arguments.done", "response.reasoning_summary_part.added",
        "response.reasoning_summary_part.done", "response.reasoning_summary_text.delta",
        "response.reasoning_summary_text.done", "response.reasoning_text.delta", "response.reasoning_text.done"];
      return deltaTypes.includes(type) && family === "responses" && served !== null &&
        value.model === undefined && value.response === undefined && value.message === undefined;
    };
    // Handle LF, CRLF, and bare CR. An SSE data event is dispatched only by an
    // empty line; an unterminated final event must not become evidence.
    const newlines = /\r\n|\r|\n/g;
    let offset = body.startsWith("\uFEFF") ? 1 : 0;
    let lineCount = 0;
    let newline: RegExpExecArray | null;
    while ((newline = newlines.exec(body)) !== null) {
      if (++lineCount > 262_144) return null;
      const line = body.slice(offset, newline.index);
      offset = newlines.lastIndex;
      if (line === "") { if (!dispatch()) return null; continue; }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") { hasData = true; data.push(value); }
      else if (field === "event") eventName = value;
      else if (field !== "id" && field !== "retry") return null;
    }
    if (hasData || offset !== body.length) return null;
    // Google terminates by EOF; its final candidate carries finishReason.
    // A model-bearing partial stream alone is not sufficient evidence.
    if (family === "google") finished = googleFinished;
    return finished ? served : null;
  } catch { return null; }
}

/** Clone before reading so native consumption stays unchanged. The timer and
 * byte cap bound observation; tee cancellation must never await its sibling. */
export async function readOpencodeResponseModel(response: Response,
  parse = servedOpencodeResponseModel,
  options: { maxBytes?: number; timeoutMs?: number } = {}): Promise<string | null> {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024 ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000 || !response.ok) return null;
  let reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock"> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let complete = false;
  try {
    const copy = response.clone();
    if (!copy.body) return null;
    const activeReader = copy.body.getReader();
    reader = activeReader;
    const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let body = "";
    while (true) {
      const part = await Promise.race([activeReader.read(), deadline]);
      if (part === null) return null;
      if (part.done) { complete = true; break; }
      bytes += part.value.byteLength;
      if (bytes > maxBytes) return null;
      body += decoder.decode(part.value, { stream: true });
    }
    body += decoder.decode();
    return parse(body, copy.headers.get("content-type") ?? "");
  } catch { return null; }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    if (reader && !complete) void reader.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
