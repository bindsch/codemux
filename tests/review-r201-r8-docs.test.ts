import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the session exit contract describes expected interrupted turns", () => {
  const doc = read("docs/session-protocol.md");
  expect(doc).toContain("expected interrupted turn in Aider, OpenCode, or Kimi");
  expect(doc).toContain("later orderly session end reports success");
  expect(doc).not.toContain("Every nonzero child exit");
});
test("native token totals need not expose the input/cache split", () => {
  const doc = read("docs/session-protocol.md");
  expect(doc).toContain("known native total can remain available");
  expect(doc).toContain("split is unknown (for example, Gemini ACP)");
});
test("Pi session model selection includes the provider environment", () => {
  expect(read("docs/sessions.md")).toContain("from `--model` or `CODEMUX_PI_PROVIDER_MODEL`");
});
test("result API documents normalized and assembled answers", () => {
  const source = read("src/types.ts");
  expect(source).toContain("including assembling its answer field");
  expect(source).not.toContain("every harness field unchanged");
});
test("budget API documents Pi and post-call overshoot", () => {
  const source = read("src/types.ts");
  expect(source).toContain("soft dollar spend threshold for this run (claude, zai, and pi)");
  expect(source).toContain("a call may exceed the threshold");
});
