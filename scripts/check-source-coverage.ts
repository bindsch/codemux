import { statSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import {
  CHILD_ONLY_FILES,
  PLATFORM_GATED_FILES,
  TYPE_ONLY_FILES,
  physicalLineCount,
  runtimeFunctionCount,
  runtimeValueExportCount,
} from "./coverage-export-guards.js";

export { CHILD_ONLY_FILES, PLATFORM_GATED_FILES, TYPE_ONLY_FILES, physicalLineCount, runtimeFunctionCount, runtimeValueExportCount };

const MINIMUM_COVERAGE = 0.8;
const LCOV_PATH = "coverage/lcov.info";
const STAMP_PATH = "coverage/.run-stamp";


export interface FileCoverage {
  path: string;
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
}

/** Everything one file's REPEATED lcov records accumulate (Bun emits one
 * record per file per test run, so a multi-test lcov repeats `SF:` for the
 * same path). DA and FNDA entries union with the maximum hit per entry; a
 * line hit under two tests counts once, and two records covering disjoint
 * lines union to every line either hit — which no merge of the per-file
 * totals can express (two records of LH 2 on LF 4 hold 4 hits in union;
 * the old maximum-of-totals answered 2, a conservative false failure).
 * The stated LF/LH/FNF/FNH totals are kept for the records that carry no
 * entries at all, and the stated found counts gate the disagreement
 * refusal. */
interface FileAccumulator {
  lineHits: Map<number, number>;
  functionHits: Map<string, number>;
  statedLinesFound: number | null;
  statedLinesHit: number;
  statedFunctionsFound: number | null;
  statedFunctionsHit: number;
  /** False once a record for this file carried two functions of one name. */
  functionsByName: boolean;
}

function maxInto<T>(target: Map<T, number>, key: T, hits: number): void {
  target.set(key, Math.max(target.get(key) ?? 0, hits));
}

function countHits(hits: Map<unknown, number>): number {
  let hit = 0;
  for (const value of hits.values()) if (value > 0) hit++;
  return hit;
}

/** Fold one closed record into the file's accumulator and recompute the
 * per-file totals from the union. Records whose stated found counts
 * disagree are refused, naming the path (round 19, edges 5/6). `found`
 * stays the larger of the stated count and the union's size, never below
 * either, so a record listing fewer entries than it declares found keeps
 * its unlisted lines in the denominator (the conservative direction). */
function mergeRecord(
  files: Map<string, FileCoverage>,
  accumulators: Map<string, FileAccumulator>,
  record: FileCoverage,
  recordEntries: { lineHits: Map<number, number>; functionHits: Map<string, number> },
  duplicateFunctionNames = false
): void {
  const acc = accumulators.get(record.path) ?? {
    lineHits: new Map<number, number>(),
    functionHits: new Map<string, number>(),
    statedLinesFound: null,
    statedLinesHit: 0,
    statedFunctionsFound: null,
    statedFunctionsHit: 0,
    functionsByName: true,
  };
  // Once any record for the file carried two functions of one name, the
  // name-keyed union is unreliable for the whole file: every record falls
  // back to its stated FNF/FNH (round 30, edges 1 completes round 28's fix).
  if (duplicateFunctionNames) acc.functionsByName = false;
  if (!acc.functionsByName) {
    acc.functionHits.clear();
    recordEntries.functionHits.clear();
  }
  // Stated counts are judged before the DA/FNDA union replaces them (round 25, edges 3).
  if (record.linesHit > record.linesFound) {
    throw new Error(`malformed lcov record for ${record.path}: LH ${record.linesHit} exceeds LF ${record.linesFound}`);
  }
  if (record.functionsHit > record.functionsFound) {
    throw new Error(`malformed lcov record for ${record.path}: FNH ${record.functionsHit} exceeds FNF ${record.functionsFound}`);
  }
  // Detailed entries that outnumber the stated found counts contradict the
  // record (DA:1,1 under LF:0); they must not stand in for it (round 32, edges 3).
  if (recordEntries.lineHits.size > record.linesFound) {
    throw new Error(`malformed lcov record for ${record.path}: ${recordEntries.lineHits.size} DA entries exceed LF ${record.linesFound}`);
  }
  if (recordEntries.functionHits.size > record.functionsFound) {
    throw new Error(`malformed lcov record for ${record.path}: ${recordEntries.functionHits.size} FNDA entries exceed FNF ${record.functionsFound}`);
  }
  // Detailed hits that disagree with the record's own LH/FNH (LF:1, LH:0,
  // DA:1,1) are a contradiction, not a better count (round 34, edges 3).
  if (recordEntries.lineHits.size > 0 && countHits(recordEntries.lineHits) !== record.linesHit) {
    throw new Error(`malformed lcov record for ${record.path}: DA entries hit ${countHits(recordEntries.lineHits)} lines but LH says ${record.linesHit}`);
  }
  if (acc.functionsByName && !duplicateFunctionNames && recordEntries.functionHits.size > 0 &&
    countHits(recordEntries.functionHits) !== record.functionsHit) {
    throw new Error(`malformed lcov record for ${record.path}: FNDA entries hit ${countHits(recordEntries.functionHits)} functions but FNH says ${record.functionsHit}`);
  }
  if (acc.statedLinesFound !== null && acc.statedLinesFound !== record.linesFound) {
    throw new Error(
      `lcov records for ${record.path} disagree on LF: ${acc.statedLinesFound} then ${record.linesFound}`
    );
  }
  if (acc.statedFunctionsFound !== null && acc.statedFunctionsFound !== record.functionsFound) {
    throw new Error(
      `lcov records for ${record.path} disagree on FNF: ${acc.statedFunctionsFound} then ${record.functionsFound}`
    );
  }
  acc.statedLinesFound = record.linesFound;
  acc.statedLinesHit = Math.max(acc.statedLinesHit, record.linesHit);
  acc.statedFunctionsFound = record.functionsFound;
  acc.statedFunctionsHit = Math.max(acc.statedFunctionsHit, record.functionsHit);
  for (const [line, hits] of recordEntries.lineHits) maxInto(acc.lineHits, line, hits);
  for (const [name, hits] of recordEntries.functionHits) maxInto(acc.functionHits, name, hits);
  accumulators.set(record.path, acc);
  files.set(record.path, {
    path: record.path,
    linesFound: Math.max(acc.statedLinesFound ?? 0, acc.lineHits.size),
    // A summary-only record's LH/FNH is a floor the detailed entries of a
    // later record must not lower (review round 54: LH:8 then two DA lines
    // read as two covered lines).
    linesHit: Math.max(countHits(acc.lineHits), acc.statedLinesHit),
    functionsFound: Math.max(acc.statedFunctionsFound ?? 0, acc.functionHits.size),
    functionsHit: Math.max(countHits(acc.functionHits), acc.statedFunctionsHit),
  });
}

/** Parse lcov records; any non-numeric, negative, or fractional count, and
 * any hits count above its found count, is a hard error. An absolute SF:
 * path is normalized relative to `cwd` so it still matches the
 * cwd-relative keys collectSourceFiles builds (review round 7, edges).
 * Repeated records for one path merge per entry (DA lines and FNDA
 * functions, maximum hit per entry) and the per-file totals recompute from
 * that union. */
export function parseLcov(lcovText: string, cwd: string = process.cwd()): Map<string, FileCoverage> {
  const files = new Map<string, FileCoverage>();
  const accumulators = new Map<string, FileAccumulator>();
  let current: FileCoverage | undefined;
  let currentEntries: { lineHits: Map<number, number>; functionHits: Map<string, number>; functionNames: string[] } | undefined;
  const closeRecord = (): void => {
    if (current !== undefined && currentEntries !== undefined) {
      // FNDA keys hits by name; two FN entries sharing a name cannot be
      // told apart, so the record keeps its stated FNF/FNH instead of a
      // union that would collapse them into one (round 28, edges 3).
      const duplicateNames = new Set(currentEntries.functionNames).size !== currentEntries.functionNames.length;
      mergeRecord(files, accumulators, current, currentEntries, duplicateNames);
      current = undefined;
      currentEntries = undefined;
    }
  };
  for (const line of lcovText.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      closeRecord();
      const raw = line.slice(3);
      const path = normalize(isAbsolute(raw) ? relative(cwd, raw) : raw);
      current = { path, linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 };
      currentEntries = { lineHits: new Map<number, number>(), functionHits: new Map<string, number>(), functionNames: [] };
    } else if (line.startsWith("DA:")) {
      if (current === undefined || currentEntries === undefined) {
        throw new Error(`lcov record before any SF line: ${JSON.stringify(line)}`);
      }
      // DA:<line>,<hits>[,<checksum>] — the checksum, when present, is
      // coverage-irrelevant and ignored.
      const fields = line.slice(3).split(",");
      const hits = count(fields[1] ?? "", "DA", current.path);
      const lineNumber = count(fields[0] ?? "", "DA", current.path);
      // Source lines are 1-based; a line 0 is a corrupt entry, not coverage
      // (round 30, edges 4).
      if (lineNumber === 0) throw new Error(`malformed lcov DA record for ${current.path}: line 0`);
      maxInto(currentEntries.lineHits, lineNumber, hits);
    } else if (line.startsWith("FNDA:")) {
      if (current === undefined || currentEntries === undefined) {
        throw new Error(`lcov record before any SF line: ${JSON.stringify(line)}`);
      }
      // FNDA:<hits>,<name>; the name is everything after the first comma.
      const body = line.slice(5);
      const separator = body.indexOf(",");
      if (separator === -1) {
        throw new Error(`malformed lcov FNDA record for ${current.path}: ${JSON.stringify(body)}`);
      }
      const name = body.slice(separator + 1);
      maxInto(currentEntries.functionHits, name, count(body.slice(0, separator), "FNDA", current.path));
    } else if (line.startsWith("FN:")) {
      // FN:<line>,<name> names the function; its hits ride FNDA, keyed by
      // name alone. Two functions sharing a name cannot be told apart by
      // FNDA, so such a record keeps its stated FNF/FNH (round 28, edges 3).
      if (current === undefined || currentEntries === undefined) {
        throw new Error(`lcov record before any SF line: ${JSON.stringify(line)}`);
      }
      const separator = line.indexOf(",");
      currentEntries.functionNames.push(separator === -1 ? line.slice(3) : line.slice(separator + 1));
    } else if (line.startsWith("TN:") || line === "end_of_record" || line.trim() === "") {
      // Every file record opens with a TN: test-name header — bare or
      // named (`TN:integration`), both carry no counts — and closes with
      // end_of_record.
      if (line === "end_of_record") closeRecord();
      continue;
    } else if (current === undefined) {
      throw new Error(`lcov record before any SF line: ${JSON.stringify(line)}`);
    } else if (line.startsWith("LF:")) current.linesFound = count(line.slice(3), "LF", current.path);
    else if (line.startsWith("LH:")) current.linesHit = count(line.slice(3), "LH", current.path);
    else if (line.startsWith("FNF:")) current.functionsFound = count(line.slice(4), "FNF", current.path);
    else if (line.startsWith("FNH:")) current.functionsHit = count(line.slice(4), "FNH", current.path);
  }
  closeRecord();
  if (files.size === 0) {
    throw new Error("lcov parse produced no file records; run Bun with the lcov coverage reporter");
  }
  // Hits above found is a corrupted record, not extra coverage: without
  // this check `LF:1/LH:100` would read as 10,000% and compensate for
  // uncovered files elsewhere (review round 6, edges finding 4). The gate
  // fails closed with the path and the two values.
  for (const stats of files.values()) {
    if (stats.linesHit > stats.linesFound) {
      throw new Error(
        `malformed lcov record for ${stats.path}: LH ${stats.linesHit} exceeds LF ${stats.linesFound}`
      );
    }
    if (stats.functionsHit > stats.functionsFound) {
      throw new Error(
        `malformed lcov record for ${stats.path}: FNH ${stats.functionsHit} exceeds FNF ${stats.functionsFound}`
      );
    }
  }
  return files;
}

