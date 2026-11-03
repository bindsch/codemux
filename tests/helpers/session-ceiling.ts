import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cmx-ceiling-"));
}
