import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { physicalLineCount } from "../scripts/check-source-coverage.js";

// Lane C4 rule: a source file over 500 lines is a split waiting to happen,
// so none is allowed. Lines are counted as a reader counts them: a final
// line without a trailing newline still counts. Lane C4 covered src/ and
// scripts/; lane C4b extends the same rule to tests/ (test files, helpers,
// and fixtures alike).
const LIMIT = 500;

test("every .ts file under src/, scripts/, and tests/ stays under 500 lines", async () => {
  const offenders: string[] = [];
  const found: Record<string, number> = {};
  for (const root of ["src", "scripts", "tests"]) {
    const glob = new Bun.Glob("**/*.ts");
    for await (const path of glob.scan({ cwd: root, onlyFiles: true, dot: true })) {
      found[root] = (found[root] ?? 0) + 1;
      const lines = physicalLineCount(await Bun.file(`${root}/${path}`).text());
      if (lines > LIMIT) offenders.push(`${root}/${path}: ${lines} lines`);
    }
    // A root the glob silently could not scan would pass vacuously.
    expect(found[root]).toBeGreaterThan(0);
  }
  expect(offenders).toEqual([]);
});

test("no test file hides under tests/scratch (bun discovers it there)", async () => {
  // `root = "tests"` bounds discovery to tests/ but nothing inside it: a
  // `*.test.ts` left under tests/scratch joins a bare `bun test` run and
  // the gate (review round 11, edges 12). Bun has no ignore list for
  // test discovery, so the invariant is asserted here instead.
  const found: string[] = [];
  if (existsSync("tests/scratch")) {
    const glob = new Bun.Glob("**/*.test.ts");
    for await (const path of glob.scan({ cwd: "tests/scratch", onlyFiles: true, dot: true })) {
      found.push(path);
    }
  }
  expect(found).toEqual([]);
});
