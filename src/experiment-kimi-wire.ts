import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readUtf8FileBounded } from "./file-io.js";
import { kimiObject } from "./experiment-kimi-content.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";
import { MAX_KIMI_WIRE_BYTES } from "./kimi-wire-log.js";
import type { JsonObject } from "./experiment-server.js";

const MAX_SESSION_ENTRIES = 10_000;
const READ_CHUNK_BYTES = 64 * 1024;

export function discoverKimiWireLog(home: string, required: boolean): string | undefined {
  const root = join(home, "sessions");
  let entries = 0;
  const children = (path: string) => {
    try {
      const found = readdirSync(path, { withFileTypes: true });
      entries += found.length;
      if (entries > MAX_SESSION_ENTRIES) throw new Error(`search exceeds ${MAX_SESSION_ENTRIES} entries`);
      return found;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  try {
    const matches: string[] = [];
    for (const workspace of children(root).filter((entry) => entry.isDirectory())) {
      const directory = join(root, workspace.name);
      for (const session of children(directory).filter((entry) => entry.isDirectory() && entry.name.startsWith("session_"))) {
        const agent = join(directory, session.name, "agents");
        if (!children(agent).some((entry) => entry.isDirectory() && entry.name === "main")) continue;
        const main = join(agent, "main");
        if (children(main).some((entry) => entry.isFile() && entry.name === "wire.jsonl")) matches.push(join(main, "wire.jsonl"));
      }
    }
    if (matches.length > 1) throw new Error("multiple main-agent wire logs found");
    if (required && !matches.length) throw new Error("missing main-agent wire log");
    return matches[0];
  } catch (error) {
    throw new ExperimentFailure(Code.HarnessLogMissing, `Cannot locate Kimi wire log under ${root}: ${String(error)}`);
  }
}

/** Frames append-only wire bytes and checks the complete reread before accepting completion. */
export class KimiWireCursor {
  path?: string;
  private offset = 0;
  private partial = "";
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private digest = createHash("sha256");
  private line = 0;
  /** Decoded byte count: the quantity the final read re-encodes and compares.
   * `offset` stays the raw read position for readSync and the size check. */
  private decoded = 0;

  constructor(private readonly home: string, private readonly accept: (line: JsonObject) => void) {}

  poll(): void {
    this.path ??= discoverKimiWireLog(this.home, false);
    if (!this.path) return;
    let fd: number | undefined;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error("not a regular file");
      if (stat.size > MAX_KIMI_WIRE_BYTES) throw new Error(`exceeds ${MAX_KIMI_WIRE_BYTES} bytes`);
      if (stat.size < this.offset) throw new Error("wire log changed or shrank during the run");
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      while (this.offset < stat.size) {
        const count = readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - this.offset), this.offset);
        if (!count) break;
        this.consume(chunk.subarray(0, count));
      }
    } catch (error) { this.invalid(error); }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  finish(explicitPath?: string): string {
    const path = discoverKimiWireLog(this.home, true)!;
    if ((explicitPath && explicitPath !== path) || (this.path && this.path !== path)) {
      throw new ExperimentFailure(Code.HarnessLogMissing, "Kimi wire log path changed or does not match the discovered session");
    }
    this.path = path;
    try {
      const value = readUtf8FileBounded(path, { maxBytes: MAX_KIMI_WIRE_BYTES, label: `Kimi wire log ${path}`, noFollow: true });
      const bytes = Buffer.from(value);
      if (bytes.length < this.decoded || createHash("sha256").update(bytes.subarray(0, this.decoded)).digest("hex") !== this.digest.copy().digest("hex")) {
        throw new Error("wire log changed after live evidence was emitted");
      }
      this.consume(bytes.subarray(this.decoded));
      this.partial += this.decoder.decode();
      if (this.partial || !value.endsWith("\n")) throw new Error("incomplete JSONL record");
      return path;
    } catch (error) { return this.invalid(error); }
  }

  private consume(bytes: Buffer): void {
    this.offset += bytes.length;
    const text = this.decoder.decode(bytes, { stream: true });
    // Hash what finish() compares (round 391, item 2): the final read decodes
    // first, and the decoder strips a leading BOM, so hashing raw read bytes
    // made a BOM-prefixed wire log always fail the tamper check. Valid UTF-8
    // re-encodes byte-identically, so the decoded text is one quantity on
    // both sides.
    const encoded = Buffer.from(text);
    this.decoded += encoded.length;
    this.digest.update(encoded);
    this.partial += text;
    let newline: number;
    while ((newline = this.partial.indexOf("\n")) !== -1) {
      const raw = this.partial.slice(0, newline);
      this.partial = this.partial.slice(newline + 1);
      this.line++;
      const value = kimiObject(JSON.parse(raw));
      if (!value || typeof value.type !== "string") throw new Error(`invalid wire record at line ${this.line}`);
      this.accept(value);
    }
  }

  private invalid(error: unknown): never {
    if (error instanceof ExperimentFailure) throw error;
    throw new ExperimentFailure(Code.HarnessLogMissing, `Invalid Kimi wire log ${this.path}: ${String(error)}`);
  }
}
