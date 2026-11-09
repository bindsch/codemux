/**
 * The native evidence reader for a goose experiment run: the session
 * ledger goose itself writes. Installed goose 1.50.1, read 2026-11-09
 * from ~/.local/bin/goose (Mach-O strings):
 *
 * - The ledger is SQLite. The doctor panel names "Sessions DB (sqlite):"
 *   beside `sessions.db` (offset 123940854); the schema creates `sessions`
 *   and `messages` (offset 123919335), and every agent turn inserts
 *   `INSERT INTO messages (message_id, session_id, role, content_json,
 *   created_timestamp, metadata_json)` (offset 123916287). On a stock
 *   install the file sits at `~/.local/share/goose/sessions/sessions.db`
 *   (with its -wal/-shm sidecars), so under a redirected GOOSE_PATH_ROOT
 *   it is `<root>/.../sessions/sessions.db`; the reader walks the private
 *   root for it instead of pinning the exact subpath (src/goose-hermetic.ts
 *   owns the redirect).
 * - `content_json` carries the message content blocks. The wire vocabulary
 *   is the internally tagged enum MessageContentBlock: text, image,
 *   document, toolRequest, toolResponse, thinking, … (offset 126846069).
 *   A toolRequest block names the tool and its arguments; a toolResponse
 *   block carries the result the model saw. The exact nested field names
 *   are not spelled in the binary, so the reader accepts the shapes the
 *   struct evidence supports — a nested `toolCall`/`toolResult` object or
 *   the same fields inline — and every match is strict about identity:
 *   ambiguous or contradictory records fail the run, never guess.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Database } from "bun:sqlite";
import { ExperimentFailure, ExperimentFailureCode as Code, type ExperimentRecord } from "./experiment-records.js";
import type { ExperimentRelayCall } from "./experiment-relay.js";
import type { JsonObject } from "./experiment-server.js";

/** bun:sqlite, not node:sqlite: the pinned runtime floor (Bun 1.3.14) has
 * no node:sqlite, and this module must not break adapter loading
 * (src/opencode-remote-config.ts:51, same rule). */

export interface GooseLedgerCall { id: string; name: string; input: unknown }
export interface GooseLedgerResponse { id: string; content: unknown; isError: boolean }
export interface GooseLedger { calls: GooseLedgerCall[]; responses: GooseLedgerResponse[] }

/** The private root is small and freshly minted; the walk stays bounded
 * anyway so a hostile layout cannot stall the launch. */
const MAX_WALK_DIRECTORIES = 1024;
const MAX_WALK_ENTRIES = 256;

/** Finds `sessions/sessions.db` under the private root, or null while
 * goose has not created it yet (the poll loop retries). */
