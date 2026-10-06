import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  claudeCredentialTarget,
  decodeSecurityOutput,
  hasUsableClaudeCredential,
  readKeychainSecret,
  syncKeychainCredential,
  type SecretReadResult,
} from "../src/credentials.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";

const SECRET = JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "r" } });
// A Keychain access token must be unexpired to be mirrored; the file side may hold anything.
const FUTURE = Date.now() + 3_600_000;
const LATER = FUTURE + 60_000;
const gives = (value: string) => (_service: string): SecretReadResult => ({
  kind: "secret",
  value,
});
const missing = (_service: string): SecretReadResult => ({ kind: "missing" });
const errors = (_service: string): SecretReadResult => ({ kind: "error", detail: "locked" });

/** Backups for a temp target go beside it, never into the real ~/Library. */
const BACKUPS = (target: string) => ({ backupDir: join(dirname(target), "backups") });

function withTarget(fn: (target: string, dir: string) => void, seed = SECRET): void {
  const dir = mkdtempSync(join(tmpdir(), "codemux-cred-"));
  const target = join(dir, ".credentials.json");
  if (seed !== "") writeFileSync(target, `${seed}\n`, { mode: 0o600 });
  try {
    fn(target, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

  test("a directory at the staging path is never deleted by cleanup", () => {
    const fresh = JSON.stringify({ claudeAiOauth: { accessToken: "z", refreshToken: "z", expiresAt: FUTURE } });
    // Write fails (staging occupied by a dir), the sync fails, the dir survives.
    withTarget((target) => {
      const staging = `${target}.${process.pid}.tmp`;
      require("node:fs").mkdirSync(staging);
      require("node:fs").writeFileSync(join(staging, "precious"), "keep");
      expect(syncKeychainCredential("svc", target, gives(fresh), BACKUPS(target))).toBe("failed");
      expect(require("node:fs").readFileSync(join(staging, "precious"), "utf8")).toBe("keep");
    }, JSON.stringify({ claudeAiOauth: { accessToken: "o", refreshToken: "", expiresAt: 1 } }));
    // The same failed write with a refresh token still in the file is unsafe.
    withTarget((target) => {
      const staging = `${target}.${process.pid}.tmp`;
      require("node:fs").mkdirSync(staging);
      require("node:fs").writeFileSync(join(staging, "precious"), "keep");
      expect(syncKeychainCredential("svc", target, gives(fresh), BACKUPS(target))).toBe("unsafe");
      expect(require("node:fs").readFileSync(join(staging, "precious"), "utf8")).toBe("keep");
    }, JSON.stringify({ claudeAiOauth: { accessToken: "o", refreshToken: "o", expiresAt: 1 } }));
  });

  test("an mcpOAuth-only Keychain blob never clobbers a working mirror (but still scrubs it)", () => {
    const mcpOnly = JSON.stringify({ mcpOAuth: { notion: { accessToken: "x" } } });
    const working = JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "" } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(mcpOnly), BACKUPS(target))).toBe("missing");
      expect(readFileSync(target, "utf8").trim()).toBe(working); // untouched
    }, working);
    withTarget((target) => {
      // A refresh token left in the file goes even when the Keychain has nothing.
      expect(syncKeychainCredential("svc", target, gives(mcpOnly), BACKUPS(target))).toBe("missing");
      expect(readFileSync(target, "utf8").trim()).toBe(working);
    });
  });

  test("the Keychain wins regardless of expiry ordering (a mirror cannot be newer)", () => {
    // A re-login or a revocation can leave the Keychain's token expiring
    // EARLIER than a stale mirror's; the mirror cannot refresh, so it is
    // never the fresher credential and must not be kept on expiry grounds.
    const keychain = JSON.stringify({ claudeAiOauth: { accessToken: "k", refreshToken: "k", expiresAt: FUTURE } });
    const laterButStale = JSON.stringify({ claudeAiOauth: { accessToken: "f", refreshToken: "", expiresAt: LATER } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(keychain), BACKUPS(target))).toBe("synced");
      expect(JSON.parse(readFileSync(target, "utf8")).claudeAiOauth).toEqual({
        accessToken: "k", refreshToken: "", expiresAt: FUTURE,
      });
    }, laterButStale);
  });

  // The scrub must not depend on the Keychain: a read error, an absent
  // entry, or an unusable entry still leaves no refresh token behind.
  test("a Keychain read error never destroys the file's refresh token: the launch is refused instead", () => {
    const leaked = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "MAYBE-ONLY-COPY", expiresAt: 1 }, mcpOAuth: { keep: 1 } });
    withTarget((target, dir) => {
      expect(syncKeychainCredential("svc", target, errors, BACKUPS(target))).toBe("unsafe");
      expect(readFileSync(target, "utf8").trim()).toBe(leaked); // untouched
      expect(readdirSync(dir)).toEqual([".credentials.json"]); // no backup dir, nothing written
    }, leaked);
    // Without a refresh token the stale mirror launches and reports a 401 itself.
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, errors, BACKUPS(target))).toBe("failed");
    }, JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "" } }));
  });

  test("a refresh token is backed up (0600, beside the file) before the mirror loses it", () => {
    const leaked = JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "KEEP-ME" }, mcpOAuth: { k: 1 } });
    withTarget((target, dir) => {
      expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("synced");
      // Nothing beside the mirror (the sandbox reads that directory)...
      expect(readdirSync(dir).sort()).toEqual([".credentials.json", "backups"]);
      // ...the copy sits in the backup directory, 0700/0600.
      const backupDir = join(dir, "backups");
      expect(statSync(backupDir).mode & 0o777).toBe(0o700);
      const backups = readdirSync(backupDir);
      expect(backups).toHaveLength(1);
      const backup = join(backupDir, backups[0]!);
      expect(statSync(backup).mode & 0o777).toBe(0o600);
      expect(readFileSync(backup, "utf8").trim()).toBe(leaked);
      expect(readFileSync(target, "utf8")).not.toContain("KEEP-ME");
    }, leaked);
    // No refresh token to lose: no backup is written.
    withTarget((target, dir) => {
      expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("synced");
      expect(readdirSync(dir)).toEqual([".credentials.json"]);
    }, JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "" } }));
    // After a successful rewrite, older backups are pruned; newer ones (a
    // parallel launch's) and unrelated files stay.
    withTarget((target, dir) => {
      const backupDir = join(dir, "backups");
      require("node:fs").mkdirSync(backupDir, { mode: 0o700 });
      writeFileSync(join(backupDir, "credentials-1999-01-01T00-00-00-000Z-1-1.json"), "{}\n", { mode: 0o600 });
      writeFileSync(join(backupDir, "credentials-2999-01-01T00-00-00-000Z-1-1.json"), "{}\n", { mode: 0o600 });
      writeFileSync(join(backupDir, "unrelated.txt"), "keep\n", { mode: 0o600 });
      expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("synced");
      const names = readdirSync(backupDir).sort();
      expect(names).toHaveLength(3);
      expect(names).toContain("unrelated.txt");
      expect(names).toContain("credentials-2999-01-01T00-00-00-000Z-1-1.json");
      expect(names).not.toContain("credentials-1999-01-01T00-00-00-000Z-1-1.json");
    }, leaked);
    // A failed rewrite prunes nothing: the earlier copy is still the last one.
    if (typeof process.getuid !== "function" || process.getuid() !== 0) {
      withTarget((target, dir) => {
        const backupDir = join(dir, "backups");
        require("node:fs").mkdirSync(backupDir, { mode: 0o700 });
        writeFileSync(join(backupDir, "credentials-1999-01-01T00-00-00-000Z-1-1.json"), "{}\n", { mode: 0o600 });
        chmodSync(dir, 0o500); // the staging file beside the mirror cannot be created
        try {
          expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("unsafe");
        } finally {
          chmodSync(dir, 0o700);
        }
        expect(readdirSync(backupDir)).toEqual(["credentials-1999-01-01T00-00-00-000Z-1-1.json"]);
      }, leaked);
    }
    // An existing backup directory with loose permissions is tightened.
    withTarget((target, dir) => {
      require("node:fs").mkdirSync(join(dir, "backups"), { mode: 0o755 });
      expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("synced");
      expect(statSync(join(dir, "backups")).mode & 0o777).toBe(0o700);
    }, leaked);
    // No safe place for the backup (an empty directory setting): the scrub
    // fails closed and the launch is refused.
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(SECRET), { backupDir: "" })).toBe("unsafe");
      expect(readFileSync(target, "utf8")).toContain("KEEP-ME");
    }, leaked);
  });

  test("CODEMUX_NO_KEYCHAIN_SYNC never consults the Keychain, so it neither scrubs nor refuses", () => {
    process.env.CODEMUX_NO_KEYCHAIN_SYNC = "1";
    const leaked = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "LIVE" } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("skipped");
      expect(readFileSync(target, "utf8").trim()).toBe(leaked); // untouched
    }, leaked);
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("skipped");
    }, JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "" } }));
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("skipped");
    }, "");
  });

  test("with no Keychain entry at all the file is Claude's only store and is left untouched", () => {
    // Linux, or a file-only macOS login: the refresh token there is the
    // operator's only copy, and the sandboxed child rotates that same file.
    const store = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "ONLY-COPY" } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, missing, BACKUPS(target))).toBe("missing");
      expect(readFileSync(target, "utf8").trim()).toBe(store);
    }, store);
  });

  test("a scrub of the file's own credential keeps its other keys", () => {
    const mcpOnly = gives(JSON.stringify({ mcpOAuth: { notion: { accessToken: "x" } } }));
    const own = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "LIVE", refreshTokenExpiresAt: 5, futureKey: "kept" } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, mcpOnly, BACKUPS(target))).toBe("missing");
      expect(JSON.parse(readFileSync(target, "utf8")).claudeAiOauth).toEqual({
        accessToken: "a", refreshToken: "", futureKey: "kept",
      });
    }, own);
  });

  test("a scrubbed file always has Claude's stub shape, even from a refresh-only source", () => {
    const refreshOnly = JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "LIVE" } });
    const mcpOnly = gives(JSON.stringify({ mcpOAuth: { notion: { accessToken: "x" } } }));
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, mcpOnly, BACKUPS(target))).toBe("failed");
      expect(JSON.parse(readFileSync(target, "utf8")).claudeAiOauth).toEqual({
        accessToken: "", refreshToken: "", expiresAt: 0, scopes: [],
      });
      // ...so the next launch treats it as a stale mirror, not a foreign file.
      expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("synced");
    }, refreshOnly);
  });

  test("a Keychain entry with nothing usable still scrubs the mirror's refresh token", () => {
    const mcpOnly = gives(JSON.stringify({ mcpOAuth: { notion: { accessToken: "x" } } }));
    const leaked = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "LIVE" } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, mcpOnly, BACKUPS(target))).toBe("missing");
      expect(JSON.parse(readFileSync(target, "utf8")).claudeAiOauth).toEqual({ accessToken: "a", refreshToken: "" });
    }, leaked);
    const refreshOnly = JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "LIVE" } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, mcpOnly, BACKUPS(target))).toBe("failed");
      expect(readFileSync(target, "utf8")).not.toContain("LIVE");
    }, refreshOnly);
  });

  test("a mirror behind a symlink is unsafe when it carries a refresh token and a Keychain entry exists", () => {
    withTarget((target, dir) => {
      const real = join(dir, "real.json");
      writeFileSync(real, `${JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "LIVE" } })}\n`, { mode: 0o600 });
      symlinkSync(real, target);
      expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("unsafe");
      expect(syncKeychainCredential("svc", target, errors, BACKUPS(target))).toBe("unsafe");
      // No Keychain entry at all (Linux, dotfile-managed ~/.claude): the file
      // is Claude Code's own store, so the launch is not refused.
      expect(syncKeychainCredential("svc", target, missing, BACKUPS(target))).toBe("failed");
      writeFileSync(real, `${JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "" } })}\n`, { mode: 0o600 });
      expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("failed");
    }, "");
  });

  test("an expired mirror token with nothing usable in the Keychain fails loudly", () => {
    const expiredKeychain = gives(JSON.stringify({ claudeAiOauth: { accessToken: "dead", refreshToken: "r", expiresAt: Date.now() - 1 } }));
    const expiredFile = JSON.stringify({ claudeAiOauth: { accessToken: "older", refreshToken: "", expiresAt: Date.now() - 1000 } });
    const liveFile = JSON.stringify({ claudeAiOauth: { accessToken: "ok", refreshToken: "", expiresAt: FUTURE } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, expiredKeychain, BACKUPS(target))).toBe("failed");
      expect(readFileSync(target, "utf8").trim()).toBe(expiredFile); // untouched, just reported
    }, expiredFile);
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, expiredKeychain, BACKUPS(target))).toBe("missing");
    }, liveFile);
  });

  test("an expired Keychain access token is never mirrored as synced", () => {
    const expired = JSON.stringify({ claudeAiOauth: { accessToken: "dead", refreshToken: "r", expiresAt: Date.now() - 1 } });
    const working = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "" } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(expired), BACKUPS(target))).toBe("missing");
      expect(readFileSync(target, "utf8").trim()).toBe(working);
    }, working);
  });

  test("a refresh-token-only Keychain entry is not a credential to mirror", () => {
    const refreshOnly = JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "r", expiresAt: FUTURE, scopes: [] } });
    const working = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "" } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(refreshOnly), BACKUPS(target))).toBe("missing");
      expect(readFileSync(target, "utf8").trim()).toBe(working);
    }, working);
    // ... and an emptied stub with nothing to mirror is a loud failure.
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(refreshOnly), BACKUPS(target))).toBe("failed");
    }, JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0, scopes: [] } }));
  });

  test("a refresh token that cannot be scrubbed is unsafe", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    const leaked = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "LIVE" } });
    withTarget((target, dir) => {
      chmodSync(dir, 0o500); // no staging file can be created beside the mirror
      try {
        expect(syncKeychainCredential("svc", target, errors, BACKUPS(target))).toBe("unsafe");
        expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("unsafe");
      } finally {
        chmodSync(dir, 0o700);
      }
    }, leaked);
  });

  test("an unreadable existing mirror fails (warns), rather than reporting absent", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    withTarget((target) => {
      require("node:fs").chmodSync(target, 0o000);
      try {
        expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("failed");
      } finally {
        require("node:fs").chmodSync(target, 0o600);
      }
    });
  });

  test("distinguishes a missing Keychain entry from a read error", () => {
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, missing, BACKUPS(target))).toBe("missing");
      expect(syncKeychainCredential("svc", target, errors, BACKUPS(target))).toBe("failed");
    }, JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "" } }));
    // With a refresh token in the file the read error is a refusal, not a warning.
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, missing, BACKUPS(target))).toBe("missing");
      expect(syncKeychainCredential("svc", target, errors, BACKUPS(target))).toBe("unsafe");
    });
  });

  test("an emptied stub with nothing usable in the Keychain fails loudly", () => {
    // Stub mirror + no Keychain credential = the sandboxed launch will 401
    // with nothing on stderr. That must surface as "failed" so the adapter
    // warns, not as a silent "missing". The Keychain can also temporarily
    // hold only co-stored mcpOAuth state; both shapes land here.
    const stub = JSON.stringify({
      claudeAiOauth: { accessToken: "", expiresAt: 0, refreshToken: "", scopes: ["user:inference"] },
    });
    const mcpOnly = JSON.stringify({ mcpOAuth: { notion: { accessToken: "x" } } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, missing, BACKUPS(target))).toBe("failed");
      expect(syncKeychainCredential("svc", target, gives(mcpOnly), BACKUPS(target))).toBe("failed");
      expect(readFileSync(target, "utf8").trim()).toBe(stub); // never rewritten
    }, stub);
  });

  test("an unrecognized stub is reported even without a Keychain credential", () => {
    const odd = JSON.stringify({
      claudeAiOauth: { provider: "custom", accessToken: "", refreshToken: "", expiresAt: 0, scopes: [] },
    });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, missing, BACKUPS(target))).toBe("unrecognized");
      expect(readFileSync(target, "utf8")).toBe(`${odd}\n`);
    }, odd);
  });

  test("a mirror with a usable token stays missing without the Keychain", () => {
    // The file authenticates on its own; there is nothing to refresh with,
    // and nothing to warn about.
    const mcpOnly = JSON.stringify({ mcpOAuth: { notion: { accessToken: "x" } } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, missing, BACKUPS(target))).toBe("missing");
      expect(syncKeychainCredential("svc", target, gives(mcpOnly), BACKUPS(target))).toBe("missing");
    });
  });

  test("a symlinked target is refused, never followed", () => {
    withTarget((target, dir) => {
      const real = join(dir, "elsewhere.json");
      writeFileSync(real, "{}");
      rmSync(target, { force: true });
      symlinkSync(real, target);
      expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("failed");
      expect(readFileSync(real, "utf8")).toBe("{}"); // the link's target is untouched
    }, "");
  });

  test("a planted staging symlink cannot capture the credential", () => {
    const stale = JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "old", expiresAt: 1 } });
    const fresh = JSON.stringify({ claudeAiOauth: { accessToken: "new", refreshToken: "new", expiresAt: FUTURE } });
    withTarget((target, dir) => {
      const capture = join(dir, "capture.json");
      symlinkSync(capture, `${target}.${process.pid}.tmp`);
      expect(syncKeychainCredential("svc", target, gives(fresh), BACKUPS(target))).toBe("synced");
      expect(existsSync(capture)).toBe(false); // the link was cleared, not written through
    }, stale);
  });

  test("CODEMUX_NO_KEYCHAIN_SYNC=1 skips before touching the Keychain", () => {
    withTarget((target) => {
      process.env.CODEMUX_NO_KEYCHAIN_SYNC = "1";
      const explode = (_s: string): SecretReadResult => {
        throw new Error("must not read");
      };
      expect(syncKeychainCredential("svc", target, explode, BACKUPS(target))).toBe("skipped");
    }, JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "" } }));
  });
});

