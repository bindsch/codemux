import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { syncKeychainCredential, type SecretReadResult } from "../src/credentials.js";
import { writeMirror } from "../src/credentials/backups.js";
import { BACKUPS, FUTURE, SECRET, errors, gives, missing, withTarget } from "./helpers/credentials.js";

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

  test("an oversized mirror is refused before any read or write (review rounds 73, 76)", () => {
    // The mirror directory is child-writable, so a previous sandboxed run
    // can have enlarged the file. The bound refuses it unread, the bytes
    // untouched, nothing written. With a Keychain entry behind it the file
    // is a mirror whose refresh token cannot be ruled out, so the launch is
    // refused ("unsafe"); with no entry it is Claude Code's own store and
    // proceeds as "failed".
    const oversized = `${JSON.stringify({
      claudeAiOauth: { accessToken: "stale", refreshToken: "LIVE", expiresAt: FUTURE, scopes: [] },
      padding: "x".repeat(1024 * 1024),
    })}\n`;
    withTarget((target, dir) => {
      writeFileSync(target, oversized, { mode: 0o600 });
      expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("unsafe");
      expect(syncKeychainCredential("svc", target, errors, BACKUPS(target))).toBe("unsafe");
      expect(syncKeychainCredential("svc", target, missing, BACKUPS(target))).toBe("failed");
      expect(readFileSync(target, "utf8")).toBe(oversized);
      expect(readdirSync(dir)).toEqual([".credentials.json"]);
    }, "");
  });

  test("a refused oversized write leaves no backup behind, and the scrub keeps exactly one (review round 77)", () => {
    // The file carries a refresh token, so a write would back it up first;
    // the oversized result is judged before the backup exists. The scrub
    // that follows makes the one legitimate copy.
    const huge = gives(JSON.stringify({ claudeAiOauth: { accessToken: "a".repeat(1024 * 1024), refreshToken: "r", expiresAt: FUTURE, scopes: [] } }));
    const carrying = JSON.stringify({ claudeAiOauth: { accessToken: "small", refreshToken: "LIVE", expiresAt: FUTURE - 1 } });
    withTarget((target, dir) => {
      expect(syncKeychainCredential("svc", target, huge, BACKUPS(target))).toBe("failed");
      expect(readFileSync(target, "utf8")).not.toContain("LIVE");
      expect(readdirSync(join(dir, "backups"))).toHaveLength(1);
    }, carrying);
  });

  test("a scrub whose conflict re-read is refused on content is unsafe (review round 77)", () => {
    // The Keychain entry holds no usable credential, so the file's refresh
    // token is scrubbed locally. Another writer changes the file under the
    // scrub (a conflict), and what it wrote is oversized: its refresh
    // token cannot be ruled out, so the launch is refused.
    const carrying = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "LIVE", expiresAt: FUTURE } });
    const fileIo = require("../src/file-io.js") as typeof import("../src/file-io.js");
    const original = fileIo.readUtf8FileBounded;
    let reads = 0;
    const spy = spyOn(fileIo, "readUtf8FileBounded").mockImplementation((path: string, options: Parameters<typeof original>[1]) => {
      reads += 1;
      if (reads === 1) return `${original(path, options).trimEnd()} \n`; // differs from disk: the write conflicts
      throw new fileIo.FileContentError("the Claude credential mirror exceeds 1048576 bytes");
    });
    try {
      withTarget((target) => {
        expect(syncKeychainCredential("svc", target, gives(JSON.stringify({ mcpOAuth: {} })), BACKUPS(target))).toBe("unsafe");
        expect(readFileSync(target, "utf8").trim()).toBe(carrying);
      }, carrying);
    } finally { spy.mockRestore(); }
  });

  test("a scrub that ends on a file with no Claude credential is failed, never judged by the pre-scrub copy (review round 91)", () => {
    // The Keychain entry holds no usable credential, so the file's refresh
    // token is scrubbed locally, and the scrub's own write lands. Another
    // writer then replaces the file with one that has no claudeAiOauth at
    // all. The copy read before the scrub still had a live access token;
    // judging by it answered "missing" (the mirror authenticates alone)
    // while the child has nothing to authenticate with.
    const carrying = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "LIVE", expiresAt: FUTURE } });
    const fileIo = require("../src/file-io.js") as typeof import("../src/file-io.js");
    const original = fileIo.readUtf8FileBounded;
    let reads = 0;
    const spy = spyOn(fileIo, "readUtf8FileBounded").mockImplementation((path: string, options: Parameters<typeof original>[1]) => {
      reads += 1;
      // Reads 1 and 2: the sync's read and the writer's conflict check, the
      // real disk. Read 3: the post-scrub reread sees the replacement.
      return reads >= 3 ? `${JSON.stringify({ somethingElse: true })}\n` : original(path, options);
    });
    try {
      withTarget((target) => {
        expect(syncKeychainCredential("svc", target, gives(JSON.stringify({ mcpOAuth: {} })), BACKUPS(target))).toBe("failed");
        expect(reads).toBe(3);
      }, carrying);
    } finally { spy.mockRestore(); }
  });

  test("a scrub that ends on another writer's replacement is judged against the disk, not the pre-scrub copy (review round 90)", () => {
    // The conflict path: the mirror another writer left carries a refresh
    // token and the Keychain's own access token, so the scrub runs — and
    // while the scrub handles ITS write conflict the writer replaces the
    // file again, this time with a clean mirror holding a DIFFERENT access
    // token. The scrub reports "clean" (nothing carries a refresh token
    // anymore) and the pre-scrub snapshot would answer "current", sending
    // the launch out on a token the Keychain no longer holds. The reread
    // decides against what is on disk now.
    const seed = JSON.stringify({ claudeAiOauth: { accessToken: "stale", refreshToken: "OLD", expiresAt: FUTURE - 1, scopes: [] } });
    // What the first reread sees (read 3): a mirror carrying a refresh
    // token under the Keychain's access token "t".
    const carrying = JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "LIVE", expiresAt: FUTURE, scopes: [] } });
    // What the scrub's conflict re-read and the caller's reread see
    // (reads 5 and 6): another writer's finished replacement.
    const theirs = JSON.stringify({ claudeAiOauth: { accessToken: "theirs", refreshToken: "", expiresAt: FUTURE, scopes: [] } });
    const matched = JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "", expiresAt: FUTURE, scopes: [] } });
    const fileIo = require("../src/file-io.js") as typeof import("../src/file-io.js");
    const original = fileIo.readUtf8FileBounded;
    const spyOnReads = (live: string, after: string) => {
      let reads = 0;
      return spyOn(fileIo, "readUtf8FileBounded").mockImplementation((path: string, options: Parameters<typeof original>[1]) => {
        reads += 1;
        if (reads === 1) return `${original(path, options).trimEnd()} \n`; // differs from disk: the first write conflicts
        if (reads === 3) return `${live}\n`; // the reread sees the other writer's refresh-token-carrying mirror
        if (reads >= 5) return `${after}\n`; // the scrub's conflict re-read and the caller's post-scrub reread
        return original(path, options); // reads 2 and 4: the real disk, so both writes conflict
      });
    };
    withTarget((target) => {
      const spy = spyOnReads(carrying, theirs);
      try {
        expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("failed");
      } finally {
        spy.mockRestore();
      }
    }, seed);
    // The replacement holding the Keychain's own token is current: the
    // reread judges, and a clean matching mirror needs no rewrite.
    withTarget((target) => {
      const spy = spyOnReads(carrying, matched);
      try {
        expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("current");
      } finally {
        spy.mockRestore();
      }
    }, seed);
  });

  test("a mirror that would exceed the bound is never written (review round 76)", () => {
    // A Keychain credential large enough to push the mirror past 1 MiB is
    // not written: the next launch could not read it back. The file keeps
    // its content and the stale mirror is reported ("failed").
    const huge = gives(JSON.stringify({ claudeAiOauth: { accessToken: "a".repeat(1024 * 1024), refreshToken: "r", expiresAt: FUTURE, scopes: [] } }));
    const before = JSON.stringify({ claudeAiOauth: { accessToken: "small", refreshToken: "", expiresAt: FUTURE - 1 } });
    withTarget((target, dir) => {
      expect(syncKeychainCredential("svc", target, huge, BACKUPS(target))).toBe("failed");
      expect(readFileSync(target, "utf8").trim()).toBe(before);
      expect(readdirSync(dir)).toEqual([".credentials.json"]);
    }, before);
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

  test("a Keychain reader that throws counts as an unreadable entry, never an abort (C-8)", () => {
    // `security find-generic-password` can refuse to spawn at all; that
    // must land in the same "error" bucket as a locked Keychain: a file
    // still carrying a refresh token is refused, a clean one warns, and
    // neither outcome touches the target bytes.
    const throws = (_s: string): SecretReadResult => {
      throw new Error("posix_spawn refused");
    };
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, throws, BACKUPS(target))).toBe("unsafe");
      expect(readFileSync(target, "utf8")).toBe(`${SECRET}\n`); // never rewritten
    });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, throws, BACKUPS(target))).toBe("failed");
      expect(readFileSync(target, "utf8").trim()).toBe(
        JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "" } })
      );
    }, JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "" } }));
  });

  test("a linked mirror whose file cannot be read fails (C-8)", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    const carrying = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "LIVE" } });
    withTarget((target, dir) => {
      const real = join(dir, "real.json");
      writeFileSync(real, `${carrying}\n`, { mode: 0o600 });
      rmSync(target, { force: true });
      symlinkSync(real, target);
      chmodSync(real, 0o000);
      try {
        // A Keychain entry exists, so the link is judged as a mirror — but
        // the file behind it cannot be read to prove it clean: fail, do
        // not launch through the unreadable link.
        expect(syncKeychainCredential("svc", target, gives(SECRET), BACKUPS(target))).toBe("failed");
      } finally {
        chmodSync(real, 0o600);
      }
      expect(readFileSync(real, "utf8")).toBe(`${carrying}\n`);
    }, "");
  });
});

