import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUtf8FileBounded } from "../src/file-io.js";

describe("bounded UTF-8 file reads", () => {
  test("rejects malformed UTF-8 instead of silently replacing bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-utf8-"));
    const path = join(dir, "invalid.txt");
    try {
      writeFileSync(path, Uint8Array.from([0x66, 0x80, 0x6f]));
      expect(() => readUtf8FileBounded(path, {
        maxBytes: 16,
        label: "test input",
      })).toThrow("valid UTF-8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects non-regular and oversized inputs", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-bounded-"));
    const nested = join(dir, "nested");
    const path = join(dir, "large.txt");
    mkdirSync(nested);
    writeFileSync(path, "12345");
    try {
      expect(() => readUtf8FileBounded(nested, {
        maxBytes: 16,
        label: "test input",
      })).toThrow("not a regular file");
      expect(() => readUtf8FileBounded(path, {
        maxBytes: 4,
        label: "test input",
      })).toThrow("exceeds 4 bytes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("can reject symbolic links for credential reads", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "codemux-nofollow-"));
    const target = join(dir, "target");
    const link = join(dir, "link");
    writeFileSync(target, "secret");
    symlinkSync(target, link);
    try {
      expect(() => readUtf8FileBounded(link, {
        maxBytes: 16,
        label: "credential",
        noFollow: true,
      })).toThrow("must not be a symbolic link");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