describe("decodeSecurityOutput", () => {
  test("decodes hex (with or without 0x); keeps plain and non-JSON text raw", () => {
    const hex = Buffer.from(SECRET, "utf8").toString("hex");
    expect(decodeSecurityOutput(hex)).toBe(SECRET);
    expect(decodeSecurityOutput(`0x${hex}`)).toBe(SECRET);
    expect(decodeSecurityOutput(SECRET)).toBe(SECRET);
    expect(decodeSecurityOutput("cafe")).toBe("cafe"); // hex-shaped but not JSON
  });
});

describe("hasUsableClaudeCredential", () => {
  test("true only for a claudeAiOauth object with a non-empty, unexpired access token", () => {
    expect(hasUsableClaudeCredential(SECRET)).toBe(true);
    expect(hasUsableClaudeCredential(JSON.stringify({ claudeAiOauth: { accessToken: "" } }))).toBe(false);
    expect(hasUsableClaudeCredential(JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "r" } }))).toBe(false);
    expect(hasUsableClaudeCredential(JSON.stringify({ claudeAiOauth: { accessToken: "a", expiresAt: 1 } }))).toBe(false);
    expect(hasUsableClaudeCredential(JSON.stringify({ mcpOAuth: {} }))).toBe(false);
    expect(hasUsableClaudeCredential("not json")).toBe(false);
  });
});

