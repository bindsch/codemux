/**
 * The type-only waiver's third guard (review round 151), split from
 * tests/check-source-coverage.test.ts for the 500-line cap: a waived file
 * must carry no top-level runtime statement at all — the function and
 * value-export guards alone let `const cache = initialize()`, a
 * side-effect import, and a class static block through. Direct rows over
 * runtimeStatementCount, one gate-level row through runCheck, and the
 * real waived file.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runtimeStatementCount } from "../scripts/coverage-export-guards.js";
import { runCheck } from "../scripts/check-source-coverage.js";

const ROOT = resolve(import.meta.dir, "..");

test("a top-level runtime statement counts one, an erased statement counts zero (round 151)", () => {
  const cases: [string, number][] = [
    // Runtime behavior the two existing guards never counted.
    ["const cache = initialize();\n", 1],
    ['import "./side-effect.js";\n', 1],
    ["class Tool {\n  static {\n    register();\n  }\n}\n", 1],
    ['import { value } from "./x.js";\n', 1],
    ["initialize();\n", 1],
    ["let counter = 0;\n", 1],
    ['import * as ns from "./x.js";\n', 1],
    ['import Default from "./x.js";\n', 1],
    ['import { type A, value } from "./x.js";\n', 1],
    ["export { value };\n", 1],
    ['export * from "./x.js";\n', 1],
    ["export default 1;\n", 1],
    // Erased by the compiler: the waiver's reason to exist.
    ['import type { A } from "./a.js";\n', 0],
    ['import { type A } from "./a.js";\n', 0],
    ['import { type A, type B } from "./a.js";\n', 0],
    ['import type Default from "./a.js";\n', 0],
    ['export type { A } from "./a.js";\n', 0],
    ["export { type A };\n", 0],
    ["interface A {}\n", 0],
    ["type B = string;\n", 0],
    ["declare const c: number;\n", 0],
    ["declare module \"m\" {\n  const d: number;\n}\n", 0],
    [";\n", 0],
    ["\n", 0],
  ];
  for (const [body, count] of cases) {
    expect(runtimeStatementCount(body, "src/run-context.ts")).toBe(count);
  }
});

test("a type-only waiver that gains a top-level runtime statement fails the gate (round 151)", async () => {
  // The gate-level row: runCheck judges the waived file before the
  // ratios, but its lcov parse still needs one record to gate on.
  const cwd = mkdtempSync(join(tmpdir(), "codemux-cov-gate-"));
  try {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "loaded.ts"), "export function a(): number {\n  return 1;\n}\n");
    writeFileSync(
      join(cwd, "src", "run-context.ts"),
      "const cache = initialize();\n\nexport interface RunContext {\n  value?: string;\n}\n"
    );
    const lcov = "SF:src/loaded.ts\nLF:3\nLH:3\nFNF:1\nFNH:1\nend_of_record\n";
    await expect(runCheck(cwd, lcov)).rejects.toThrow(
      "type-only waiver no longer holds for src/run-context.ts: the file now carries 1 runtime statement(s)"
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the waived file itself still carries no runtime statement", async () => {
  const content = await Bun.file(join(ROOT, "src", "run-context.ts")).text();
  expect(runtimeStatementCount(content, "src/run-context.ts")).toBe(0);
});
