import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonObject } from "../../src/experiment-server.js";
import { peer, type PeerOptions } from "./experiment-peer.js";

// 3,000 lines of 18 characters and 23 bytes: 57,000 characters, past the 50,000-character result cap
// and the token estimate (round(57,000 / 4) = 14,250 > 12,500) that make Claude spill.
export const spillText = "﻿browser output \u{1F30D}\n".repeat(3000);
export const SESSION = "37088a82-b0d8-4aa7-a212-e4694a8cd920"; // Claude Code session ids are UUIDs

export async function spillPeer(options: PeerOptions = {}, content: JsonObject[] = [{ type: "text", text: spillText }]) {
  const p = peer(options);
  await p.ready();
  p.request.mockResolvedValue({ jsonrpc: "2.0", id: 10, result: { content } });
  p.call("first");
  p.invoke("first", 10);
  await Promise.resolve();
  const slug = options.projectDirName ?? realpathSync(p.cwd).normalize("NFC").replace(/[^A-Za-z0-9]/g, "-");
  const home = options.symlinkHome ? realpathSync(p.environment.HOME) : p.environment.HOME;
  // Past 200 characters Claude appends the base-36 absolute value of its 32-bit string hash of the cwd.
  const canonical = realpathSync(p.cwd).normalize("NFC");
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) hash = ((hash << 5) - hash + canonical.charCodeAt(i)) | 0;
  const project = join(options.configDir || options.spacedConfigDir || options.newlineConfigDir || options.delimiterConfigDir ? p.environment.CLAUDE_CONFIG_DIR! : join(home, ".claude"), "projects",
    slug.length > 200 ? `${slug.slice(0, 200)}-${Math.abs(hash).toString(36)}` : slug);
  const path = join(project, SESSION, "tool-results", "mcp-experiment-bash-1792387031137.txt");
  mkdirSync(dirname(path), { recursive: true });
  const deliver = (content: unknown, is_error?: boolean) => p.push({ type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "first", content, is_error },
  ] } });
  return { ...p, path, project, deliver };
}
