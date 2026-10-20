import { mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ExperimentBridge } from "../../src/experiment-bridge.js";
import { ExperimentServer, type JsonObject } from "../../src/experiment-server.js";

/** A fake Claude Code peer around an ExperimentBridge, with the server mocked. */
export const dirs: string[] = [];
export const bridges: ExperimentBridge[] = [];
export const restores: (() => void)[] = [];
export async function cleanupPeers() {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const bridge of bridges.splice(0)) await bridge.close().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export type PeerOptions = { longCwd?: boolean; configDir?: boolean; spacedConfigDir?: boolean; ambientConfigDir?: boolean; symlinkCwd?: boolean;
  nfcCwd?: boolean; symlinkHome?: boolean; projectDirName?: string; tokenLimit?: number; truncationPrompt?: string; server?: string;
  newlineConfigDir?: boolean; delimiterConfigDir?: boolean; toolMeta?: JsonObject };
export function peer(options: PeerOptions = {}) {
  let home = mkdtempSync(join(tmpdir(), "codemux-protocol-"));
  dirs.push(home);
  if (options.symlinkHome) {
    // The child may see HOME with its symlinks resolved (scode resolves them),
    // so Claude spells the spill path with the real directory.
    const link = join(tmpdir(), `codemux-home-link-${basename(home)}`);
    symlinkSync(home, link);
    dirs.push(link);
    home = link;
  }
  let cwd = options.longCwd ? join(home, "a".repeat(100), "b".repeat(100)) : home;
  // A decomposed (NFD) directory name: Claude Code NFC-normalizes its cwd before slugging.
  if (options.nfcCwd) cwd = join(home, "cafe\u0301");
  mkdirSync(cwd, { recursive: true });
  if (options.symlinkCwd) {
    // The bridge is given the link; Claude Code slugs the resolved directory.
    mkdirSync(join(home, "real"));
    symlinkSync(join(home, "real"), join(home, "link"));
    cwd = join(home, "link");
  }
  // An ambient CLAUDE_CONFIG_DIR in codemux's environment never reaches the
  // child unless passed through, so only the explicit parameter counts.
  // A directory name may contain the very text that follows the path in Claude's messages.
  const configDir = options.spacedConfigDir ? join(home, "my profile's config") : options.newlineConfigDir ? join(home, "two\nlines")
    : options.delimiterConfigDir ? join(home, "p.\nFormat: Plain text\nq\n\nPreview (first 2KB):\nr") : join(home, "config");
  const explicit = options.configDir || options.spacedConfigDir || options.newlineConfigDir || options.delimiterConfigDir;
  const environment = { HOME: home, ...(explicit || options.ambientConfigDir ? { CLAUDE_CONFIG_DIR: configDir } : {}) };
  const claudeProject = { configDir: explicit ? configDir : join(home, ".claude"), projectDirName: options.projectDirName,
    tokenLimit: options.tokenLimit, truncationPrompt: options.truncationPrompt };
  const server = options.server ?? "experiment";
  const start = spyOn(ExperimentServer.prototype, "start").mockImplementation(() => {});
  restores.push(() => start.mockRestore());
  const request = spyOn(ExperimentServer.prototype, "request").mockImplementation(async (message) =>
    ({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "bash", ...(options.toolMeta ? { _meta: options.toolMeta } : {}) }] } }));
  restores.push(() => request.mockRestore());
  const bridge = new ExperimentBridge({ name: server, command: process.execPath, args: [], env: [],
    recording: join(home, "recordings") }, cwd, "probe", environment, claudeProject);
  bridges.push(bridge);
  const sent: JsonObject[] = [];
  const end = mock(() => {});
  bridge.start((line) => sent.push(JSON.parse(line)), end, () => {});
  const push = (frame: JsonObject) => bridge.push(JSON.stringify(frame) + "\n");
  const ack = () => push({ type: "control_response", response: { subtype: "success", request_id: sent[0]!.request_id } });
  const mcp = (id: string, message: JsonObject) => push({ type: "control_request", request_id: id,
    request: { subtype: "mcp_message", server_name: server, message: { jsonrpc: "2.0", ...message } } });
  const ready = async () => {
    mcp("list", { id: 1, method: "tools/list" });
    await new Promise((resolve) => setImmediate(resolve));
    ack();
    push({ type: "system", subtype: "init", tools: [`mcp__${server}__bash`] });
  };
  const result = () => push({ type: "result", result: "OK" });
  const call = (id: string, role = "assistant") => push({ type: role, message: { role,
    content: [{ type: "tool_use", id, name: `mcp__${server}__bash`, input: {} }] } });
  const invoke = (nativeId: string, rpcId: number) => mcp(`call-${rpcId}`, { id: rpcId, method: "tools/call",
    params: { name: "bash", arguments: {}, _meta: { "claudecode/toolUseId": nativeId } } });
  const delivered = (id: string, text: string, role = "user") => push({ type: role, message: { role,
    content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } });
  const records = () => readFileSync(bridge.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { bridge, sent, end, request, push, ack, mcp, ready, result, call, invoke, delivered, records, cwd, environment };
}