function count(raw: string, label: string, path: string): number {
  // Whole digits only (round 20, minor 11): Number() also accepts
  // " 42 ", "42\n", and "0x2a", and a corrupted lcov record must not
  // pass any of those spellings as a valid count. Digits alone are not
  // enough either (round 23, edges 9): a 20-digit string parses to a
  // value past every safe integer — huge enough that the sums below
  // drift on representation error, and no real source file carries such
  // a count — so anything unsafe is corruption and fails closed.
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`malformed lcov ${label} record for ${path}: ${JSON.stringify(raw)}`);
  }
  return value;
}

export interface SourceFile {
  /** Physical lines, counted for a file the report omitted entirely. */
  physicalLines: number;
  runtimeFunctions: number;
}

export interface FloorBreach {
  path: string;
  reason: string;
}

export interface CoverageVerdict {
  lineRatio: number;
  functionRatio: number;
  coveredLines: number;
  totalLines: number;
  coveredFunctions: number;
  totalFunctions: number;
  missingFiles: string[];
  floorBreaches: FloorBreach[];
}

/**
 * Evaluate whole-source ratios (missing non-waived files count as fully
 * uncovered) and the per-file floor (every non-waived file under src/ and
 * scripts/ at or above 80% lines and 80% functions).
 */
export function evaluateCoverage(
  lcovText: string,
  sourceFiles: Map<string, SourceFile>,
  cwd: string = process.cwd()
): CoverageVerdict {
  const records = parseLcov(lcovText, cwd);
  let coveredLines = 0;
  let coveredFunctions = 0;
  let loadedLines = 0;
  let loadedFunctions = 0;
  const missingFiles: string[] = [];
  const floorBreaches: FloorBreach[] = [];
  for (const [path, stats] of sourceFiles) {
    const record = records.get(path);
    if (record === undefined) {
      missingFiles.push(path);
      loadedLines += stats.physicalLines;
      loadedFunctions += stats.runtimeFunctions;
      floorBreaches.push({ path, reason: "absent from the coverage report (never loaded in-process)" });
      continue;
    }
    // A matched record reporting zero lines (or functions) for a file that
    // has them is an incomplete or malformed report, not 100% coverage
    // (review round 5, edges finding 4): the physical counts stand in as
    // loaded and uncovered, and the breach names the real problem. A
    // record missing LF:/LH: entirely defaults to 0, so it lands in the
    // same rule.
    const incompleteLines = record.linesFound === 0 && stats.physicalLines > 0;
    const incompleteFunctions = record.functionsFound === 0 && stats.runtimeFunctions > 0;
    const linesFound = incompleteLines ? stats.physicalLines : record.linesFound;
    const functionsFound = incompleteFunctions ? stats.runtimeFunctions : record.functionsFound;
    loadedLines += linesFound;
    loadedFunctions += functionsFound;
    coveredLines += incompleteLines ? 0 : record.linesHit;
    coveredFunctions += incompleteFunctions ? 0 : record.functionsHit;
    if (incompleteLines) {
      floorBreaches.push({
        path,
        reason: `coverage record reports no lines for a file with ${stats.physicalLines} physical lines (incomplete or malformed report)`,
      });
    } else if (record.linesFound > 0 && record.linesHit / record.linesFound < MINIMUM_COVERAGE) {
      floorBreaches.push({
        path,
        reason: `line coverage ${(record.linesHit / record.linesFound * 100).toFixed(1)}% ` +
          `(${record.linesHit}/${record.linesFound})`,
      });
    }
    if (incompleteFunctions) {
      floorBreaches.push({
        path,
        reason: `coverage record reports no functions for a file with ${stats.runtimeFunctions} runtime functions (incomplete or malformed report)`,
      });
    } else if (record.functionsFound > 0 && record.functionsHit / record.functionsFound < MINIMUM_COVERAGE) {
      floorBreaches.push({
        path,
        reason: `function coverage ${(record.functionsHit / record.functionsFound * 100).toFixed(1)}% ` +
          `(${record.functionsHit}/${record.functionsFound})`,
      });
    }
  }
  return {
    lineRatio: loadedLines === 0 ? 1 : coveredLines / loadedLines,
    functionRatio: loadedFunctions === 0 ? 1 : coveredFunctions / loadedFunctions,
    coveredLines,
    totalLines: loadedLines,
    coveredFunctions,
    totalFunctions: loadedFunctions,
    missingFiles,
    floorBreaches,
  };
}