describe("writeMirror's vanished and conflict outcomes (C-8)", () => {
  const scrubbed = { accessToken: "a", refreshToken: "" };

  test("a mirror deleted mid-write reports vanished and keeps the backup", () => {
    withTarget((target, dir) => {
      const backups = join(dir, "backups");
      rmSync(target, { force: true }); // the writer's read finds nothing
      const outcome = writeMirror(target, `${SECRET}\n`, scrubbed, backups);
      expect(outcome).toBe("vanished");
      // The pre-scrub backup is the last copy of the token, so it stays.
      const kept = readdirSync(backups).filter((name) => name.endsWith(".json"));
      expect(kept).toHaveLength(1);
      expect(existsSync(target)).toBe(false); // a vanished mirror is never recreated
    });
  });

  test("a mirror changed mid-write reports conflict, keeps the other writer's bytes, and leaves nothing staged", () => {
    withTarget((target, dir) => {
      const backups = join(dir, "backups");
      const other = JSON.stringify({ claudeAiOauth: { accessToken: "theirs", refreshToken: "" } });
      writeFileSync(target, `${other}\n`, { mode: 0o600 });
      const outcome = writeMirror(target, `${SECRET}\n`, scrubbed, backups);
      expect(outcome).toBe("conflict");
      expect(readFileSync(target, "utf8")).toBe(`${other}\n`); // not clobbered
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      // The redundant pre-scrub copy is removed again, so refusals cannot
      // pile up backups.
      expect(existsSync(backups) ? readdirSync(backups) : []).toEqual([]);
    });
  });

  test("a mirror swapped for an oversized file or a FIFO mid-write reports error, unread (review round 78)", () => {
    // The conflict re-read is bounded and refuses non-regular files like
    // every other read of the mirror: a huge file is not read whole and a
    // FIFO never blocks the launch. Nothing is staged and no backup stays.
    const oversized = `${JSON.stringify({ claudeAiOauth: { accessToken: "x".repeat(1024 * 1024), refreshToken: "" } })}\n`;
    withTarget((target, dir) => {
      const backups = join(dir, "backups");
      writeFileSync(target, oversized, { mode: 0o600 });
      expect(writeMirror(target, `${SECRET}\n`, scrubbed, backups)).toBe("error");
      expect(readFileSync(target, "utf8")).toBe(oversized);
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(existsSync(backups) ? readdirSync(backups) : []).toEqual([]);
    });
    if (process.platform === "win32") return;
    withTarget((target, dir) => {
      rmSync(target, { force: true });
      require("node:child_process").execFileSync("mkfifo", [target]);
      const started = Date.now();
      expect(writeMirror(target, `${SECRET}\n`, scrubbed, join(dir, "backups"))).toBe("error");
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });
});
