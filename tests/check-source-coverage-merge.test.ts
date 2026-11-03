/**
 * Repeated LCOV records for one file (review round 54): a summary-only
 * record's LH/FNH is a floor that a later detailed record never lowers.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSourceFiles, evaluateCoverage } from "../scripts/check-source-coverage.ts";

function fixtureTree(): string {
  const cwd = mkdtempSync(join(tmpdir(), "codemux-cov-merge-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, "scripts"), { recursive: true });
  // Nine physical lines, two runtime functions.
  writeFileSync(join(cwd, "src", "loaded.ts"), "export function a(): number {\n  return 1;\n}\n\nexport function b(): number {\n  return 2;\n}\n");
  writeFileSync(join(cwd, "src", "low.ts"), "export function c(): number {\n  return 3;\n}\n");
  writeFileSync(join(cwd, "src", "run-context.ts"), "export interface RunContext {\n  value?: string;\n}\n");
  writeFileSync(join(cwd, "src", "index.ts"), "import \"./loaded.js\";\nawait Promise.resolve();\n");
  writeFileSync(join(cwd, "scripts", "tool.ts"), "console.log(\"tool\");\n");
  return cwd;
}

function record(path: string, lf: number, lh: number, fnf: number, fnh: number): string {
  return `SF:${path}\nLF:${lf}\nLH:${lh}\nFNF:${fnf}\nFNH:${fnh}\nend_of_record\n`;
}

describe("repeated lcov records", () => {
  test("a summary-only record's LH is a floor a later detailed record never lowers", async () => {
    const cwd = fixtureTree();
    try {
      const files = await collectSourceFiles(cwd);
      // First a summary (8 of 9 lines hit), then a detailed record naming
      // two hit lines: the file is at least 8 of 9 covered, never 2 of 9.
      const summary = record("src/loaded.ts", 9, 8, 1, 1);
      const detailed = `SF:src/loaded.ts\nFN:1,run\nFNDA:1,run\nFNF:1\nFNH:1\nDA:1,1\nDA:2,1\nLF:9\nLH:2\nend_of_record\n`;
      const verdict = evaluateCoverage(
        [summary, detailed, record("src/low.ts", 3, 3, 1, 1), record("src/index.ts", 2, 2, 0, 0), record("scripts/tool.ts", 1, 1, 0, 0)].join(""),
        files
      );
      expect(verdict.floorBreaches).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