/** Glob the gated trees (src/ and scripts/) minus the type-only waivers. */
export async function collectSourceFiles(cwd: string): Promise<Map<string, SourceFile>> {
  const files = new Map<string, SourceFile>();
  for (const pattern of ["src/**/*.ts", "scripts/**/*.ts"]) {
    const glob = new Bun.Glob(pattern);
    for await (const path of glob.scan({ cwd, onlyFiles: true })) {
      const key = normalize(path);
      if (TYPE_ONLY_FILES.has(key)) continue;
      const content = await Bun.file(`${cwd}/${key}`).text();
      files.set(key, { physicalLines: physicalLineCount(content), runtimeFunctions: runtimeFunctionCount(content, key) });
    }
  }
  if (files.size === 0) {
    throw new Error(`no source files under src/ or scripts/ at ${cwd}; the glob must be wrong`);
  }
  return files;
}

/** A type-only waiver must still be earned (review round 10, edges 7):
 * the waiver drops the file from the per-file floor and the
 * whole-source ratios, so nothing else would notice it growing runtime
 * exports — functions (round 10) or values (round 20, minor 10) — or
 * the suite starting to load it. Any case fails the gate naming the
 * file; a waiver over a file with runtime behavior is a hole in the
 * floor. A tree without the file (a fixture) has nothing to guard. */
