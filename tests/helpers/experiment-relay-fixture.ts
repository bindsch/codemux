/** The relay test fixture shared by tests/experiment-relay*.test.ts. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { ExperimentHttpRelay } from "../../src/experiment-relay.js";
import { readRelayHttpResponse } from "../experiment-relay-http.js";

const relays: ExperimentHttpRelay[] = [];
const directories: string[] = [];
export async function cleanupRelays(): Promise<void> {
  for (const relay of relays.splice(0)) await relay.close().catch(() => {});
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
}

export async function setup(script?: string, options: { catalog?: { body: string } } = {}) {
  mkdirSync("scratch", { recursive: true });
  const cwd = mkdtempSync(resolve("scratch/relay-test-"));
  directories.push(cwd);
  const relay = new ExperimentHttpRelay({ name: "experiment", command: process.execPath,
    args: ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`,
      ...(script ? ["-e", script] : [resolve("tests/fixtures/experiment-mcp.ts")])], env: [], recording: join(cwd, "recordings") }, cwd, {}, options);
  relays.push(relay);
  relay.resolveCallId = async (call) => `native-${call.relay_index}`;
  await relay.start();
  return relay;
}
export function records(relay: ExperimentHttpRelay): any[] {
  return readFileSync(relay.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}
export function http(relay: ExperimentHttpRelay, body: string, options: {
  method?: string; path?: string; token?: string | null; headers?: Record<string, string>;
} = {}) {
  const url = new URL(options.path ?? "/mcp", relay.url);
  const req = httpRequest(url, { method: options.method ?? "POST", headers: {
    ...(options.token === null ? {} : { Authorization: options.token ?? `Bearer ${relay.token}` }),
    "Content-Type": "application/json", ...options.headers,
  } });
  const response = readRelayHttpResponse(req);
  req.end(body);
  return response;
}
export const rpc = (id: number, method: string, params?: object) => JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
export async function list(relay: ExperimentHttpRelay) { return http(relay, rpc(1, "tools/list")); }

