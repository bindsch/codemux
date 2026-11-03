/**
 * The coverage gate itself (audit finding 5): per-file floor, waiver
 * handling, malformed and empty lcov records, and the scripts/ glob are
 * exercised against fixture lcov text, not the real report.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectSourceFiles,
  evaluateCoverage,
  parseLcov,
  reportStaleness,
  runCheck,
} from "../scripts/check-source-coverage.ts";

function fixtureTree(): string {
  const cwd = mkdtempSync(join(tmpdir(), "codemux-cov-gate-"));
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

describe("check-source-coverage", () => {
  test("a file at the floor passes and an absent type-only file is excluded", async () => {
    const cwd = fixtureTree();
    try {
      const files = await collectSourceFiles(cwd);
      expect(files.has("src/run-context.ts")).toBe(false);
      expect(files.has("src/loaded.ts")).toBe(true);
      expect(files.has("scripts/tool.ts")).toBe(true);
      const verdict = evaluateCoverage(
        [
          record("src/loaded.ts", 9, 9, 2, 2),
          record("src/low.ts", 3, 3, 1, 1),
          record("src/index.ts", 2, 2, 0, 0),
          record("scripts/tool.ts", 1, 1, 0, 0),
        ].join(""),
        files
      );
      expect(verdict.floorBreaches).toEqual([]);
      expect(verdict.missingFiles).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("an absolute SF: path is normalized to its cwd-relative key", async () => {
    // Review round 7, edges: the parser kept SF: verbatim, so an
    // absolute record (what a reporter writing full paths emits) missed
    // its cwd-relative collectSourceFiles key and read as a missing
    // file. Normalization makes the absolute and relative spellings of
    // one record match.
    const cwd = fixtureTree();
    try {
      const files = await collectSourceFiles(cwd);
      const verdict = evaluateCoverage(
        [
          record(join(cwd, "src", "loaded.ts"), 9, 9, 2, 2),
          record("src/low.ts", 3, 3, 1, 1),
          record("src/index.ts", 2, 2, 0, 0),
          record("scripts/tool.ts", 1, 1, 0, 0),
        ].join(""),
        files,
        cwd
      );
      expect(verdict.missingFiles).toEqual([]);
      expect(verdict.floorBreaches).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a file missing from the report breaches the floor and counts as uncovered", async () => {
    const cwd = fixtureTree();
    try {
      const files = await collectSourceFiles(cwd);
      const verdict = evaluateCoverage(
        [record("src/loaded.ts", 9, 9, 2, 2), record("src/low.ts", 3, 3, 1, 1)].join(""),
        files
      );
      expect(verdict.missingFiles).toContain("scripts/tool.ts");
      expect(verdict.floorBreaches.map((breach) => breach.path)).toContain("scripts/tool.ts");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a file below 80% lines or functions breaches the floor", async () => {
    const cwd = fixtureTree();
    try {
      const files = await collectSourceFiles(cwd);
      const verdict = evaluateCoverage(
        [
          record("src/loaded.ts", 9, 9, 2, 2),
          record("src/low.ts", 10, 5, 2, 1),
          record("src/index.ts", 2, 2, 0, 0),
          record("scripts/tool.ts", 1, 1, 0, 0),
        ].join(""),
        files
      );
      expect(verdict.floorBreaches).toEqual([
        { path: "src/low.ts", reason: "line coverage 50.0% (5/10)" },
        { path: "src/low.ts", reason: "function coverage 50.0% (1/2)" },
      ]);
      await expect(runCheck(cwd, [record("src/loaded.ts", 9, 9, 2, 2), record("src/low.ts", 10, 5, 2, 1),
        record("src/index.ts", 2, 2, 0, 0), record("scripts/tool.ts", 1, 1, 0, 0)].join(""))).rejects.toThrow(
        "every file under src/ and scripts/ must be at or above 80%"
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a child-only entry file is waived from the floor but still counted uncovered", async () => {
    const cwd = fixtureTree();
    try {
      const lcov = [record("src/loaded.ts", 9, 9, 2, 2), record("src/low.ts", 3, 3, 1, 1),
        record("scripts/tool.ts", 1, 1, 0, 0)].join("");
      const verdict = await runCheck(cwd, lcov);
      // src/index.ts is absent from the report: a missing file, a whole-source
      // hit (its physical lines count against the ratio), but no floor breach.
      expect(verdict.missingFiles).toContain("src/index.ts");
      expect(verdict.floorBreaches.map((breach) => breach.path)).not.toContain("src/index.ts");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("two functions sharing a name keep the record's stated function counts (round 28, edges 3)", async () => {
    // lcov's FNDA carries no line, so the two `run` functions would collapse
    // into one hit in the union (1 of 2, a floor breach); the stated
    // FNF:2/FNH:2 is the truthful count.
    const cwd = fixtureTree();
    try {
      const files = await collectSourceFiles(cwd);
      const lines = Array.from({ length: 9 }, (_, i) => `DA:${i + 1},1`).join("\n");
      const loaded = `SF:src/loaded.ts\nFN:1,run\nFN:9,run\nFNDA:1,run\nFNDA:1,run\nFNF:2\nFNH:2\n${lines}\nLF:9\nLH:9\nend_of_record\n`;
      const verdict = evaluateCoverage(
        [loaded, record("src/low.ts", 3, 3, 1, 1), record("src/index.ts", 2, 2, 0, 0), record("scripts/tool.ts", 1, 1, 0, 0)].join(""),
        files
      );
      expect(verdict.floorBreaches).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a duplicate-name record anywhere in a file's repeats makes the whole file use stated counts (round 30, edges 1)", async () => {
    const cwd = fixtureTree();
    try {
      const files = await collectSourceFiles(cwd);
      const lines = Array.from({ length: 9 }, (_, i) => `DA:${i + 1},1`).join("\n");
      // First record: unique names, one of two hit. Second record: the two
      // `run` functions both hit, stated 2/2. A name-keyed union would keep
      // the first record's 1 and the second's collapsed 1: 1 of 2.
      const first = `SF:src/loaded.ts\nFN:1,run\nFN:9,other\nFNDA:1,run\nFNDA:0,other\nFNF:2\nFNH:1\n${lines}\nLF:9\nLH:9\nend_of_record\n`;
      const second = `SF:src/loaded.ts\nFN:1,run\nFN:9,run\nFNDA:1,run\nFNDA:1,run\nFNF:2\nFNH:2\n${lines}\nLF:9\nLH:9\nend_of_record\n`;
      const verdict = evaluateCoverage(
        [first, second, record("src/low.ts", 3, 3, 1, 1), record("src/index.ts", 2, 2, 0, 0), record("scripts/tool.ts", 1, 1, 0, 0)].join(""),
        files
      );
      expect(verdict.floorBreaches).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("detailed entries beyond the stated found counts are a hard error (round 32, edges 3)", () => {
    expect(() => evaluateCoverage("SF:src/loaded.ts\nDA:1,1\nLF:0\nLH:0\nFNF:0\nFNH:0\nend_of_record\n", new Map()))
      .toThrow("1 DA entries exceed LF 0");
    expect(() => evaluateCoverage("SF:src/loaded.ts\nFNDA:1,f\nDA:1,1\nLF:1\nLH:1\nFNF:0\nFNH:0\nend_of_record\n", new Map()))
      .toThrow("1 FNDA entries exceed FNF 0");
  });

  test("detailed hits that disagree with the stated LH or FNH are a hard error (round 34, edges 3)", () => {
    expect(() => evaluateCoverage("SF:src/loaded.ts\nDA:1,1\nLF:1\nLH:0\nFNF:0\nFNH:0\nend_of_record\n", new Map()))
      .toThrow("DA entries hit 1 lines but LH says 0");
    expect(() => evaluateCoverage("SF:src/loaded.ts\nFN:1,f\nFNDA:1,f\nDA:1,1\nLF:1\nLH:1\nFNF:1\nFNH:0\nend_of_record\n", new Map()))
      .toThrow("FNDA entries hit 1 functions but FNH says 0");
  });

  test("a DA line 0 is a hard error (round 30, edges 4)", () => {
    expect(() => evaluateCoverage("SF:src/loaded.ts\nDA:0,1\nLF:1\nLH:1\nFNF:0\nFNH:0\nend_of_record\n", new Map()))
      .toThrow("malformed lcov DA record for src/loaded.ts: line 0");
  });

  test("an empty lcov parse is a hard error", () => {
    expect(() => evaluateCoverage("", new Map())).toThrow("lcov parse produced no file records");
    expect(() => evaluateCoverage("\n\n", new Map())).toThrow("lcov parse produced no file records");
  });

  test("malformed counts are a hard error, not a silent pass", () => {
    expect(() => evaluateCoverage(record("src/loaded.ts", Number.NaN, 1, 1, 1), new Map())).toThrow(
      "malformed lcov LF record"
    );
    expect(() => evaluateCoverage("SF:src/loaded.ts\nLF:10\nLH:5\nFNF:many\nFNH:1\nend_of_record\n", new Map())).toThrow(
      "malformed lcov FNF record"
    );
    expect(() => evaluateCoverage("LH:5\n", new Map())).toThrow("lcov record before any SF line");
  });

  test("fractional counts and hits above found are hard errors, not inflated coverage", () => {
    // Review round 6, edges finding 4: `LF:1.5` used to parse, and
    // `LF:1/LH:100` read as 10,000% coverage, letting a corrupted record
    // compensate for uncovered files instead of failing the gate.
    expect(() => evaluateCoverage("SF:src/loaded.ts\nLF:1.5\nLH:1\nFNF:1\nFNH:1\nend_of_record\n", new Map())).toThrow(
      "malformed lcov LF record"
    );
    expect(() => evaluateCoverage(record("src/loaded.ts", 1, 100, 1, 1), new Map())).toThrow(
      "malformed lcov record for src/loaded.ts: LH 100 exceeds LF 1"
    );
    expect(() => evaluateCoverage(record("src/loaded.ts", 10, 5, 1, 2), new Map())).toThrow(
      "malformed lcov record for src/loaded.ts: FNH 2 exceeds FNF 1"
    );
    // Detailed DA entries must not launder the stated counts (round 25, edges 3).
    expect(() => evaluateCoverage("SF:src/loaded.ts\nDA:1,1\nLF:1\nLH:100\nFNF:1\nFNH:1\nFNDA:1,f\nend_of_record\n", new Map())).toThrow(
      "malformed lcov record for src/loaded.ts: LH 100 exceeds LF 1"
    );
  });

  test("a digit count past every safe integer is a hard error (round 23, edges 9)", () => {
    // Twenty digits passed the digits-only check and parsed to 1e20 under
    // Number(), so a corrupted record could name a count the arithmetic
    // cannot represent exactly and let the sums drift. No real source
    // file carries such a count; the gate fails closed on it.
    expect(() =>
      evaluateCoverage(
        "SF:src/loaded.ts\nLF:99999999999999999999\nLH:1\nFNF:1\nFNH:1\nend_of_record\n",
        new Map()
      )
    ).toThrow("malformed lcov LF record");
    expect(() =>
      evaluateCoverage(
        "SF:src/loaded.ts\nLF:10\nLH:99999999999999999999\nFNF:1\nFNH:1\nend_of_record\n",
        new Map()
      )
    ).toThrow("malformed lcov LH record");
  });

  test("a zero-count record for a file with lines breaches; an empty file does not", async () => {
    // Review round 5, edges finding 4: an LF:0/FNF:0 record for a real
    // source file used to yield no breach and a lineRatio of 1.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-cov-gate-"));
    try {
      mkdirSync(join(cwd, "src"), { recursive: true });
      mkdirSync(join(cwd, "scripts"), { recursive: true });
      writeFileSync(join(cwd, "src", "real.ts"), "export function a(): number {\n  return 1;\n}\n");
      writeFileSync(join(cwd, "src", "empty.ts"), "");
      writeFileSync(join(cwd, "scripts", "tool.ts"), "console.log(\"tool\");\n");
      const files = await collectSourceFiles(cwd);
      expect(files.get("src/real.ts")).toEqual({ physicalLines: 3, runtimeFunctions: 1 });
      const verdict = evaluateCoverage(
        [
          record("src/real.ts", 0, 0, 0, 0),
          record("src/empty.ts", 0, 0, 0, 0),
          record("scripts/tool.ts", 1, 1, 0, 0),
        ].join(""),
        files
      );
      expect(verdict.floorBreaches).toEqual([
        { path: "src/real.ts", reason: "coverage record reports no lines for a file with 3 physical lines (incomplete or malformed report)" },
        { path: "src/real.ts", reason: "coverage record reports no functions for a file with 1 runtime functions (incomplete or malformed report)" },
      ]);
      // The physical lines count as loaded and uncovered, never as 100%.
      expect(verdict.totalLines).toBe(4);
      expect(verdict.coveredLines).toBe(1);
      expect(verdict.lineRatio).toBe(1 / 4);
      // A record missing LF:/LH: entirely defaults to 0 and lands in the
      // same rule.
      const truncated = evaluateCoverage(
        `SF:src/real.ts\nFNF:1\nFNH:1\nend_of_record\n${record("scripts/tool.ts", 1, 1, 0, 0)}`,
        files
      );
      expect(truncated.floorBreaches.map((breach) => breach.reason)).toContain(
        "coverage record reports no lines for a file with 3 physical lines (incomplete or malformed report)"
      );
      // runCheck fails the gate on the same breach (its error names the
      // floor; the per-breach line printed above it carries the reason).
      await expect(runCheck(cwd, [record("src/real.ts", 0, 0, 0, 0), record("src/empty.ts", 0, 0, 0, 0),
        record("scripts/tool.ts", 1, 1, 0, 0)].join(""))).rejects.toThrow("must be at or above 80% line and function coverage");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a type-only waiver that stops being type-only fails the gate naming the file (round 10, edges 7)", async () => {
    // The waiver removed the file from every ratio, so a runtime export
    // or a loaded-in-suite record hid an uncovered module forever.
    const base = () => {
      const cwd = fixtureTree();
      const lcov = [
        record("src/loaded.ts", 9, 9, 2, 2),
        record("src/low.ts", 3, 3, 1, 1),
        record("src/index.ts", 2, 2, 0, 0),
        record("scripts/tool.ts", 1, 1, 0, 0),
      ].join("");
      return { cwd, lcov };
    };

    // Runtime exports appear in the waived file: refused.
    const grew = base();
    try {
      writeFileSync(join(grew.cwd, "src", "run-context.ts"), "export function live(): number {\n  return 1;\n}\n");
      await expect(runCheck(grew.cwd, grew.lcov)).rejects.toThrow(
        "type-only waiver no longer holds for src/run-context.ts: the file now exports 1 runtime function(s)"
      );
    } finally {
      rmSync(grew.cwd, { recursive: true, force: true });
    }

    // The report carries executable lines for it: the suite loads it, so
    // the file is not test-unreachable either way.
    const loaded = base();
    try {
      await expect(
        runCheck(loaded.cwd, loaded.lcov + record("src/run-context.ts", 2, 2, 0, 0))
      ).rejects.toThrow("type-only waiver no longer holds for src/run-context.ts");
    } finally {
      rmSync(loaded.cwd, { recursive: true, force: true });
    }

    // A type-only file with no record still passes.
    const clean = base();
    try {
      await expect(runCheck(clean.cwd, clean.lcov)).resolves.toBeTruthy();
    } finally {
      rmSync(clean.cwd, { recursive: true, force: true });
    }
  });

  test("a type-only waiver that grows a runtime VALUE export fails the gate (round 20, minor 10)", async () => {
    // runtimeFunctionCount alone never noticed a const, let, class, or
    // enum export — runtime behavior in a file the waiver drops from
    // every floor.
    const cwd = fixtureTree();
    const lcov = [
      record("src/loaded.ts", 9, 9, 2, 2),
      record("src/low.ts", 3, 3, 1, 1),
      record("src/index.ts", 2, 2, 0, 0),
      record("scripts/tool.ts", 1, 1, 0, 0),
    ].join("");
    try {
      for (const [body, count] of [
        ["export const answer = 42;\n", 1],
        ["export let counter = 0;\nexport class Tool {}\n", 2],
        ["export enum Direction {\n  Up,\n}\n", 1],
        // Separate and re-exported values (round 24, edges 4).
        ["const value = 1;\nexport { value };\n", 1],
        ["const first = 1;\nconst second = 2;\nexport { first, second as other };\n", 2],
        ["const chosen = 3;\nexport default chosen;\n", 1],
      ] as const) {
        writeFileSync(join(cwd, "src", "run-context.ts"), body);
        await expect(runCheck(cwd, lcov)).rejects.toThrow(
          `type-only waiver no longer holds for src/run-context.ts: ` +
            `the file now exports ${count} runtime value export(s)`
        );
      }
      // Types alone still earn the waiver.
      writeFileSync(
        join(cwd, "src", "run-context.ts"),
        "export interface Shape {\n  x: number;\n}\nexport type Id = string;\n"
      );
      await expect(runCheck(cwd, lcov)).resolves.toBeTruthy();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("parseLcov record shapes", () => {
  test("accepts a named TN: test header before the SF line (round 19, edges 5)", () => {
    // `TN:<name>` is valid lcov; only the bare `TN:` was accepted, so a
    // named header before any SF: was rejected as a stray record.
    const files = parseLcov("TN:integration\n" + record("src/one.ts", 10, 10, 2, 2));
    expect(files.get("src/one.ts")).toMatchObject({ linesFound: 10, linesHit: 10 });
  });

  test("repeated SF: records for one path merge on the maximum hit (round 19, edges 6)", () => {
    // A multi-test lcov repeats the file; the second record may not drop
    // the first's coverage. Hit counts cannot be summed from summaries,
    // so the union is the maximum hit under the shared found count.
    const files = parseLcov(
      "SF:src/two.ts\nLF:10\nLH:10\nFNF:2\nFNH:2\nend_of_record\n" +
      "SF:src/two.ts\nLF:10\nLH:0\nFNF:2\nFNH:1\nend_of_record\n"
    );
    expect(files.size).toBe(1);
    expect(files.get("src/two.ts")).toMatchObject({
      linesFound: 10, linesHit: 10, functionsFound: 2, functionsHit: 2,
    });
  });

  test("two disjoint records for one file merge to the union (lane C30, item 5)", () => {
    // Bun writes one record per file per test run; two runs that each
    // cover half a file hold the whole file in union. The old merge kept
    // the maximum of the per-file totals, so this read as LH 1 of LF 4 —
    // a conservative false failure on the floor.
    const files = parseLcov(
      "SF:src/disjoint.ts\nDA:1,1\nDA:2,0\nLF:4\nLH:1\nFNF:2\nFNH:1\nFNDA:1,one\nend_of_record\n" +
      "SF:src/disjoint.ts\nDA:3,1\nDA:4,0\nLF:4\nLH:1\nFNF:2\nFNH:1\nFNDA:1,two\nend_of_record\n"
    );
    expect(files.size).toBe(1);
    expect(files.get("src/disjoint.ts")).toEqual({
      path: "src/disjoint.ts",
      linesFound: 4, linesHit: 2,
      functionsFound: 2, functionsHit: 2,
    });
    // The same line named by both records counts once, at its maximum hit.
    const overlap = parseLcov(
      "SF:src/disjoint.ts\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\n" +
      "SF:src/disjoint.ts\nDA:1,3\nLF:2\nLH:1\nend_of_record\n"
    );
    expect(overlap.get("src/disjoint.ts")).toMatchObject({ linesFound: 2, linesHit: 1 });
  });

  test("repeated SF: records that disagree on the found count are refused by path", () => {
    expect(() => parseLcov(
      "SF:src/three.ts\nLF:10\nLH:10\nFNF:2\nFNH:2\nend_of_record\n" +
      "SF:src/three.ts\nLF:9\nLH:9\nFNF:2\nFNH:2\nend_of_record\n"
    )).toThrow("lcov records for src/three.ts disagree on LF: 10 then 9");
    expect(() => parseLcov(
      "SF:src/three.ts\nLF:10\nLH:10\nFNF:2\nFNH:2\nend_of_record\n" +
      "SF:src/three.ts\nLF:10\nLH:10\nFNF:3\nFNH:3\nend_of_record\n"
    )).toThrow("lcov records for src/three.ts disagree on FNF: 2 then 3");
  });

  test("count fields accept whole digits only (round 20, minor 11)", () => {
    // Number() tolerated whitespace, a sign, and hex spellings; a
    // corrupted lcov record must not pass any of them as a count.
    for (const raw of [" 10", "10 ", "+10", "-0", "0x2a", "1e2", "", "10.0"]) {
      expect(() => parseLcov(`SF:src/one.ts\nLF:${raw}\nLH:0\nFNF:0\nFNH:0\nend_of_record\n`))
        .toThrow(`malformed lcov LF record for src/one.ts: "${raw}"`);
    }
    expect(() => parseLcov("SF:src/one.ts\nLF:10\nLH:10\nFNF:2\nFNH:2\nend_of_record\n"))
      .not.toThrow();
  });
});

describe("reportStaleness (the .run-stamp freshness check)", () => {
  function stampedTree(): string {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-cov-stamp-"));
    mkdirSync(join(cwd, "coverage"), { recursive: true });
    return cwd;
  }
  const at = (seconds: number) => new Date(seconds * 1000);

  test("a report older than the stamp is refused", () => {
    const cwd = stampedTree();
    try {
      writeFileSync(join(cwd, "coverage", "lcov.info"), "");
      writeFileSync(join(cwd, "coverage", ".run-stamp"), "");
      utimesSync(join(cwd, "coverage", "lcov.info"), at(100), at(100));
      utimesSync(join(cwd, "coverage", ".run-stamp"), at(200), at(200));
      expect(reportStaleness(cwd)).toBe(
        "coverage/lcov.info is stale: older than coverage/.run-stamp, so it survived from an earlier run."
      );
      // A report at least as new as the stamp gates the run.
      utimesSync(join(cwd, "coverage", "lcov.info"), at(200), at(200));
      expect(reportStaleness(cwd)).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a stamped run that wrote no report is refused; an unstamped one is not", () => {
    const cwd = stampedTree();
    try {
      writeFileSync(join(cwd, "coverage", ".run-stamp"), "");
      expect(reportStaleness(cwd)).toBe(
        "coverage/lcov.info is missing: a stamped run wrote no coverage report."
      );
      rmSync(join(cwd, "coverage", ".run-stamp"));
      expect(reportStaleness(cwd)).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