describe("readKeychainSecret", () => {
  test("a missing entry yields missing rather than an error", () => {
    expect(readKeychainSecret("codemux-test-nonexistent-svc-8c1f")).toEqual({ kind: "missing" });
  });
});

describe("readKeychainSecret account selection", () => {
  test("prefers $USER over the OS username, matching Claude Code", () => {
    // We cannot read a real entry here, but a nonexistent service under an
    // explicit $USER still resolves to "missing" without throwing — proving
    // the selector path runs.
    const prev = process.env.USER;
    process.env.USER = "codemux-test-user";
    try {
      expect(readKeychainSecret("codemux-nonexistent-svc")).toEqual({ kind: "missing" });
    } finally {
      if (prev === undefined) delete process.env.USER;
      else process.env.USER = prev;
    }
  });
});

describe("claudeCredentialTarget", () => {
  test("is the fixed default path under the home config dir", () => {
    expect(claudeCredentialTarget().endsWith("/.claude/.credentials.json")).toBe(true);
  });
});

// The credential reader is injected so the adapter's launch wiring is tested
// without touching the real Keychain or real credential file.
class StubbedClaudeAdapter extends ClaudeAdapter {
  constructor(
    private readonly targetPath: string,
    reader: (service: string) => SecretReadResult = gives(SECRET)
  ) {
    super();
    this.credentialReader = reader;
  }
  protected override credentialTarget = () => this.targetPath;
  // Backups never land in the real ~/Library during tests.
  protected override credentialBackupDir = () => join(dirname(this.targetPath), "backups");
}

