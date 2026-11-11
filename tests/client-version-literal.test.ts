import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// A handshake that names codemux's own version must read package.json
// (codemuxClientVersion) or use a fixed placeholder such as "1", never a
// release literal that goes stale on the next bump: the pi MCP extension
// advertised 2.0.0 after the package moved to 2.0.1.
test("no source file hardcodes the package version in a clientInfo handshake", () => {
  const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".ts")) {
        const text = readFileSync(path, "utf8");
        if (/clientInfo:\s*\{[^}]*version:\s*"\d+\.\d+\.\d+"/.test(text)) offenders.push(path);
      }
    }
  };
  walk("src");
  expect(offenders, `package version ${version}`).toEqual([]);
});
