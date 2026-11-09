/**
 * resolveTrustedCommand keeps `env` under its own name for multi-call
 * binaries, but never a relative spelling (review round 48): a relative PATH
 * entry is validated against this process's directory and would resolve
 * under the child's --cwd to a different file.
 */

import { expect, spyOn, test } from "bun:test";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { resolveTrustedCommand } from "../src/executable-security.js";

test("a relative PATH answer for the env prefix is made absolute before the child sees it", () => {
  const relativeEnv = relative(process.cwd(), "/usr/bin/env");
  expect(isAbsolute(relativeEnv)).toBe(false);
  const which = spyOn(Bun, "which").mockImplementation(((name: string) =>
    name === "env" ? relativeEnv : name === "true" ? "/usr/bin/true" : null) as typeof Bun.which);
  try {
    const resolved = resolveTrustedCommand(["env", "HOME=/tmp/x", "true"], "test");
    expect(resolved[0]).toBe(resolve(relativeEnv));
    expect(isAbsolute(resolved[0]!)).toBe(true);
    // The trusted spelling is the link's target: /usr/bin/true is itself
    // on macOS but a link to gnutrue on Ubuntu 26.04 (CI run 42681779732).
    expect(resolved[2]).toBe(realpathSync("/usr/bin/true"));
  } finally {
    which.mockRestore();
  }
});
