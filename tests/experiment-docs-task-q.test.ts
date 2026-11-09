import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (file: string) => readFileSync(resolve(file), "utf8").replace(/\s+/g, " ");

test("usage guarantees exclude interrupted and timed-out recordings in the guide and changelog", () => {
  for (const file of ["docs/results-and-usage.md", "docs/archive/changelog-2.0.0-details.md"]) {
    const text = read(file);
    expect(text).toContain("Every turn in a complete recording has exactly one usage record");
    expect(text).toContain("Interrupted or timed-out recordings can omit usage records");
  }
});

test("usage table documents every plain Kimi run reading the wire log", () => {
  const cells = read("docs/results-and-usage.md").match(/\| Kimi \|([^|]+)\|([^|]+)\|/);
  const row = cells?.[1];
  // Sessions read the turn's wire log too (session.usage, tests/kimi-session-usage.test.ts).
  expect(cells?.[2]).toContain("Turn counts from the turn's wire log");
  expect(row).toContain("Result-json and plain runs sum wire-log usage");
  expect(row).toContain("A binary that ignores the stream wire keeps its plain text and records unknown usage");
});
