import { closeSync, constants, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readUtf8FileBounded } from "./file-io.js";
import { timestampValid } from "./calendar.js";
import { object } from "./experiment-codex-content.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";
import type { JsonObject } from "./experiment-server.js";

const MAX_ROLLOUT_BYTES = 256 * 1024 * 1024;
const MAX_SESSION_ENTRIES = 10_000;
const SESSION_DATE_DEPTH = 3;
const READ_CHUNK_BYTES = 64 * 1024;

/** RolloutLine flattens RolloutItemWire's snake_case type and payload fields. */
export function findRollout(codexHome: string, threadId: string | undefined, required: boolean): string | undefined {
  const sessions = join(codexHome, "sessions");
  const expected = join(sessions, "YYYY", "MM", "DD", `rollout-<timestamp>-${threadId ?? "<thread-id>"}.jsonl`);
  const matches: string[] = [];
  let entries = 0;
  const visit = (dir: string, depth: number): void => {
    let children;
    try { children = readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required) return; throw error; }
    for (const entry of children) {
      if (++entries > MAX_SESSION_ENTRIES) throw new Error(`Codex rollout search exceeds ${MAX_SESSION_ENTRIES} entries under ${sessions}`);
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < SESSION_DATE_DEPTH) visit(path, depth + 1);
      if (entry.isFile() && new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${threadId ?? "[A-Za-z0-9-]+"}(?:_[A-Za-z0-9-]+)?\\.jsonl$`).test(entry.name)) {
        matches.push(path);
      }
    }
  };
  try { visit(sessions, 0); }
  catch (error) { throw new ExperimentFailure(Code.HarnessLogMissing, `Cannot locate Codex rollout ${expected}: ${String(error)}`); }
  if (matches.length > 1) throw new ExperimentFailure(Code.HarnessLogMissing, `Found multiple Codex rollouts for ${threadId} under ${sessions}`);
  if (!matches.length && required) throw new ExperimentFailure(Code.HarnessLogMissing, `Missing Codex rollout ${expected}`);
  return matches[0];
}

/** One append-only cursor frames live bytes and consumes the final consistency read. */
export class CodexRolloutCursor {
  path?: string;
  private offset = 0;
  private partial = "";
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private digest = createHash("sha256");
  private lineCount = 0;
  private sessionSeen = false;

  constructor(private readonly home: string, private readonly threadId: string,
    private readonly accept: (line: JsonObject) => void) {}

  poll(): void {
    this.path ??= findRollout(this.home, this.threadId, false);
    if (!this.path) return;
    let fd: number | undefined;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error("not a regular file");
      if (stat.size > MAX_ROLLOUT_BYTES) throw new Error(`exceeds ${MAX_ROLLOUT_BYTES} bytes`);
      if (stat.size < this.offset) throw new Error("rollout changed or shrank during the run");
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      while (this.offset < stat.size) {
        const count = readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - this.offset), this.offset);
        if (count === 0) break;
        this.consume(chunk.subarray(0, count));
      }
    } catch (error) { this.invalid(error); }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  finish(): string {
    const path = findRollout(this.home, this.threadId, true)!;
    if (this.path && this.path !== path) throw new ExperimentFailure(Code.HarnessLogMissing, "Codex rollout path changed during the run");
    this.path = path;
    try {
      const text = readUtf8FileBounded(path, { maxBytes: MAX_ROLLOUT_BYTES, label: `Codex rollout ${path}`, noFollow: true });
      const bytes = Buffer.from(text);
      if (bytes.length < this.offset || createHash("sha256").update(bytes.subarray(0, this.offset)).digest("hex") !== this.digest.copy().digest("hex")) {
        throw new Error("rollout changed after live records were emitted");
      }
      this.consume(bytes.subarray(this.offset));
      this.partial += this.decoder.decode();
      if (this.partial || !text.endsWith("\n")) throw new Error("incomplete JSONL record");
      if (!this.sessionSeen) throw new Error("session_meta does not match the exec thread id");
      return path;
    } catch (error) { return this.invalid(error); }
  }

  private consume(bytes: Buffer): void {
    this.offset += bytes.length;
    this.digest.update(bytes);
    try { this.partial += this.decoder.decode(bytes, { stream: true }); }
    catch { throw new Error("must contain valid UTF-8"); }
    let newline: number;
    while ((newline = this.partial.indexOf("\n")) !== -1) {
      const raw = this.partial.slice(0, newline);
      this.partial = this.partial.slice(newline + 1);
      this.lineCount++;
      const value = object(JSON.parse(raw));
      if (!value || typeof value.type !== "string" || !object(value.payload) ||
          typeof value.timestamp !== "string") {
        throw new Error(`invalid RolloutLine at line ${this.lineCount}`);
      }
      // Date.parse alone normalizes a nonexistent calendar date to the
      // next real one, recording evidence under a different instant
      // (review round 64), and reads a timestamp without a zone in the
      // host's zone, so the same evidence named different instants on
      // different hosts (review round 265): the RFC 3339 rule applies.
      if (!timestampValid(value.timestamp)) {
        throw new Error(`RolloutLine timestamp '${value.timestamp}' at line ${this.lineCount} is not a real calendar instant`);
      }
      if (value.type === "session_meta") {
        if (this.sessionSeen || value.payload.id !== this.threadId) throw new Error("session_meta does not match the exec thread id");
        this.sessionSeen = true;
      } else if (!this.sessionSeen) throw new Error("session_meta must precede rollout events");
      this.accept(value);
    }
  }

  private invalid(error: unknown): never {
    if (error instanceof ExperimentFailure) throw error;
    throw new ExperimentFailure(Code.HarnessLogMissing, `Invalid Codex rollout ${this.path}: ${String(error)}`);
  }
}
