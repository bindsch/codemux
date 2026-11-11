import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Agy limitation explains none as an omitted effort flag", () => {
  for (const path of ["docs/harnesses.md", "src/parity/reasons-run-w2.ts"]) {
    expect(read(path)).not.toContain("an explicit none request is refused");
    expect(read(path)).toContain("codemux omits the effort flag for none");
  }
});

test("release checklist distinguishes synthetic layout checks from formula installation", () => {
  expect(read("docs/RELEASE-GATE.md")).toContain("CI does not install the codemux formula");
  expect(read(".github/workflows/ci.yml")).not.toContain("brew install bindsch/tap/codemux");
});

test("Codex catalog version mismatch is a recorded warning", () => {
  const text = read("docs/experiment-codex-catalog.md");
  expect(text).not.toContain("a `client_version` matching the detected Codex version");
  expect(text).toContain("catalog_client_version_mismatch");
  expect(text).toContain("warning");
});
