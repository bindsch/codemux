/**
 * The ledger descriptor rule (review round 147), split from
 * tests/call-log-reader.test.ts for the 500-line cap: both readers open
 * once, judge the descriptor, and read through it. readCallLog once opened
 * by name and statted separately, so an object swapped between the two was
 * validated as one thing and read as another.
 */

import { expect, spyOn, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCallLog, streamCallLog } from "../src/call-log.js";
import { BASE_RECORD, tempEnv } from "./helpers/call-log.js";
import * as fs from "node:fs";

test("the bounded reader validates and reads the same descriptor; a final symlink is refused like the stream (review round 147)", () => {
  const { dir, cleanup } = tempEnv();
  try {
    const path = join(dir, "calls.jsonl");
    writeFileSync(path, `${JSON.stringify(BASE_RECORD)}\n`);
    // A successful bounded read never stats the pathname: the type and the
    // size come from the descriptor it reads.
    const statSpy = spyOn(fs, "statSync");
    try {
      const read = readCallLog(path);
      expect(read.entries).toHaveLength(1);
      expect(statSpy).not.toHaveBeenCalled();
    } finally {
      statSpy.mockRestore();
    }
    const link = join(dir, "link.jsonl");
    symlinkSync(path, link);
    // A final symlink — refused by the stream since round 56 — is refused
    // by the bounded read too, never read through.
    expect(() => readCallLog(link)).toThrow("is not a regular file");
    expect(() => streamCallLog(link, () => {})).toThrow("is not a regular file");
    // The file behind the link is untouched and still reads.
    expect(readCallLog(path).entries).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("a small ledger that shrinks between the size check and the read yields only the bytes that arrived", () => {
  // The whole-file branch allocates the fstat size. A ledger truncated
  // after the fstat left the allocation's tail zero-filled, and decoding
  // all of it appended a line of NUL bytes. readSync is stubbed to stop
  // after the first record, exactly as a shrink would.
  const { dir, cleanup } = tempEnv();
  try {
    const path = join(dir, "calls.jsonl");
    const line = `${JSON.stringify(BASE_RECORD)}\n`;
    writeFileSync(path, line.repeat(3));
    const end = Buffer.byteLength(line);
    const realReadSync = fs.readSync;
    const spy = spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      if (typeof position !== "number") return realReadSync(fd, buffer, offset, length, position);
      if (position >= end) return 0;
      return realReadSync(fd, buffer, offset, Math.min(length, end - position), position);
    }) as typeof fs.readSync);
    try {
      const log = readCallLog(path);
      expect(log.truncated).toBe(false);
      expect(log.malformed).toBe(0);
      expect(log.entries).toHaveLength(1);
      expect(log.entries[0]!.line).not.toContain("\0");
    } finally {
      spy.mockRestore();
    }
  } finally {
    cleanup();
  }
});

test("a second pass refuses a ledger replaced between the passes (round 307)", () => {
  // `calls --since` reads the ledger twice. Both passes stopped at one
  // pinned byte, but each reopened the pathname, so an atomic replacement
  // between them — a rename putting a different inode at the same path —
  // let session ids collected from the first file admit records from the
  // second: one view built from two ledgers. The first pass answers the
  // identity it read; the second carries it and refuses a different file.
  const { dir, cleanup } = tempEnv();
  try {
    const path = join(dir, "calls.jsonl");
    writeFileSync(path, `${JSON.stringify(BASE_RECORD)}\n`);
    const first = streamCallLog(path, () => {});
    // The replacement: a rename lands a different inode at the path.
    const replacement = join(dir, "replacement.jsonl");
    writeFileSync(replacement, `${JSON.stringify({ ...BASE_RECORD, model: "other" })}\n`);
    fs.renameSync(replacement, path);
    expect(() =>
      streamCallLog(path, () => {}, { endAt: first.identity.size, identity: first.identity })
    ).toThrow("was replaced while being read");
    // Without the pin the same open reads the new file without complaint:
    // the refusal is the pin's, not the descriptor rule's.
    const fresh = streamCallLog(path, () => {});
    expect(fresh.identity.ino).not.toBe(first.identity.ino);
  } finally {
    cleanup();
  }
});
