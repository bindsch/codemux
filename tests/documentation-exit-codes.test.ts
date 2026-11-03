/**
 * Two drift guards the exit-code contract (review round 2, contracts 1)
 * and the docs-path cleanup (edges minor 3) need:
 *
 * 1. Every refusal message the exit-code table in docs/cli.md quotes for
 *    exit 64 must appear in the source next to the construct that makes
 *    it a 64 (UsageRefusalError, usageError, asUsage, promptRefusal,
 *    failInvalidOption, or a direct process.exit(64)), so the table can
 *    never describe a code the implementation no longer produces.
 * 2. Every docs/<name>.md path a test quotes must name an existing file,
 *    the same rule documentation.test.ts already enforces for src/.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const sourceFiles = (directory: string): string[] =>
  readdirSync(join(root, directory)).flatMap((name) => {
    const path = join(directory, name);
    return statSync(join(root, path)).isDirectory()
      ? sourceFiles(path)
      : path.endsWith(".ts") ? [path] : [];
  });

describe("the exit-64 contract between docs/cli.md and the source", () => {
  const row = read("docs/cli.md")
    .split("## Exit codes\n")[1]!
    .split("\n## ")[0]!
    .split("\n")
    .find((line) => line.startsWith("| 64 |"))!;
  // Only explicit quotations are checked: prose clauses (an unreadable or
  // empty -f file) describe classes of refusals, not literal messages.
  const quoted = [...row.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);

  test("the 64 row quotes the refusal messages it pins", () => {
    expect(quoted.length).toBeGreaterThanOrEqual(7);
  });

  test("each quoted refusal appears in the source beside a 64 construct", () => {
    const sources = sourceFiles("src").map((path) => ({ path, text: read(path) }));
    expect(sources.length).toBeGreaterThan(100);
    const markers = /UsageRefusalError|usageError|asUsage|promptRefusal|failInvalidOption|exit\(64\)/;
    for (const message of quoted) {
      const near = sources.some(({ text }) => {
        const lines = text.split("\n");
        return lines.some((line, index) => {
          if (!line.includes(message)) return false;
          return lines
            .slice(Math.max(0, index - 6), index + 7)
            .some((window) => markers.test(window));
        });
      });
      expect(near, JSON.stringify(message)).toBe(true);
    }
  });

  test("the run and session prompts share one quoted message", () => {
    // The row quotes one prompt refusal; both commands that emit it must
    // carry it, or the table describes only one of them.
    expect(read("src/run-command.ts")).toContain(quoted[0]!);
  });
});

describe("docs paths quoted in tests", () => {
  test("every docs/<name>.md path a test names exists", () => {
    let named = 0;
    for (const path of sourceFiles("tests")) {
      const text = read(path).replace(/https?:\/\/[^\s"'`)]+/g, "");
      // A fixture the test writes itself (a synthetic installed-layout
      // document) is not a repository document reference: its name on a
      // writeFileSync line (the path may be joined from parts) exempts
      // every mention of that basename in the file.
      const written = new Set(
        text.split("\n")
          .filter((line) => line.includes("writeFileSync"))
          .flatMap((line) => [...line.matchAll(/([A-Za-z0-9_.-]+\.md)/g)].map((m) => m[1]!))
      );
      for (const match of text.matchAll(/docs\/[A-Za-z0-9_./-]+\.md/g)) {
        if (written.has(match[0]!.split("/").pop()!)) continue;
        named++;
        expect(existsSync(join(root, match[0]!)), path + " names " + match[0]).toBe(true);
      }
    }
    expect(named).toBeGreaterThan(0);
  });
});
