import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Review live17, contracts minor 2: the codex fake's header read as the
// complete scenario menu while three e2e-driven scenarios lived only in
// its switch (the claude fake had the same gap). Every scenario a fake
// implements must be named in its header, so the menu cannot drift again.
// Audit findings 8 and 15: the fixture set is ENUMERATED here, never
// hardcoded — a new *.ts fixture lands under tests/fixtures/live/ and is
// covered by both guards below without touching this file.
//
// Scope: the *.ts EXECUTABLE fixtures only (fake harnesses, run fakes,
// the live-check endpoint). The *.ndjson files are data recordings, not
// scripts — no header, no scenario switch — so neither guard applies to
// them; tests/fixtures/live/README.md documents both kinds. This file
// itself names no fixture (the enumeration is dynamic), so it cannot
// satisfy the inventory below on any fixture's behalf.
const FIXTURES_DIR = join(import.meta.dir, "fixtures", "live");
const README_PATH = join(FIXTURES_DIR, "README.md");

const fixtureNames = readdirSync(FIXTURES_DIR)
  .filter((name) => name.endsWith(".ts"))
  .sort();

const fixtureText = (name: string): string =>
  readFileSync(join(FIXTURES_DIR, name), "utf8");

/** The scenario names a fixture's header comment lists, one per
 * `name — …` (or `name (qualifier) — …`, the "(default)" spelling)
 * menu line. */
const listedScenarios = (text: string): Set<string> =>
  new Set(
    [
      ...text
        .slice(0, text.indexOf("*/"))
        .matchAll(/^ \*\s+([a-z0-9-]+)(?:\s+\([^)]*\))?\s+—/gm),
    ].map((match) => match[1]!)
  );

/** The scenario names the fixture's top-level switch implements. */
const implementedScenarios = (text: string): string[] =>
  [...text.matchAll(/^ {4}case "([a-z0-9-]+)":/gm)].map((match) => match[1]!);

describe("fake harness headers list every scenario", () => {
  for (const name of fixtureNames) {
    test(name, () => {
      const text = fixtureText(name);
      const listed = listedScenarios(text);
      const implemented = implementedScenarios(text);
      // A fixture with no scenario switch (an endpoint fake, not a
      // scenario fake) has nothing to list; the health test below keeps
      // this exemption from hollowing the guard out.
      expect(implemented.filter((scenario) => !listed.has(scenario))).toEqual([]);
    });
  }

  test("the guard still sees scenarios", () => {
    // A header or case regex that drifted into matching nothing would
    // pass every per-fixture test above trivially. The enumeration found
    // fixtures, and across them the case regex still sees scenarios.
    expect(fixtureNames.length).toBeGreaterThan(0);
    const total = fixtureNames.reduce(
      (sum, name) => sum + implementedScenarios(fixtureText(name)).length,
      0
    );
    expect(total).toBeGreaterThan(0);
  });
});

/** Every non-fixture TypeScript file under tests/ — test files and the
 * helpers they import (tests/fixtures/** excluded: a fixture referencing
 * a fixture is not a test). */
function collectTestSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path === FIXTURES_DIR) continue;
      collectTestSources(path, out);
    } else if (entry.name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

describe("every live fixture is imported by a test or manual-only", () => {
  test("fixture inventory", () => {
    // Audit finding 15: a fixture no test imports rots silently — nothing
    // compiles or runs it in CI. Every *.ts fixture under
    // tests/fixtures/live/ must be either referenced by some test-side
    // source under tests/ (the import may ride a helper module the test
    // files import) or named on a manual-only line of README.md, so a
    // deliberately untested fixture is a recorded decision, not an
    // oversight.
    const sources = collectTestSources(import.meta.dir).map((path) => ({
      path,
      text: readFileSync(path, "utf8"),
    }));
    const readme = readFileSync(README_PATH, "utf8").split("\n");
    expect(fixtureNames.length).toBeGreaterThan(0);
    const orphans: string[] = [];
    for (const name of fixtureNames) {
      const baseName = name.replace(/\.ts$/, "");
      const imported = sources.some((source) => source.text.includes(baseName));
      const manualOnly = readme.some(
        (line) => line.includes(name) && line.includes("manual-only")
      );
      if (!imported && !manualOnly) orphans.push(name);
    }
    expect(orphans).toEqual([]);
    // The marker is load-bearing: a README entry that names the fixture
    // without the literal "manual-only" on the same line satisfies
    // nothing, so at least one entry must carry it for the guard above
    // to be more than a tautology when an orphan exists.
    expect(readme.some((line) => line.includes("manual-only"))).toBe(true);
  });
});
