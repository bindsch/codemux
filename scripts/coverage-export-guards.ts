/**
 * The three AST guards behind the type-only coverage waiver (src/ files
 * that declare types only): how many runtime functions, how many runtime
 * value exports, and how many top-level runtime statements a file
 * carries, with the waiver lists they judge. Split from
 * check-source-coverage.ts for the 500-line ceiling; that script imports
 * and re-exports them, so its public surface is unchanged.
 */
import ts from "typescript";

/**
 * Waivers from the per-file floor, each with its reason. Keep this list
 * short: a file lands here only when the suite structurally cannot load it
 * in-process, never because its tests are merely missing.
 */
// Type-only modules: no runtime export, so Bun can never report them.
// src/session/aider-options.ts and src/session/opencode-options.ts hold
// the driver option records their finalize modules re-export as `export
// type` (the 500-line split, review round 162) — erased at compile time,
// so the suite structurally cannot load them in-process.
export const TYPE_ONLY_FILES = new Set([
  "src/run-context.ts",
  "src/session/aider-options.ts",
  "src/session/opencode-options.ts",
]);
// Child-only entry surfaces: exercised by spawned `bin/codemux` tests whose
// coverage Bun does not merge (docs/TESTING.md). They still count as fully
// uncovered in the whole-source ratios below, so a waiver hides nothing
// there. src/index.ts runs `await program.parseAsync()` at import top level;
// the two scripts/* version gates run under `make`, not under `bun test`.
// src/session/cli.ts and its phase modules are NOT here: the in-process
// session command suites (tests/session-cli-command*.test.ts,
// tests/session-cli-phases.test.ts) drive registerSessionCommand through
// commander inside the coverage process, so the per-file floor applies.
// scripts/live-gate/run.ts and scripts/check-installed-layout.ts are NOT
// here either: their suites import them in process (tests/live-gate*.test.ts
// through the scripts/live-gate.js barrel, tests/installed-layout.test.ts
// directly), so the per-file floor applies (review round 8, edges).
export const CHILD_ONLY_FILES = new Set([
  "src/index.ts",
  "scripts/check-bun-version.ts",
  "scripts/check-scode-version.ts",
  "scripts/live-gate.ts",
]);
// Platform- or dispatch-gated files, waived from the per-file floor only
// (they still count in the whole-source ratios). src/process-signal.ts's
// unhit arm is the no-process-groups fallback for win32; this gate runs on
// darwin and Linux, where process groups exist and the arm cannot execute.
// src/private-dir-signals.ts is signal dispatch and nothing else: onSignal
// and the handler arrows trackPrivateDir installs run only from a real
// signal, which ends the test process. The module was split out of
// src/hermetic-home.ts for exactly that boundary (review round 9,
// contracts-2), so hermetic-home itself stays inside the floor.
export const PLATFORM_GATED_FILES = new Set([
  "src/process-signal.ts",
  "src/private-dir-signals.ts",
]);

export function physicalLineCount(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

export function runtimeFunctionCount(content: string, path: string): number {
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

/** Runtime VALUE exports a type-only waiver forbids (round 20, minor 10):
 * an exported const, let, var, class, or enum is runtime behavior in a
 * file the waiver drops from every floor, and runtimeFunctionCount alone
 * never noticed it. Types, interfaces, and type aliases are the waiver's
 * reason to exist and never count. */
export function runtimeValueExportCount(content: string, path: string): number {
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  let values = 0;
  const isExported = (modifiers: readonly ts.ModifierLike[] | undefined): boolean =>
    modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  function visit(node: ts.Node): void {
    if (
      (ts.isVariableStatement(node) && isExported(node.modifiers)) ||
      ((ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) &&
        node.modifiers !== undefined &&
        isExported(node.modifiers))
    ) {
      values += 1;
    } else if (ts.isExportAssignment(node)) {
      // `export default <expr>` and `export = <expr>` are runtime values.
      values += 1;
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.exportClause === undefined) {
      // `export * from "./x"` re-exports whatever x exports; a waived file
      // must not carry it (round 28, edges 4).
      values += 1;
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.exportClause !== undefined &&
      ts.isNamedExports(node.exportClause)) {
      // `export { value }` and `export { value } from "./x"` re-export
      // runtime values unless each specifier is type-only (round 24, edges 4).
      values += node.exportClause.elements.filter((element) => !element.isTypeOnly).length;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return values;
}

/** Top-level statements a type-only waiver forbids (review round 151):
 * the two guards above count runtime functions and value exports, so a
 * waived file could still gain executable behavior through a top-level
 * statement — `const cache = initialize()`, a side-effect import, a class
 * static block — while both counts stayed zero. Allowed is only what the
 * compiler erases: type-only imports (an import whose every named
 * specifier is `type`, with no default or namespace binding), `export
 * type` and type-only re-exports, interface and type alias declarations,
 * ambient `declare` statements, and empty statements. Everything else
 * counts one per top-level statement. */
export function runtimeStatementCount(content: string, path: string): number {
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const modifiersOf = (node: ts.Node): readonly ts.ModifierLike[] | undefined =>
    (node as { modifiers?: readonly ts.ModifierLike[] }).modifiers;
  const isErasedImport = (node: ts.ImportDeclaration): boolean => {
    const clause = node.importClause;
    // `import "./x.js"` runs for its side effect: it is not erased.
    if (clause === undefined) return false;
    if (clause.isTypeOnly) return true;
    // A default or namespace binding is a value.
    if (clause.name !== undefined) return false;
    const bindings = clause.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings) || bindings.elements.length === 0) {
      return false;
    }
    return bindings.elements.every((element) => element.isTypeOnly);
  };
  const isErasedExport = (node: ts.ExportDeclaration): boolean => {
    if (node.isTypeOnly) return true;
    // `export * from` re-exports values; `export {}` is not one of the
    // allowed shapes either.
    if (node.exportClause === undefined || !ts.isNamedExports(node.exportClause)) return false;
    if (node.exportClause.elements.length === 0) return false;
    return node.exportClause.elements.every((element) => element.isTypeOnly);
  };
  const isAmbient = (node: ts.Node): boolean =>
    modifiersOf(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ?? false;
  let statements = 0;
  for (const statement of sourceFile.statements) {
    if (ts.isEmptyStatement(statement)) continue;
    if (ts.isImportDeclaration(statement) && isErasedImport(statement)) continue;
    if (ts.isExportDeclaration(statement) && isErasedExport(statement)) continue;
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
    if (isAmbient(statement)) continue;
    statements += 1;
  }
  return statements;
}
