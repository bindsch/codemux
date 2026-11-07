/**
 * The opencode stale-home sweep's removal revalidation (review round 292):
 * the sweep enumerated a writable parent and then removed entries with a
 * bare recursive rm, so a parent swapped for a symlink after the record
 * aimed the removal into a same-named directory outside codemux's storage
 * tree. The removal now goes through the shared trusted-parent check.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertTrustedParentUnchanged, recordTrustedParent } from "../src/safe-remove.js";
import { sweepStaleHomes } from "../src/opencode-hermetic.js";

describe("opencode hermetic - stale-home sweep (review round 292)", () => {
  test("a parent swapped for a symlink after the record never receives the removal", () => {
    const root = mkdtempSync(join(tmpdir(), "cmx-ocsw-"));
    try {
      const parent = join(root, "data", ".codemux-hermetic");
      mkdirSync(parent, { recursive: true });
      const stale = join(parent, "run-999999999-gone");
      mkdirSync(stale);
      writeFileSync(join(stale, "f"), "old");
      const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
      utimesSync(join(stale, "f"), threeDaysAgo, threeDaysAgo);
      utimesSync(stale, threeDaysAgo, threeDaysAgo);
      const record = recordTrustedParent(parent);
      // The swap a run with write access to the data directory could make
      // between the record and the removal: the real parent moves away and
      // a symlink to a victim tree takes its path.
      const moved = join(root, "data", "parent-moved");
      renameSync(parent, moved);
      const victim = join(root, "victim");
      const victimChild = join(victim, "run-999999999-gone");
      mkdirSync(victimChild, { recursive: true });
      writeFileSync(join(victimChild, "marker.txt"), "kept\n");
      utimesSync(victimChild, threeDaysAgo, threeDaysAgo);
      symlinkSync(victim, parent);
      const errors: string[] = [];
      const realError = console.error;
      console.error = ((message: string) => errors.push(String(message))) as typeof console.error;
      try {
        sweepStaleHomes(parent, record);
      } finally {
        console.error = realError;
      }
      // The victim's same-named home survived, the refusal was reported,
      // and the moved parent's entry was never removed through the link.
      expect(readdirSync(victimChild)).toEqual(["marker.txt"]);
      expect(errors.join("\n")).toContain("opencode:");
      expect(errors.join("\n")).toContain("the directory was kept");
      expect(readdirSync(moved)).toEqual(["run-999999999-gone"]);
      // And the home creation that follows the sweep refuses the swapped
      // parent instead of making a directory through it (review round 295).
      expect(() => assertTrustedParentUnchanged(record, "the hermetic home parent"))
        .toThrow("was replaced after it was recorded; refusing to use it");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
