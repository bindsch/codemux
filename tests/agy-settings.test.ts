/**
 * The agy settings read (review round 147): one bounded, typed read through
 * readUtf8FileBounded instead of an unbounded pathname read that could park
 * medium-autonomy preparation on a FIFO forever. Every test hands the
 * function its own path in a temp directory; the Keychain and home seams
 * are never reached.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headlessMediumSettings, MAX_AGY_SETTINGS_BYTES } from "../src/adapters/agy-settings.js";

describe("headlessMediumSettings", () => {
  const root = (): string => mkdtempSync(join(tmpdir(), "codemux-agy-settings-"));

  test("a missing file is the operator's default state: empty grants plus the command grant", () => {
    const dir = root();
    try {
      const settings = JSON.parse(headlessMediumSettings(join(dir, "absent.json")));
      expect(settings).toEqual({ permissions: { allow: ["command(*)"] } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a valid file is merged as before: its rules kept, the command grant added once", () => {
    const dir = root();
    try {
      const path = join(dir, "settings.json");
      writeFileSync(path, JSON.stringify({
        model: "gemini-pro",
        permissions: { allow: ["read_file(/tmp/**)", "command(*)"], deny: ["write_file"] },
      }));
      const settings = JSON.parse(headlessMediumSettings(path));
      expect(settings.model).toBe("gemini-pro");
      expect(settings.permissions.deny).toEqual(["write_file"]);
      expect(settings.permissions.allow).toEqual(["read_file(/tmp/**)", "command(*)"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a FIFO is refused at once instead of parking the read (review round 147)", () => {
    const dir = root();
    try {
      const fifo = join(dir, "settings.json");
      const made = Bun.spawnSync(["mkfifo", fifo]);
      if (made.exitCode !== 0) return; // no mkfifo here: nothing to prove
      const started = performance.now();
      expect(() => headlessMediumSettings(fifo)).toThrow(`cannot read agy settings: ${fifo}`);
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a directory is refused, not walked", () => {
    const dir = root();
    try {
      const asDirectory = join(dir, "settings.json");
      mkdirSync(asDirectory);
      expect(() => headlessMediumSettings(asDirectory)).toThrow(`cannot read agy settings: ${asDirectory}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file past the bound is refused, never read whole", () => {
    const dir = root();
    try {
      const path = join(dir, "settings.json");
      writeFileSync(path, " ".repeat(MAX_AGY_SETTINGS_BYTES + 1));
      expect(() => headlessMediumSettings(path)).toThrow(`cannot read agy settings: ${path}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unparseable or non-object settings are refused", () => {
    const dir = root();
    try {
      const path = join(dir, "settings.json");
      for (const [content, message] of [
        ["{not json", `cannot read agy settings: ${path}`],
        ["[]", `invalid agy settings object: ${path}`],
        ["null", `invalid agy settings object: ${path}`],
      ] as const) {
        writeFileSync(path, content);
        expect(() => headlessMediumSettings(path)).toThrow(message);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
