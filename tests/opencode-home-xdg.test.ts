/**
 * OpenCode's XDG directories are read exactly as the child process reads
 * them (review round 45): a whitespace-padded value is not silently
 * trimmed into a different directory than OpenCode uses; it is refused as
 * the non-absolute path it is.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import { opencodeRealDataParent, opencodeRealStateDir } from "../src/adapters/opencode-home.js";
import type { RunRequest } from "../src/types.js";

test("the run and TUI boundaries refuse a relative inherited XDG directory before any spawn", () => {
  // Review round 286: the sanitized child environment forwards
  // XDG_CONFIG_HOME, XDG_DATA_HOME, and XDG_STATE_HOME on every opencode
  // run (environment.ts INERT_ENV), no --pass-env needed, and OpenCode
  // resolves a relative value beneath the working directory — config the
  // adapter's project-config walk never sees. Both boundaries refuse it,
  // naming the variable.
  const cwd = mkdtempSync(join(tmpdir(), "codemux-opencode-xdg-"));
  try {
    const request: RunRequest = { agent: "opencode", prompt: "p", cwd } as RunRequest;
    for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const) {
      const adapter = new OpencodeAdapter({ [name]: "relative/dir" });
      expect(() => adapter.validateRunRequest(request)).toThrow(`${name} must be an absolute path`);
      expect(() => adapter.validateTuiRequest(undefined, cwd, "read-only", undefined, [], false))
        .toThrow(`${name} must be an absolute path`);
    }
    const absolute = new OpencodeAdapter({ XDG_CONFIG_HOME: "/tmp/config", XDG_DATA_HOME: "/tmp/data", XDG_STATE_HOME: "/tmp/state" });
    expect(() => absolute.validateRunRequest(request)).not.toThrow();
    expect(() => absolute.validateTuiRequest(undefined, cwd)).not.toThrow();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a padded XDG_DATA_HOME or XDG_STATE_HOME is refused, not trimmed", () => {
  expect(() => opencodeRealDataParent({ XDG_DATA_HOME: " /tmp/data" }, "/home/u")).toThrow("XDG_DATA_HOME must be an absolute path");
  expect(() => opencodeRealStateDir({ XDG_STATE_HOME: "/tmp/state " }, "/home/u")).not.toThrow();
  expect(opencodeRealStateDir({ XDG_STATE_HOME: "/tmp/state " }, "/home/u")).toBe("/tmp/state /opencode");
  expect(opencodeRealDataParent({ XDG_DATA_HOME: "/tmp/data" }, "/home/u")).toBe("/tmp/data");
  expect(opencodeRealDataParent({}, "/home/u")).toBe("/home/u/.local/share");
});
