/**
 * The credential copy of an --experiment-project-settings run (review
 * round 1, major): the mirror is read ONCE — the refresh-token check and
 * the copy decide on the same bytes — so a mirror swapped between a check
 * read and a copy read cannot hand the private directory content the check
 * never saw. A refresh-token mirror and an unparseable mirror are both
 * refused; nothing unparseable is copied. The copy is built from the
 * parsed `claudeAiOauth` alone (review round 13): co-stored `mcpOAuth`
 * entries with their own refresh tokens never reach the private directory.
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyClaudeCredentialMirror } from "../src/claude-project-config.js";

const ACCESS_ONLY = JSON.stringify({
  claudeAiOauth: { accessToken: "at", refreshToken: "", expiresAt: 4102444800, scopes: [] },
}) + "\n";
const WITH_REFRESH = JSON.stringify({
  claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: 4102444800, scopes: [] },
}) + "\n";
// Claude Code co-stores per-server MCP OAuth state in the same file, each
// entry with its own refresh token (review round 13, edges finding 1).
const WITH_MCPOAUTH = JSON.stringify({
  claudeAiOauth: { accessToken: "at", refreshToken: "", expiresAt: 4102444800, scopes: [] },
  mcpOAuth: {
    "slack-us-east": {
      accessToken: "mcp-at",
      refreshToken: "mcp-rt",
      refreshTokenExpiresAt: 4102444800,
    },
  },
}) + "\n";

describe("copyClaudeCredentialMirror", () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const directory = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-mirror-copy-"));
    scratch.push(dir);
    return dir;
  };
  const mirrorIn = (dir: string, content: string): string => {
    const mirror = join(dir, "mirror.json");
    writeFileSync(mirror, content, { mode: 0o600 });
    return mirror;
  };
  // The mirror's single read is spied per test at both shapes it has had:
  // a string-path readFileSync, and the O_NOFOLLOW openSync whose
  // descriptor the one readFileSync consumes (round 15, edges 1). Every
  // read of the mirror itself is recorded, so the single-read contract is
  // asserted, not assumed.
  const withMirrorReads = (mirror: string, body: () => void): string[] => {
    const reads: string[] = [];
    const originalRead = fs.readFileSync;
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, options?: unknown) => {
      if (typeof path === "string" && path === mirror) reads.push(path);
      return originalRead(path, options as never);
    }) as typeof fs.readFileSync);
    const originalOpen = fs.openSync;
    const openSpy = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags?: unknown, mode?: unknown) => {
      if (path === mirror) reads.push(path as string);
      return originalOpen(path, flags as never, mode as never);
    }) as typeof fs.openSync);
    try {
      body();
    } finally {
      readSpy.mockRestore();
      openSpy.mockRestore();
    }
    return reads;
  };

  test("a valid access-only mirror copies its claudeAiOauth field for field, mode 0600, one read", () => {
    const dir = directory();
    const mirror = mirrorIn(dir, ACCESS_ONLY);
    const reads = withMirrorReads(mirror, () => {
      copyClaudeCredentialMirror(dir, mirror);
    });
    // The single-read contract: the check and the copy share one read, so
    // a swap between two reads has no window.
    expect(reads).toEqual([mirror]);
    const copy = join(dir, ".credentials.json");
    expect(existsSync(copy)).toBe(true);
    const written = JSON.parse(readFileSync(copy, "utf8"));
    expect(Object.keys(written)).toEqual(["claudeAiOauth"]);
    expect(written.claudeAiOauth).toEqual(
      JSON.parse(ACCESS_ONLY).claudeAiOauth
    );
    expect(statSync(copy).mode & 0o777).toBe(0o600);
  });

  test("co-stored mcpOAuth entries never reach the private copy", () => {
    const dir = directory();
    const mirror = mirrorIn(dir, WITH_MCPOAUTH);
    copyClaudeCredentialMirror(dir, mirror);
    const copy = join(dir, ".credentials.json");
    expect(existsSync(copy)).toBe(true);
    const bytes = readFileSync(copy).toString("utf8");
    // The copy holds only the access-only claudeAiOauth object: no
    // mcpOAuth key, and no co-stored refresh token string in the bytes.
    const written = JSON.parse(bytes);
    expect(Object.keys(written)).toEqual(["claudeAiOauth"]);
    expect(written.mcpOAuth).toBeUndefined();
    expect(written.claudeAiOauth).toEqual(JSON.parse(WITH_MCPOAUTH).claudeAiOauth);
    expect(bytes).not.toContain("mcp-rt");
    expect(bytes).not.toContain("mcpOAuth");
  });

  test("a mirror carrying a refresh token is refused and nothing is copied", () => {
    const dir = directory();
    const mirror = mirrorIn(dir, WITH_REFRESH);
    const reads = withMirrorReads(mirror, () => {
      expect(() => copyClaudeCredentialMirror(dir, mirror)).toThrow("holds a refresh token");
    });
    expect(reads).toEqual([mirror]);
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
  });

  test("an unparseable mirror is refused and nothing is copied", () => {
    const dir = directory();
    const mirror = mirrorIn(dir, "not json at all\n");
    const reads = withMirrorReads(mirror, () => {
      expect(() => copyClaudeCredentialMirror(dir, mirror)).toThrow(
        "is not a parseable credential object"
      );
    });
    expect(reads).toEqual([mirror]);
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
  });

  test("a mirror that is JSON but not a credential object is refused", () => {
    const dir = directory();
    const mirror = mirrorIn(dir, JSON.stringify({ something: "else" }) + "\n");
    expect(() => copyClaudeCredentialMirror(dir, mirror)).toThrow(
      "is not a parseable credential object"
    );
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
  });

  test("a mirror with an invalid UTF-8 byte inside the access token is refused, nothing copied (round 104)", () => {
    // A lossy decode turned the invalid byte into U+FFFD, which still
    // parsed — and the copy would then carry a DIFFERENT token than the
    // one the mirror holds. The decode is fatal now; the refusal names the
    // encoding problem, never the content.
    const dir = directory();
    const mirror = join(dir, "mirror.json");
    const head = Buffer.from(
      `{"claudeAiOauth":{"accessToken":"at`,
      "utf8"
    );
    const tail = Buffer.from(`","refreshToken":"","expiresAt":4102444800,"scopes":[]}}\n`, "utf8");
    // 0xFF alone is never valid UTF-8, wherever it falls.
    writeFileSync(mirror, Buffer.concat([head, Buffer.from([0xff]), tail]), { mode: 0o600 });
    const reads = withMirrorReads(mirror, () => {
      expect(() => copyClaudeCredentialMirror(dir, mirror)).toThrow("is not valid UTF-8");
    });
    expect(reads).toEqual([mirror]);
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
  });

  test("no mirror at all copies nothing", () => {
    const dir = directory();
    copyClaudeCredentialMirror(dir, join(dir, "absent.json"));
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
  });

  test("a mirror over the 64 KiB read bound is refused, one at the bound reads (round 16, minor 7)", () => {
    // The mirror is child-writable, so a prior sandboxed child could have
    // inflated it; the read is bounded. Exactly at the bound is fine —
    // the refusal names the bound so the operator can tell inflation
    // from a real credential object.
    const dir = directory();
    const oversized = mirrorIn(dir, ACCESS_ONLY.trimEnd() + " ".repeat(64 * 1024) + "x");
    expect(() => copyClaudeCredentialMirror(dir, oversized)).toThrow(
      "over the 65536-byte read bound"
    );
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
    // The symmetric case: whitespace-padded credentials at exactly the
    // bound parse (JSON ignores trailing whitespace) and copy normally.
    const atBound = mirrorIn(dir, ACCESS_ONLY.trimEnd() + " ".repeat(64 * 1024 - ACCESS_ONLY.length + 1));
    expect(atBound.length).toBeGreaterThan(0);
    copyClaudeCredentialMirror(dir, atBound);
    expect(existsSync(join(dir, ".credentials.json"))).toBe(true);
  });

  test("an unreadable mirror is refused with the error class, not mislabeled irregular (round 16, minor 8)", () => {
    const dir = directory();
    const mirror = mirrorIn(dir, ACCESS_ONLY);
    // EACCES at the open: a permissions problem is not a regularity
    // finding, and the message used to say "is not a regular file".
    const originalOpen = fs.openSync;
    const denied = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags?: unknown, mode?: unknown) => {
      if (path === mirror) {
        const error = new Error("probe: permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return originalOpen(path, flags as never, mode as never);
    }) as typeof fs.openSync);
    try {
      expect(() => copyClaudeCredentialMirror(dir, mirror)).toThrow(
        "could not read the credential mirror"
      );
      expect(() => copyClaudeCredentialMirror(dir, mirror)).toThrow("EACCES");
      expect(() => copyClaudeCredentialMirror(dir, mirror)).not.toThrow("not a regular file");
    } finally {
      denied.mockRestore();
    }
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
  });
});
