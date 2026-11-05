import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessTokenLive } from "../src/credentials/oauth.js";
import { fileCarriesRefreshToken } from "../src/credentials.js";
import { SECRET } from "./helpers/credentials.js";

// Review round 96, whole tree, findings 4 and 6: the credential
// inspection helpers answer fail-closed on everything they cannot read
// or judge, and a malformed expiry never counts as a live token.

describe("accessTokenLive (review round 96)", () => {
  test("a present but non-numeric or non-finite expiry is not live", () => {
    const token = { accessToken: "t" };
    expect(accessTokenLive({ ...token, expiresAt: null })).toBe(false);
    expect(accessTokenLive({ ...token, expiresAt: "0" })).toBe(false);
    expect(accessTokenLive({ ...token, expiresAt: Number.NaN })).toBe(false);
    expect(accessTokenLive({ ...token, expiresAt: Number.POSITIVE_INFINITY })).toBe(false);
    expect(accessTokenLive({ ...token, expiresAt: {} })).toBe(false);
  });

  test("an absent expiry stays live and a numeric one is judged", () => {
    const token = { accessToken: "t" };
    // Absent means no expiry is known: the sync path's stand-alone-mirror
    // verdict ("missing" while the file's own token is live) relies on
    // this, and the stub classification requires a NUMBER, so a stub
    // never reaches this arm on an absent field.
    expect(accessTokenLive(token)).toBe(true);
    expect(accessTokenLive({ ...token, expiresAt: Date.now() + 1_000 })).toBe(true);
    expect(accessTokenLive({ ...token, expiresAt: Date.now() - 1_000 })).toBe(false);
    expect(accessTokenLive({ accessToken: "", expiresAt: Date.now() + 1_000 })).toBe(false);
  });
});

describe("fileCarriesRefreshToken (review round 96)", () => {
  const withDir = (fn: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-oauth-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("a readable file is judged by its content, an absent one carries nothing", () => {
    withDir((dir) => {
      const target = join(dir, ".credentials.json");
      writeFileSync(target, `${SECRET}\n`, { mode: 0o600 });
      expect(fileCarriesRefreshToken(target)).toBe(true);
      writeFileSync(
        target,
        `${JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "" } })}\n`,
        { mode: 0o600 }
      );
      expect(fileCarriesRefreshToken(target)).toBe(false);
      expect(fileCarriesRefreshToken(join(dir, "absent.json"))).toBe(false);
    });
  });

  test("an oversized file is refused unread and answers the fail-closed value", () => {
    withDir((dir) => {
      const target = join(dir, "big.json");
      // Over MAX_CREDENTIAL_MIRROR_BYTES (1 MiB): the bounded reader
      // refuses it without reading the whole file into memory.
      writeFileSync(target, "x".repeat(1024 * 1024 + 1));
      const started = Date.now();
      expect(fileCarriesRefreshToken(target)).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });

  test("a FIFO swapped in for the file is refused at once, not blocked on", () => {
    withDir((dir) => {
      const target = join(dir, ".credentials.json");
      const made = Bun.spawnSync(["mkfifo", target]);
      expect(made.exitCode).toBe(0);
      expect(statSync(target).isFIFO()).toBe(true);
      // The bounded reader opens nonblocking and refuses the descriptor
      // on its fstat: no writer ever appears, so a regression to a plain
      // open would block this test until its timeout instead of passing.
      const started = Date.now();
      expect(fileCarriesRefreshToken(target)).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(existsSync(target)).toBe(true);
    });
  });
});
