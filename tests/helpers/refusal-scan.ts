/** The AST refusal scanner shared by the parity refusal tests: finds every
 * UsageRefusalError/usageError/refuse call site in a source file and extracts
 * its message text, following identifiers, string concatenation, template
 * expressions, and same-repo imports, so comments, multiline concatenation,
 * and imported refusal constants cannot fool the scan. */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "..", "..");
const source = (file: string): string => readFileSync(join(root, file), "utf8");
const parsed = new Map<string, ts.SourceFile>();
function syntax(file: string): ts.SourceFile {
  if (!parsed.has(file)) parsed.set(file, ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true));
  return parsed.get(file)!;
}

function messageText(node: ts.Node, file: string, seen = new Set<string>()): string {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => `*${span.literal.text}`).join("");
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return messageText(node.left, file, seen) + messageText(node.right, file, seen);
  }
  if (ts.isIdentifier(node)) {
    const key = `${file}:${node.text}`;
    if (seen.has(key)) return "*";
    seen.add(key);
    let found: ts.Node | undefined;
    let imported: string | undefined;
    const visit = (child: ts.Node): void => {
      if (ts.isVariableDeclaration(child) && child.name.getText() === node.text) found = child.initializer;
      if (ts.isImportDeclaration(child) && child.importClause?.namedBindings && ts.isNamedImports(child.importClause.namedBindings)) {
        if (child.importClause.namedBindings.elements.some((item) => item.name.text === node.text) && ts.isStringLiteral(child.moduleSpecifier)) {
          imported = join(dirname(file), child.moduleSpecifier.text.replace(/\.js$/, ".ts"));
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(syntax(file));
    if (found) return messageText(found, file, seen);
    if (imported?.startsWith("src/")) return messageText(node, imported, seen);
  }
  return "*";
}

export interface RefusalSite { file: string; line: number; message: string; conditions: string; agentBound: boolean }

export function refusalSites(file: string, tree = syntax(file)): RefusalSite[] {
  const sites: RefusalSite[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && /^(UsageRefusalError|usageError|refuse)$/.test(node.expression.getText(tree))) {
      const argument = node.arguments?.[0];
      if (argument) {
        const conditions: string[] = [];
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (ts.isIfStatement(parent)) conditions.push(parent.expression.getText(tree));
        }
        sites.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
          message: messageText(argument, file), conditions: conditions.join(" "),
          agentBound: /\$\{(?:adapter\.id|this\.id|agentId|agent|request\.agent|guards\.agent)(?:\}|\.)/.test(argument.getText(tree)) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return sites;
}
