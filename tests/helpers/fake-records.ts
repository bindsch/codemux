import { existsSync, readFileSync } from "node:fs";

/**
 * The JSONL records a session fake has written to `path` so far. A fake
 * appends one newline-terminated record at a time, and a poll can read a
 * long record before its write finishes (CI run 42759642305,
 * ubuntu-latest: "JSON Parse error: Unterminated string" in the codex
 * session e2e). Only the lines a newline already closed are records; the
 * unterminated tail is the write in flight and is read on the next poll.
 */
export function readFakeRecords<T = Record<string, any>>(path: string): T[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return text.slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}
