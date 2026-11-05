import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { syncKeychainCredential } from "../src/credentials.js";
import { BACKUPS, FUTURE, LATER, SECRET, errors, gives, missing, withTarget } from "./helpers/credentials.js";

/** Root may own every link it creates, and the backup walk accepts a link
 * root owns (a system alias), so the link refusals prove nothing as root. */
const RUNS_AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

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

  test.skipIf(RUNS_AS_ROOT)("a redirected backup directory gets no backup and no permission change, and the scrub fails closed (review round 51)", () => {
    const leaked = JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "KEEP-ME" } });
    withTarget((target, dir) => {
      const fs = require("node:fs") as typeof import("node:fs");
      const elsewhere = join(dir, "elsewhere");
      fs.mkdirSync(elsewhere, { mode: 0o755 });
      fs.symlinkSync(elsewhere, join(dir, "backups"));
      // "unsafe": the mirror still carries a refresh token that could not be
      // backed up, so the scrub did not rewrite it (the documented verdict).
      expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("unsafe");
      // Nothing was written through the link, its target's mode is untouched,
      // and the mirror still carries the token it could not back up.
      expect(fs.readdirSync(elsewhere)).toEqual([]);
      expect(fs.statSync(elsewhere).mode & 0o777).toBe(0o755);
      expect(readFileSync(target, "utf8")).toContain("KEEP-ME");
    }, leaked);
  });

  test.skipIf(RUNS_AS_ROOT)("a missing backup directory with a symlinked ancestor is refused: nothing is written through the link (review round 110)", () => {
    // Round 51 checked the final component only; a symlink higher in the
    // chain let the recursive mkdir follow it and put the refresh-token
    // copy where a sandboxed child can read it.
    const leaked = JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "KEEP-ME" } });
    const fs = require("node:fs") as typeof import("node:fs");
    // The symlink directly above the missing final component.
    withTarget((target, dir) => {
      const elsewhere = join(dir, "elsewhere");
      fs.mkdirSync(elsewhere, { mode: 0o755 });
      fs.symlinkSync(elsewhere, join(dir, "link"));
      expect(syncKeychainCredential("svc", target, gives(SECRET), { backupDir: join(dir, "link", "inner") })).toBe("unsafe");
      expect(fs.readdirSync(elsewhere)).toEqual([]);
      expect(fs.statSync(elsewhere).mode & 0o777).toBe(0o755);
      expect(readFileSync(target, "utf8")).toContain("KEEP-ME");
    }, leaked);
    // The symlink deeper in the chain, below a real directory.
    withTarget((target, dir) => {
      const elsewhere = join(dir, "elsewhere");
      fs.mkdirSync(elsewhere, { mode: 0o755 });
      fs.mkdirSync(join(dir, "real"), { mode: 0o700 });
      fs.symlinkSync(elsewhere, join(dir, "real", "link"));
      expect(syncKeychainCredential("svc", target, gives(SECRET), { backupDir: join(dir, "real", "link", "b") })).toBe("unsafe");
      expect(fs.readdirSync(elsewhere)).toEqual([]);
      expect(readFileSync(target, "utf8")).toContain("KEEP-ME");
    }, leaked);
  });

  test.skipIf(RUNS_AS_ROOT)("a symlinked ancestor above components that already exist is refused too (review round 111)", () => {
    // Round 110's walk began at the nearest existing ancestor, and lstat of
    // `link/existing` follows `link`: the redirected directory read as a
    // plain one and the refresh-token copy landed inside the link's target.
    const leaked = JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "KEEP-ME" } });
    const fs = require("node:fs") as typeof import("node:fs");
    for (const tail of [["existing", "new"], ["existing"]]) {
      withTarget((target, dir) => {
        const elsewhere = join(dir, "elsewhere");
        fs.mkdirSync(join(elsewhere, "existing"), { recursive: true, mode: 0o755 });
        fs.symlinkSync(elsewhere, join(dir, "link"));
        expect(syncKeychainCredential("svc", target, gives(SECRET), { backupDir: join(dir, "link", ...tail) })).toBe("unsafe");
        expect(fs.readdirSync(join(elsewhere, "existing"))).toEqual([]);
        expect(fs.statSync(join(elsewhere, "existing")).mode & 0o777).toBe(0o755);
        expect(readFileSync(target, "utf8")).toContain("KEEP-ME");
      }, leaked);
    }
  });

  test("a relative backup directory is refused", () => {
    const leaked = JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "KEEP-ME" } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(SECRET), { backupDir: "relative-backups" })).toBe("unsafe");
      expect(readFileSync(target, "utf8")).toContain("KEEP-ME");
    }, leaked);
  });

  test("a missing backup directory with missing ancestors is created one component at a time (review round 110)", () => {
    const leaked = JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "KEEP-ME" } });
    withTarget((target, dir) => {
      expect(syncKeychainCredential("svc", target, gives(SECRET), { backupDir: join(dir, "one", "two") })).toBe("synced");
      expect(statSync(join(dir, "one")).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "one", "two")).mode & 0o777).toBe(0o700);
      const backups = readdirSync(join(dir, "one", "two"));
      expect(backups).toHaveLength(1);
      expect(statSync(join(dir, "one", "two", backups[0]!)).mode & 0o777).toBe(0o600);
      expect(readFileSync(target, "utf8")).not.toContain("KEEP-ME");
    }, leaked);
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
});
