import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Review live17, contracts minor 2: the codex fake's header read as the
// complete scenario menu while three e2e-driven scenarios lived only in
// its switch (the claude fake had the same gap). Every scenario a fake
// implements must be named in its header, so the menu cannot drift again.
const FAKES = ["fake-claude-session.ts", "fake-codex-app-server.ts", "fake-agy-session.ts"];

describe("fake harness headers list every scenario", () => {
  for (const name of FAKES) {
    test(name, () => {
      const text = readFileSync(join(import.meta.dir, "fixtures", "live", name), "utf8");
      const header = text.slice(0, text.indexOf("*/"));
      const listed = new Set(
        [...header.matchAll(/^ \*\s+([a-z0-9-]+)\s+—/gm)].map((match) => match[1])
      );
      const implemented = [...text.matchAll(/^ {4}case "([a-z0-9-]+)":/gm)].map(
        (match) => match[1]
      );
      expect(implemented.length).toBeGreaterThan(0);
      expect(implemented.filter((scenario) => !listed.has(scenario))).toEqual([]);
    });
  }
});
