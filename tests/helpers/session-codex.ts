import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The ceiling resolves realpaths, so its scope checks need a real
// directory (macOS /tmp is a symlink to /private/tmp).
export const CWD = mkdtempSync(join(tmpdir(), "codemux-codex-wire-"));
