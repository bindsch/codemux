import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("release guide gives alias then agent mapping order", () => {
  expect(read("docs/RELEASE-GATE.md")).toContain("models.worker.codex");
  expect(read("docs/RELEASE-GATE.md")).not.toContain("models.codex.worker");
});
test("Playwright limitations do not cite an absent scratch patch", () => {
  for (const path of ["docs/harnesses.md", "src/parity/reasons-run-w2.ts", "src/parity/reasons-session-w2.ts"]) {
    expect(read(path)).not.toContain("scratch/fix/w2-playwright.patch");
    expect(read(path)).toContain("CLI refuses the flag");
  }
});
test("changelog describes caller-owned homes on all session agents", () => {
  expect(read("CHANGELOG.md")).toContain("persistent caller-owned home for all 16 session agents");
});
