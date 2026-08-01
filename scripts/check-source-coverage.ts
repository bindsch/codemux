import { isAbsolute, normalize, relative } from "node:path";
import ts from "typescript";

const MINIMUM_COVERAGE = 0.8;
const LCOV_PATH = "coverage/lcov.info";

function sourceKey(path: string): string {
  return normalize(isAbsolute(path) ? relative(process.cwd(), path) : path);
}

function physicalLineCount(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function runtimeFunctionCount(content: string, path: string): number {
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  let functions = 0;

  function visit(node: ts.Node): void {
    const isRuntimeFunction =
      (ts.isFunctionDeclaration(node) && node.body !== undefined) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      (ts.isMethodDeclaration(node) && node.body !== undefined) ||
      (ts.isConstructorDeclaration(node) && node.body !== undefined) ||
      (ts.isGetAccessorDeclaration(node) && node.body !== undefined) ||
      (ts.isSetAccessorDeclaration(node) && node.body !== undefined);
    if (isRuntimeFunction) functions += 1;
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return functions;
}

const lcovFile = Bun.file(LCOV_PATH);
if (!(await lcovFile.exists())) {
  throw new Error(`${LCOV_PATH} is missing; run Bun with the lcov coverage reporter`);
}

const sourceFiles = new Set<string>();
const glob = new Bun.Glob("src/**/*.ts");
for await (const path of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
  sourceFiles.add(sourceKey(path));
}

const coveredFiles = new Set<string>();
let loadedLines = 0;
let coveredLines = 0;
let loadedFunctions = 0;
let coveredFunctions = 0;
let currentSource: string | undefined;
for (const line of (await lcovFile.text()).split(/\r?\n/)) {
  if (line.startsWith("SF:")) {
    currentSource = sourceKey(line.slice(3));
    if (sourceFiles.has(currentSource)) coveredFiles.add(currentSource);
  } else if (currentSource && sourceFiles.has(currentSource) && line.startsWith("LF:")) {
    loadedLines += Number(line.slice(3));
  } else if (currentSource && sourceFiles.has(currentSource) && line.startsWith("LH:")) {
    coveredLines += Number(line.slice(3));
  } else if (currentSource && sourceFiles.has(currentSource) && line.startsWith("FNF:")) {
    loadedFunctions += Number(line.slice(4));
  } else if (currentSource && sourceFiles.has(currentSource) && line.startsWith("FNH:")) {
    coveredFunctions += Number(line.slice(4));
  }
}

const missingFiles = [...sourceFiles].filter((path) => !coveredFiles.has(path));
let missingPhysicalLines = 0;
let missingRuntimeFunctions = 0;
for (const path of missingFiles) {
  const content = await Bun.file(path).text();
  missingPhysicalLines += physicalLineCount(content);
  missingRuntimeFunctions += runtimeFunctionCount(content, path);
}

const totalLines = loadedLines + missingPhysicalLines;
const totalFunctions = loadedFunctions + missingRuntimeFunctions;
const lineRatio = totalLines === 0 ? 1 : coveredLines / totalLines;
const functionRatio = totalFunctions === 0 ? 1 : coveredFunctions / totalFunctions;
console.log(
  `Whole-source conservative line coverage: ${(lineRatio * 100).toFixed(2)}%` +
    ` (${coveredLines}/${totalLines}; missing modules count as fully uncovered)`
);
console.log(
  `Whole-source conservative function coverage: ${(functionRatio * 100).toFixed(2)}%` +
    ` (${coveredFunctions}/${totalFunctions}; missing modules count as fully uncovered)`
);
if (missingFiles.length > 0) {
  console.log(`Coverage report omitted: ${missingFiles.join(", ")}`);
}
if (lineRatio < MINIMUM_COVERAGE || functionRatio < MINIMUM_COVERAGE) {
  throw new Error(`whole-source line and function coverage must each be at least 80%`);
}
