import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (file: string) => readFileSync(file, "utf8").replace(/\s+/g, " ");

test("Unreleased retry notes distinguish new response IDs and advanced cumulative totals", () => {
  const unreleased = read("CHANGELOG.md").split("## [0.15.1]")[0]!;
  expect(unreleased).not.toContain("usage snapshots without a pending response");
  expect(unreleased).toContain("A new response ID or advanced cumulative totals means a new response, even with equal counters");
});

test("Codex session shared scaffolding has a helpers header", () => {
  const header = read("tests/session-codex-e2e-helpers.ts").split("*/")[0]!;
  expect(header).toContain("Shared helpers for the Codex app-server session tests");
  expect(header).not.toContain("Every round-trip is live");
});

test("harness guide records the live Codex catalog override verification", () => {
  const guide = read("docs/harnesses.md");
  expect(guide).not.toContain("not yet verified live");
  expect(guide).toContain("gpt-6-astra");
  expect(guide).toContain("02:13 on October 29, 2026");
  expect(guide).toContain("experiment-codex-catalog.md");
});

test("usage guide and Unreleased notes describe all four timeout verification paths", () => {
  for (const file of ["docs/results-and-usage.md", "CHANGELOG.md"]) {
    expect(read(file)).toContain("Claude, Z.AI, Codex, and Kimi skip final usage verification on timeout");
  }
});
