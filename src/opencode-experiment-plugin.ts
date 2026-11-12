import { readOpencodeResponseModel, servedOpencodeResponseModel } from "./opencode-provider-response.js";

export const OPENCODE_EVIDENCE_HEADER = "x-codemux-experiment-evidence";

export interface OpencodeExperimentHooks {
  "chat.headers": (input: { sessionID: string; agent?: string }, output: { headers: Record<string, string> }) => Promise<void>;
  "tool.execute.before": (input: { tool: string; sessionID: string; callID: string }, output: { args: unknown }) => Promise<void>;
  dispose: () => Promise<void>;
}

/** Read 2026-11-09, bin/opencode 1.19.5: plugin.trigger("chat.headers",...)
 * and trigger("tool.execute.before",{...,callID:...},{args:...}) expose these
 * hooks. Its provider fetch wrapper uses `let d=t??fetch` at dispatch time.
 * Source: session/llm/request.ts, session/tools.ts, provider/provider.ts.
 * Serialized into the owned plugin without dependencies. The marker joins
 * native model turns to their final fetch payload. It is removed locally and
 * never reaches the provider; authorization headers are never recorded. */
export function installOpencodeExperimentObserver(runtime: { fetch: typeof fetch },
  record: (kind: string, fields: Record<string, unknown>) => void,
  marker = "x-codemux-experiment-evidence",
  readResponseModel?: (response: Response) => Promise<string | null>, requestTimeoutMs = 30_000): OpencodeExperimentHooks {
  const maxRequestBytes = 16 * 1024 * 1024;
  const readRequest = async (request: Request): Promise<string> => {
    const reader = request.clone().body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = []; let bytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("OpenCode request body observation timed out")), requestTimeoutMs); });
    try {
      for (;;) {
        const part = await Promise.race([reader.read(), expired]);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxRequestBytes) throw new Error("OpenCode request body exceeds 16 MiB");
        chunks.push(part.value);
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
  };
  const original = runtime.fetch;
  let sequence = 0;
  const pending = new Set<string>();
  const modelReads = new Set<Promise<void>>();
  const observed = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const id = headers.get(marker);
    if (id === null) return original(input, init);
    if (!pending.has(id)) throw new Error("OpenCode experiment received an unknown provider request marker");
    headers.delete(marker);
    let body = init?.body;
    if (body === undefined && input instanceof Request) body = await readRequest(input);
    if (typeof body !== "string" || Buffer.byteLength(body) > maxRequestBytes) {
      throw new Error("OpenCode experiment provider body is missing or exceeds 16 MiB");
    }
    const payload = JSON.parse(body);
    record("provider_request", { request_id: id, payload });
    // Rebuild Request as well as init so the removed marker has no carrier.
    const target = input instanceof Request ? new Request(input, { headers }) : input;
    if (target instanceof Request) target.headers.delete(marker);
    let response: Response;
    try { response = await original(target, { ...init, headers }); }
    catch (error) { record("provider_response", { request_id: id, status: 0 }); throw error; }
    record("provider_response", { request_id: id, status: response.status });
    if (response.ok && readResponseModel) {
      const reading = readResponseModel(response).then((model) => {
        record("provider_model", { request_id: id, served_model: model });
      });
      modelReads.add(reading);
      void reading.then(() => modelReads.delete(reading), () => modelReads.delete(reading));
    }
    return response;
  };
  runtime.fetch = observed as typeof fetch;
  return {
    async "chat.headers"(input, output) {
      const id = String(++sequence);
      pending.add(id);
      record("model_turn", { request_id: id, session_id: input.sessionID,
        ...(input.agent === undefined ? {} : { agent: input.agent }) });
      output.headers[marker] = id;
    },
    async "tool.execute.before"(input, output) {
      record("tool_call", { call_id: input.callID, name: input.tool, input: output.args, session_id: input.sessionID });
    },
    async dispose() {
      if (runtime.fetch === observed) runtime.fetch = original;
      await Promise.allSettled(modelReads);
    },
  };
}

export function opencodeExperimentPluginSource(evidencePath: string): string {
  return `import { appendFileSync } from "node:fs";\n` +
    `const servedOpencodeResponseModel = ${servedOpencodeResponseModel.toString()};\n` +
    `const readOpencodeResponseModel = ${readOpencodeResponseModel.toString()};\n` +
    `const install = ${installOpencodeExperimentObserver.toString()};\n` +
    `export default async function () { let bytes = 0; return install(globalThis, (kind, fields) => {\n` +
    ` const line = JSON.stringify({kind, fields, t:Date.now()/1000}) + "\\n";\n` +
    ` bytes += Buffer.byteLength(line); if (bytes > 32*1024*1024) throw new Error("OpenCode experiment evidence exceeds 32 MiB");\n` +
    ` appendFileSync(${JSON.stringify(evidencePath)}, line, {mode:0o600});\n` +
    ` }, undefined, readOpencodeResponseModel); }\n`;
}