async function assertTypeOnlyWaiversHold(cwd: string, lcovText: string): Promise<void> {
  const records = parseLcov(lcovText, cwd);
  for (const path of TYPE_ONLY_FILES) {
    let content: string;
    try {
      content = await Bun.file(`${cwd}/${path}`).text();
    } catch {
      continue;
    }
    const runtimeFunctions = runtimeFunctionCount(content, path);
    const runtimeValues = runtimeValueExportCount(content, path);
    const record = records.get(path);
    if (
      runtimeFunctions > 0 ||
      runtimeValues > 0 ||
      (record !== undefined && (record.linesFound > 0 || record.functionsFound > 0))
    ) {
      throw new Error(
        `type-only waiver no longer holds for ${path}: ` +
          (runtimeFunctions > 0
            ? `the file now exports ${runtimeFunctions} runtime function(s)`
            : runtimeValues > 0
              ? `the file now exports ${runtimeValues} runtime value export(s)`
              : `the coverage report carries ${record?.linesFound ?? 0} line(s) for it`) +
          "; remove the waiver so the per-file floor applies"
      );
    }
  }
}

export async function runCheck(cwd: string, lcovText: string): Promise<CoverageVerdict> {
  await assertTypeOnlyWaiversHold(cwd, lcovText);
  const sourceFiles = await collectSourceFiles(cwd);
  const verdict = evaluateCoverage(lcovText, sourceFiles, cwd);
  const gated = new Set(
    [...sourceFiles.keys()].filter(
      (path) => !CHILD_ONLY_FILES.has(path) && !PLATFORM_GATED_FILES.has(path)
    )
  );
  console.log(
    `Whole-source conservative line coverage: ${(verdict.lineRatio * 100).toFixed(2)}%` +
      ` (${verdict.coveredLines}/${verdict.totalLines}; missing modules count as fully uncovered)`
  );
  console.log(
    `Whole-source conservative function coverage: ${(verdict.functionRatio * 100).toFixed(2)}%` +
      ` (${verdict.coveredFunctions}/${verdict.totalFunctions}; missing modules count as fully uncovered)`
  );
  if (verdict.missingFiles.length > 0) {
    console.log(`Coverage report omitted: ${verdict.missingFiles.join(", ")}`);
  }
  const breaches = verdict.floorBreaches.filter((breach) => gated.has(breach.path));
  if (breaches.length > 0) {
    for (const breach of breaches) {
      console.error(`Per-file floor breach: ${breach.path}: ${breach.reason}`);
    }
    throw new Error(
      `every file under src/ and scripts/ must be at or above 80% line and function coverage ` +
        `(${breaches.length} breach(es); waivers: ` +
          `${[...TYPE_ONLY_FILES, ...CHILD_ONLY_FILES, ...PLATFORM_GATED_FILES].join(", ")})`
    );
  }
  if (verdict.lineRatio < MINIMUM_COVERAGE || verdict.functionRatio < MINIMUM_COVERAGE) {
    throw new Error(`whole-source line and function coverage must each be at least 80%`);
  }
  return { ...verdict, floorBreaches: breaches };
}

