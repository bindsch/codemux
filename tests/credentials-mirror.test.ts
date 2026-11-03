import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { syncKeychainCredential } from "../src/credentials.js";
import { BACKUPS, FUTURE, SECRET, gives, withTarget } from "./helpers/credentials.js";

const SAVED = ["CODEMUX_NO_KEYCHAIN_SYNC", "USER"] as const;
const saved = new Map<string, string | undefined>();
beforeEach(() => {
  for (const n of SAVED) {
    saved.set(n, process.env[n]);
    delete process.env[n];
  }
});
afterEach(() => {
  for (const n of SAVED) {
    const v = saved.get(n);
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
});

describe("syncKeychainCredential — a mirror of an existing file", () => {
  test("refreshes a stale mirror with the Keychain blob, atomically, 0600", () => {
    withTarget((target) => {
      const fresh = JSON.stringify({ claudeAiOauth: { accessToken: "new", refreshToken: "new" } });
      expect(syncKeychainCredential("svc", target, gives(fresh), BACKUPS(target))).toBe("synced");
      // The access token lands; the refresh token never does.
      expect(readFileSync(target, "utf8").trim()).toBe(
        JSON.stringify({ claudeAiOauth: { accessToken: "new", refreshToken: "" } })
      );
      expect(statSync(target).mode & 0o777).toBe(0o600);
    }, JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "old" } }));
  });

  test("does nothing — and never creates — when no mirror file exists", () => {
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("absent");
      expect(existsSync(target)).toBe(false);
    }, "");
  });

  test("reports current when the mirror already holds the Keychain's access token", () => {
    const mirror = JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "" } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("current");
      expect(readFileSync(target, "utf8").trim()).toBe(mirror);
    }, mirror);
  });

  // Regression for the 2026-10-05 lockout: a sandboxed child holding the
  // operator's refresh token rotated it (or presented a stale one), and the
  // provider revoked the whole grant — every interactive Claude session
  // logged out. The mirror must never carry a refresh token, and one that
  // does (written by an older codemux, or by Claude Code itself) is scrubbed
  // even when its access token is already the Keychain's.
  test("never copies the refresh token or its expiry into the mirror", () => {
    const keychain = JSON.stringify({
      claudeAiOauth: {
        accessToken: "live", refreshToken: "secret", expiresAt: FUTURE,
        refreshTokenExpiresAt: 9000, scopes: ["user:inference"], subscriptionType: "max",
      },
    });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(keychain), BACKUPS(target))).toBe("synced");
      const written = JSON.parse(readFileSync(target, "utf8")).claudeAiOauth;
      expect(written).toEqual({
        accessToken: "live", refreshToken: "", expiresAt: FUTURE,
        scopes: ["user:inference"], subscriptionType: "max",
      });
      expect(readFileSync(target, "utf8")).not.toContain("secret");
    }, JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0, scopes: [] } }));
  });

  test("a mirror still carrying a refresh token is scrubbed even when its access token matches", () => {
    const leaked = JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "r", expiresAt: 5000 } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("synced");
      expect(JSON.parse(readFileSync(target, "utf8")).claudeAiOauth).toEqual({
        accessToken: "t", refreshToken: "",
      });
    }, leaked);
  });

  test("only the claudeAiOauth field is synced; the file's own mcpOAuth is kept", () => {
    // File carries its own (newer) MCP token; Keychain carries a different
    // one plus a fresher claude token. Only the claude token should move.
    const fileBlob = JSON.stringify({
      claudeAiOauth: { accessToken: "old", refreshToken: "old", expiresAt: 1000 },
      mcpOAuth: { slack: { accessToken: "file-mcp" } },
    });
    const keychainBlob = JSON.stringify({
      claudeAiOauth: { accessToken: "new", refreshToken: "new", expiresAt: FUTURE },
      mcpOAuth: { slack: { accessToken: "keychain-mcp" } },
    });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(keychainBlob), BACKUPS(target))).toBe("synced");
      const written = JSON.parse(readFileSync(target, "utf8"));
      expect(written.claudeAiOauth.accessToken).toBe("new"); // claude token refreshed
      expect(written.mcpOAuth.slack.accessToken).toBe("file-mcp"); // file's MCP untouched
    }, fileBlob);
  });

  test("refreshes the emptied stub Claude Code 2.1.25x leaves on disk", () => {
    // Once the Keychain owns the credential, Claude Code rewrites the mirror
    // with empty tokens and a zero expiry. Sandboxed runs read only that file,
    // so the stub must count as a stale mirror, not a foreign file.
    const stub = JSON.stringify({
      claudeAiOauth: { accessToken: "", expiresAt: 0, refreshToken: "", scopes: ["user:inference"] },
      mcpOAuth: { slack: { accessToken: "file-mcp" } },
    });
    const keychain = JSON.stringify({ claudeAiOauth: { accessToken: "live", expiresAt: FUTURE, refreshToken: "r" } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(keychain), BACKUPS(target))).toBe("synced");
      const written = JSON.parse(readFileSync(target, "utf8"));
      expect(written.claudeAiOauth.accessToken).toBe("live");
      expect(written.mcpOAuth.slack.accessToken).toBe("file-mcp");
    }, stub);
  });

  test("an access-token-only mirror is still Claude's shape (as in 0.5.0)", () => {
    const accessOnly = JSON.stringify({ claudeAiOauth: { accessToken: "stale", expiresAt: 1 } });
    const keychain = JSON.stringify({ claudeAiOauth: { accessToken: "live", refreshToken: "r", expiresAt: FUTURE } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(keychain), BACKUPS(target))).toBe("synced");
      expect(JSON.parse(readFileSync(target, "utf8")).claudeAiOauth.accessToken).toBe("live");
    }, accessOnly);
  });

  test("a file with no Claude credential is never given one (no fabrication)", () => {
    const mcpOnlyFile = JSON.stringify({ mcpOAuth: { notion: { accessToken: "x" } } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("foreign");
      expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ mcpOAuth: { notion: { accessToken: "x" } } });
    }, mcpOnlyFile);
  });

  test("a claudeAiOauth value without Claude's shape is foreign, never overwritten", () => {
    for (const malformed of [
      JSON.stringify({ claudeAiOauth: [] }),
      JSON.stringify({ claudeAiOauth: { provider: "custom" } }),
      JSON.stringify({ claudeAiOauth: { accessToken: 42 } }),
      // An emptied token without the rest of Claude's stub is not the stub.
      JSON.stringify({ claudeAiOauth: { accessToken: "", provider: "custom" } }),
      JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "" } }),
      JSON.stringify({ claudeAiOauth: { provider: "custom", accessToken: "", refreshToken: "", expiresAt: 0 } }),
    ]) {
      withTarget((target) => {
        expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("foreign");
        expect(readFileSync(target, "utf8")).toBe(`${malformed}\n`);
      }, malformed);
    }
  });

  test("Claude's full stub, with every key it writes, is a mirror to refresh", () => {
    const stub = JSON.stringify({
      claudeAiOauth: {
        accessToken: "", expiresAt: 0, rateLimitTier: "default", refreshToken: "",
        refreshTokenExpiresAt: 1_790_616_186_239, scopes: ["user:inference"], subscriptionType: "max",
      },
    });
    const keychain = JSON.stringify({ claudeAiOauth: { accessToken: "live", refreshToken: "r", expiresAt: FUTURE } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(keychain), BACKUPS(target))).toBe("synced");
    }, stub);
  });

  test("the stub with a key this codemux does not know is unrecognized, never overwritten", () => {
    // Either another program's state under Claude's key, or a newer Claude
    // Code format: both must be left alone, and the adapter warns.
    const odd = JSON.stringify({
      claudeAiOauth: { provider: "custom", accessToken: "", refreshToken: "", expiresAt: 0, scopes: [] },
    });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("unrecognized");
      expect(readFileSync(target, "utf8")).toBe(`${odd}\n`);
    }, odd);
  });

  test("a corrupt (non-JSON) mirror is left alone (not a mirror we manage)", () => {
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("foreign");
      expect(readFileSync(target, "utf8")).toBe("not json at all\n");
    }, "not json at all");
  });
});
