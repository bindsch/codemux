/**
 * The keg's docs-link containment check (review round 54): `..` and `../x`
 * escape the keg; a name that merely begins with two dots does not.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyDocsLinks } from "../scripts/check-installed-layout.js";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("a dot-dot-prefixed name inside the keg passes; a parent escape fails", () => {
  const keg = mkdtempSync(join(tmpdir(), "codemux-keg-links-"));
  scratch.push(keg);
  mkdirSync(join(keg, "libexec", "docs"), { recursive: true });
  mkdirSync(join(keg, "libexec", "..notes"), { recursive: true });
  writeFileSync(join(keg, "libexec", "..notes", "file.md"), "# notes\n");
  writeFileSync(join(keg, "outside.md"), "# outside the libexec\n");
  writeFileSync(join(keg, "libexec", "docs", "a.md"), "[inside](../..notes/file.md)\n");
  expect(verifyDocsLinks(keg)).toEqual([]);
  writeFileSync(join(keg, "libexec", "docs", "b.md"), "[escape](../../outside.md)\n");
  expect(verifyDocsLinks(keg).some((failure) => failure.includes("resolves outside the keg"))).toBe(true);
});
