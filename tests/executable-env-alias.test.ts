import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveTrustedCommand, trustCheckedCommandPaths } from "../src/executable-security.js";

const root = mkdtempSync(join(import.meta.dir, "../scratch/env-alias-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const bin = join(root, "bin");
mkdirSync(bin);
symlinkSync("/usr/bin/env", join(bin, "alias"));

test("an alias resolving to env resolves and checks its wrapped executable too", () => {
  const command = resolveTrustedCommand(["alias", "HOME=/synthetic", "echo", "ok"], "fixture", undefined, `${bin}:/bin:/usr/bin`);
  expect(trustCheckedCommandPaths(command)).toEqual([realpathSync("/usr/bin/env"), realpathSync("/bin/echo")]);
  expect(command.slice(-2)).toEqual([realpathSync("/bin/echo"), "ok"]);
});

test("an alias resolving to env refuses a missing program at resolution", () => {
  expect(() => resolveTrustedCommand(["alias"], "fixture", undefined, bin)).toThrow("env prefix names no program");
});