describe("ClaudeAdapter.prepareSandbox", () => {
  test("refreshes an existing mirror on a trusted sandbox", () => {
    withTarget((target) => {
      const stale = JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "old" } });
      writeFileSync(target, `${stale}\n`, { mode: 0o600 });
      const adapter = new StubbedClaudeAdapter(target);
      adapter.prepareSandbox({ sandboxTrust: "standard" });
      expect(readFileSync(target, "utf8").trim()).toBe(
        JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "" } })
      );
    });
  });

  test("refuses the sandboxed launch when a refresh token cannot be scrubbed", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    withTarget((target, dir) => {
      writeFileSync(target, `${JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "LIVE" } })}\n`, { mode: 0o600 });
      chmodSync(dir, 0o500);
      try {
        const adapter = new StubbedClaudeAdapter(target);
        expect(() => adapter.prepareSandbox({ sandboxTrust: "standard" })).toThrow(/refusing the sandboxed launch/);
      } finally {
        chmodSync(dir, 0o700);
      }
    });
  });

  test("a passed-through CLAUDE_CONFIG_DIR profile is never touched or refused; the default mirror is still scrubbed", () => {
    withTarget((target, dir) => {
      const profile = join(dir, "profile");
      require("node:fs").mkdirSync(profile);
      const profileFile = join(profile, ".credentials.json");
      writeFileSync(profileFile, `${JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "PROFILE-ONLY-COPY" } })}\n`, { mode: 0o600 });
      // The default mirror still carries a refresh token from an older codemux.
      writeFileSync(target, `${JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "LEAKED" } })}\n`, { mode: 0o600 });
      const prev = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = profile;
      try {
        const adapter = new StubbedClaudeAdapter(target);
        expect(() => adapter.prepareSandbox({ sandboxTrust: "standard", passthroughEnv: ["CLAUDE_CONFIG_DIR"] })).not.toThrow();
        expect(readFileSync(profileFile, "utf8")).toContain("PROFILE-ONLY-COPY"); // untouched
        expect(readFileSync(target, "utf8")).not.toContain("LEAKED"); // default mirror scrubbed
      } finally {
        if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = prev;
      }
    });
  });

  test("a backup made for a rewrite that did not happen is removed again", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    const leaked = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "LIVE" } });
    withTarget((target, dir) => {
      chmodSync(dir, 0o500); // the staging file beside the mirror cannot be created
      try {
        // Backups live outside dir, so they can still be written; the rewrite fails.
        const outside = mkdtempSync(join(tmpdir(), "codemux-cred-backups-"));
        try {
          expect(syncKeychainCredential("svc", target, gives(SECRET), { backupDir: outside })).toBe("unsafe");
          expect(readdirSync(outside)).toEqual([]); // nothing piled up
          expect(readFileSync(target, "utf8").trim()).toBe(leaked);
        } finally {
          rmSync(outside, { recursive: true, force: true });
        }
      } finally {
        chmodSync(dir, 0o700);
      }
    }, leaked);
  });

  test("a passed-through CLAUDE_CONFIG_DIR is not synced itself (custom profile)", () => {
    withTarget((target) => {
      const stale = JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "old" } });
      writeFileSync(target, `${stale}\n`, { mode: 0o600 });
      const prev = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = "/tmp/custom";
      try {
        const adapter = new StubbedClaudeAdapter(target);
        adapter.prepareSandbox({ sandboxTrust: "standard", passthroughEnv: ["CLAUDE_CONFIG_DIR"] });
        // The profile is not synced, but the default mirror in ~/.claude still is:
        // the sandbox lets the child read it whatever profile it was pointed at.
        expect(readFileSync(target, "utf8").trim()).toBe(
          JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "" } })
        );
      } finally {
        if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = prev;
      }
    });
  });

  test("an untrusted sandbox is skipped entirely", () => {
    withTarget((target) => {
      const stale = JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "old" } });
      writeFileSync(target, `${stale}\n`, { mode: 0o600 });
      const adapter = new StubbedClaudeAdapter(target);
      adapter.prepareSandbox({ sandboxTrust: "untrusted" });
      expect(readFileSync(target, "utf8").trim()).toBe(stale); // untouched
    });
  });

  test("beforeLaunch (unsandboxed path) never touches the mirror", () => {
    withTarget((target) => {
      rmSync(target, { force: true });
      const adapter = new StubbedClaudeAdapter(target);
      adapter.beforeLaunch();
      expect(existsSync(target)).toBe(false);
    }, "");
  });

  test("a keychain read error warns but never throws when the mirror holds no refresh token", () => {
    withTarget((target) => {
      const adapter = new StubbedClaudeAdapter(target, errors);
      expect(() => adapter.prepareSandbox({ sandboxTrust: "standard" })).not.toThrow();
    }, JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "" } }));
  });

  test("a keychain read error with a refresh token in the mirror refuses the launch", () => {
    withTarget((target) => {
      const adapter = new StubbedClaudeAdapter(target, errors);
      expect(() => adapter.prepareSandbox({ sandboxTrust: "standard" })).toThrow(/refusing the sandboxed launch/);
      expect(readFileSync(target, "utf8").trim()).toBe(SECRET); // untouched
    });
  });
});
