/**
 * The run-path aider history read's own bound (review round 199): the
 * size check and the read used to be two looks at the file, so a writer
 * appending between them made the read exceed MAX_HISTORY_BYTES. The
 * read is bounded now — at most one byte past the bound is taken — and a
 * history that grew past the bound answers null. Split from
 * tests/aider-history.test.ts, which was at the 500-line cap.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";
import { MAX_HISTORY_BYTES, readAiderHistory } from "../src/aider-history.js";

describe("the run history read bounds the read itself", () => {
  test("a history that grows past the bound after the size check returns null", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-aider-bound-"));
    const path = join(dir, "history.md");
    const realFstat = fs.fstatSync as (fd: number, options?: unknown) => fs.Stats;
    // The seam: once the trusted open has sized the file as small, the
    // writer appends past the bound, so the read that follows sees a
    // file larger than the size check approved.
    const grow = spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: unknown) => {
      const stat = realFstat(fd, options);
      appendFileSync(path, Buffer.alloc(MAX_HISTORY_BYTES + 1024, 0x78));
      return stat;
    }) as typeof fs.fstatSync);
    try {
      writeFileSync(path, "#### q\n\nOK\n", { mode: 0o600 });
      expect(readAiderHistory(path)).toBeNull();
    } finally {
      grow.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a history at and under the bound still reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-aider-bound-ok-"));
    try {
      const path = join(dir, "history.md");
      writeFileSync(path, "#### q\n\nOK\n", { mode: 0o600 });
      expect(readAiderHistory(path)).toBe("#### q\n\nOK\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
