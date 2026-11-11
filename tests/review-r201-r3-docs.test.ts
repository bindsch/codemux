import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Pi release notes allow ordinary provider sessions and the override model", () => {
  const changelog = read("CHANGELOG.md");
  expect(changelog).not.toContain("pi's override session requires `--hermetic` plus `--model`");
  expect(changelog).toContain("Pi accepts the override's model in plain and hermetic sessions");
});

test("list reference describes writable Codex tool removal", () => {
  const cli = read("docs/cli.md");
  expect(cli).not.toContain("codex: `--tools none` needs `--auto read-only`");
  expect(cli).toContain("Codex supports `--tools none` at every autonomy level");
});

test("deliverability comment matches serialized transport bounds", () => {
  const driver = read("src/session/turn-driver.ts");
  expect(driver).not.toContain("carrier rides the protocol's 16 MiB text bound");
  expect(driver).toContain("serialized transport bound");
});
