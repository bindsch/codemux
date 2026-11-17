import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { printedCommand, resolvedBinaryPaths, verifyPrintedSandbox } from "../scripts/live-gate/print-probe.js";

test("printed sandbox validation identifies the launched binary beyond env assignments", () => {
  expect(verifyPrintedSandbox("scode\n--\nenv\nHOME=/private\nagy\n", "agy")).toBeNull();
  expect(verifyPrintedSandbox("/tools/scode\n--\n/native/entry\n", "kimi", "kimi", () => ["/native/entry"])).toBeNull();
  expect(verifyPrintedSandbox("", "agy")).toBe("nothing was printed");
  expect(verifyPrintedSandbox("echo\nscode\n--\nagy\n", "agy")).toContain("does not name scode");
  expect(verifyPrintedSandbox("scode\n--\necho\nagy\n", "agy", "agy", () => [])).toContain("does not name the agy binary");
  expect(printedCommand(["scode"])).toBeNull();
  expect(printedCommand(["scode", "--"])).toBeNull();
  expect(printedCommand(["scode", "--", "env", "--unsupported", "agy"])).toBeNull();
});

test("binary lookup resolves an executable symlink without starting it", () => {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "print-probe-"));
  try {
    const entry = join(root, "synthetic-harness");
    symlinkSync(process.execPath, entry);
    expect(resolvedBinaryPaths("synthetic-harness", root)).toEqual([entry, realpathSync(process.execPath)]);
    expect(resolvedBinaryPaths("missing-harness", root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