export function findGooseSessionLedger(root: string): string | null {
  let visited = 0;
  const walk = (directory: string, depth: number): string | null => {
    if (depth > 3 || ++visited > MAX_WALK_DIRECTORIES) return null;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries.slice(0, MAX_WALK_ENTRIES)) {
      if (entry.isFile() && entry.name === "sessions.db") return join(directory, entry.name);
    }
    for (const entry of entries.slice(0, MAX_WALK_ENTRIES)) {
      // Symlinks are not followed: the private root owns every path in it.
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const found = walk(join(directory, entry.name), depth + 1);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return walk(root, 0);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** One toolRequest block: the native tool-call identity. Accepts the tool
 * call nested under `toolCall` or inline; the id is the block's own id
 * (or the nested call's), and either way it must be a nonempty string. */
function ledgerCall(block: Record<string, unknown>): GooseLedgerCall | null {
  const nested = recordValue(block.toolCall);
  const id = typeof (nested ?? block).id === "string" ? (nested ?? block).id as string
    : typeof block.toolCallId === "string" ? block.toolCallId : null;
  const name = (nested ?? block).name;
  if (id === null || id.trim() === "" || typeof name !== "string") return null;
  return { id, name, input: (nested ?? block).arguments };
}

/** One toolResponse block: the result the model saw, linked to the call. */
function ledgerResponse(block: Record<string, unknown>): GooseLedgerResponse | null {
  const nested = recordValue(block.toolResult);
  const id = typeof block.id === "string" ? block.id : typeof block.toolCallId === "string" ? block.toolCallId : null;
  if (id === null || id.trim() === "") return null;
  return {
    id,
    content: (nested ?? block).content,
    isError: (nested ?? block).isError === true,
  };
}

/** Reads every message row's content blocks from the ledger database.
 * An absent database or a missing table reads as an empty ledger: the
 * caller decides whether that is fatal (complete) or not yet (poll). */
export function readGooseSessionLedger(databasePath: string): GooseLedger {
  const ledger: GooseLedger = { calls: [], responses: [] };
  let database: Database | undefined;
  try {
    database = new Database(databasePath, { readonly: true });
    const rows = database.prepare("SELECT role, content_json FROM messages ORDER BY id").all() as Array<{ role: string; content_json: string }>;
    for (const row of rows) {
      let content: unknown;
      try {
        content = JSON.parse(row.content_json);
      } catch {
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const block = recordValue(part);
        if (block === null || typeof block.type !== "string") continue;
        if (block.type === "toolRequest") {
          const call = ledgerCall(block);
          if (call !== null) ledger.calls.push(call);
        } else if (block.type === "toolResponse") {
          const response = ledgerResponse(block);
          if (response !== null) ledger.responses.push(response);
        }
      }
    }
  } catch {
    // A locked or mid-write database reads empty this round; the poll
    // retries, and complete() re-reads before verifying.
  } finally {
    database?.close();
  }
  return ledger;
}

export interface GooseExperimentLedgerSource {
  spec: { name: string };
  calls: readonly ExperimentRelayCall[];
  record: ExperimentRecord;
}

/** Joins the relay's probe-side records to the ledger's native records.
 * Every relay call must appear once with its claimed native identity and
 * arguments, the model must have received the server's exact result, and
 * a native call to a probe tool the relay never saw fails the run. */
export function verifyGooseExperimentLedger(ledger: GooseLedger, source: GooseExperimentLedgerSource): void {
  const toolNames = new Set(source.calls.map((call) => call.name));
  for (const call of source.calls) {
    if (!call.call_id || !call.result) {
      throw new ExperimentFailure(Code.CallIdUnresolved, "Goose experiment has an incomplete relay call");
    }
  }
  const claimed = new Set(source.calls.map((call) => call.call_id as string));
  for (const call of ledger.calls) {
    if (!toolNames.has(call.name)) continue;
    if (!claimed.has(call.id)) {
      throw new ExperimentFailure(Code.CallIdUnresolved, "Goose ledger names a probe tool call the relay never saw");
    }
  }
  for (const call of source.calls) {
    const native = ledger.calls.filter((entry) => entry.id === call.call_id);
    if (native.length !== 1 || native[0]!.name !== call.name || !isDeepStrictEqual(native[0]!.input, call.input)) {
      throw new ExperimentFailure(Code.CallIdUnresolved, "Goose ledger tool call does not match relay identity and arguments");
    }
    const response = ledger.responses.filter((entry) => entry.id === call.call_id);
    if (response.length !== 1 || !isDeepStrictEqual(response[0]!.content, call.result!.content) ||
        response[0]!.isError !== (call.result!.isError === true)) {
      throw new ExperimentFailure(Code.ResultChanged, "Goose ledger result differs from server bytes");
    }
    source.record("goose_ledger_evidence", {
      call_id: call.call_id, name: call.name,
      input: call.input as JsonObject, content: call.result!.content,
    });
  }
}

/** Retains the ledger's raw bytes before the private home is removed. */
export function gooseLedgerBytes(databasePath: string | null, maxBytes: number): string {
  if (databasePath === null) return "";
  try {
    const buffer = readFileSync(databasePath);
    return buffer.subarray(0, maxBytes).toString("base64");
  } catch {
    return "";
  }
}
