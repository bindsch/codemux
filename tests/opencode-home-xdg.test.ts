/**
 * OpenCode's XDG directories are read exactly as the child process reads
 * them (review round 45): a whitespace-padded value is not silently
 * trimmed into a different directory than OpenCode uses; it is refused as
 * the non-absolute path it is.
 */

import { expect, test } from "bun:test";
import { opencodeRealDataParent, opencodeRealStateDir } from "../src/adapters/opencode-home.js";

test("a padded XDG_DATA_HOME or XDG_STATE_HOME is refused, not trimmed", () => {
  expect(() => opencodeRealDataParent({ XDG_DATA_HOME: " /tmp/data" }, "/home/u")).toThrow("XDG_DATA_HOME must be an absolute path");
  expect(() => opencodeRealStateDir({ XDG_STATE_HOME: "/tmp/state " }, "/home/u")).not.toThrow();
  expect(opencodeRealStateDir({ XDG_STATE_HOME: "/tmp/state " }, "/home/u")).toBe("/tmp/state /opencode");
  expect(opencodeRealDataParent({ XDG_DATA_HOME: "/tmp/data" }, "/home/u")).toBe("/tmp/data");
  expect(opencodeRealDataParent({}, "/home/u")).toBe("/home/u/.local/share");
});