/** Returns undefined when the report can gate this run, or a one-line
 * reason to refuse it: the Makefile touches `coverage/.run-stamp` before
 * each test run, so once the stamp exists a report older than it — or a
 * report that vanished while a stamped run was under way — survived from
 * an earlier run (Bun writes the report by renaming a temp file onto
 * lcov.info, which fails where replacing the existing file is forbidden).
 * Without a stamp there is no baseline to compare against, so the floor
 * runs on whatever report is present. */
export function reportStaleness(cwd: string): string | undefined {
  const stamp = statSync(join(cwd, STAMP_PATH), { throwIfNoEntry: false });
  if (stamp === undefined) return undefined;
  const report = statSync(join(cwd, LCOV_PATH), { throwIfNoEntry: false });
  if (report === undefined) {
    return `${LCOV_PATH} is missing: a stamped run wrote no coverage report.`;
  }
  if (report.mtimeMs < stamp.mtimeMs) {
    return `${LCOV_PATH} is stale: older than ${STAMP_PATH}, so it survived from an earlier run.`;
  }
  return undefined;
}

if (import.meta.main) {
  const stale = reportStaleness(process.cwd());
  if (stale !== undefined) {
    console.error(stale);
    process.exit(1);
  }
  const lcovFile = Bun.file(`${process.cwd()}/${LCOV_PATH}`);
  if (!(await lcovFile.exists())) {
    throw new Error(`${LCOV_PATH} is missing; run Bun with the lcov coverage reporter`);
  }
  await runCheck(process.cwd(), await lcovFile.text());
}
