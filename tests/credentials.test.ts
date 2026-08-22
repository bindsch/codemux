import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const gives = (value: string) => (_service: string): SecretReadResult => ({
  kind: "secret",
  value,
});
const missing = (_service: string): SecretReadResult => ({ kind: "missing" });
const errors = (_service: string): SecretReadResult => ({ kind: "error", detail: "locked" });

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
      expect(syncKeychainCredential("svc", target, gives(fresh))).toBe("synced");
      expect(readFileSync(target, "utf8").trim()).toBe(fresh);
      expect(statSync(target).mode & 0o777).toBe(0o600);
    }, JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "old" } }));
  });

  test("does nothing — and never creates — when no mirror file exists", () => {
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(SECRET))).toBe("absent");
      expect(existsSync(target)).toBe(false);
    }, "");
  });

  test("reports current when the mirror already matches", () => {
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(SECRET))).toBe("current");
    });
  });

  test("only the claudeAiOauth field is synced; the file's own mcpOAuth is kept", () => {
    // File carries its own (newer) MCP token; Keychain carries a different
    // one plus a fresher claude token. Only the claude token should move.
    const fileBlob = JSON.stringify({
      claudeAiOauth: { accessToken: "old", refreshToken: "old", expiresAt: 1000 },
      mcpOAuth: { slack: { accessToken: "file-mcp" } },
    });
    const keychainBlob = JSON.stringify({
      claudeAiOauth: { accessToken: "new", refreshToken: "new", expiresAt: 2000 },
      mcpOAuth: { slack: { accessToken: "keychain-mcp" } },
    });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(keychainBlob))).toBe("synced");
      const written = JSON.parse(readFileSync(target, "utf8"));
      expect(written.claudeAiOauth.accessToken).toBe("new"); // claude token refreshed
      expect(written.mcpOAuth.slack.accessToken).toBe("file-mcp"); // file's MCP untouched
    }, fileBlob);
  });

  test("a file with no Claude credential is never given one (no fabrication)", () => {
    const mcpOnlyFile = JSON.stringify({ mcpOAuth: { notion: { accessToken: "x" } } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(SECRET))).toBe("foreign");
      expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ mcpOAuth: { notion: { accessToken: "x" } } });
    }, mcpOnlyFile);
  });

  test("a corrupt (non-JSON) mirror is left alone (not a mirror we manage)", () => {
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(SECRET))).toBe("foreign");
      expect(readFileSync(target, "utf8")).toBe("not json at all\n");
    }, "not json at all");
  });

  test("a directory at the staging path is never deleted by cleanup", () => {
    withTarget((target) => {
      const staging = `${target}.${process.pid}.tmp`;
      require("node:fs").mkdirSync(staging);
      require("node:fs").writeFileSync(join(staging, "precious"), "keep");
      // Write fails (staging occupied by a dir), sync fails, but the dir survives.
      expect(syncKeychainCredential("svc", target, gives(JSON.stringify({ claudeAiOauth: { accessToken: "z", refreshToken: "z", expiresAt: 9 } })))).toBe("failed");
      expect(require("node:fs").readFileSync(join(staging, "precious"), "utf8")).toBe("keep");
    }, JSON.stringify({ claudeAiOauth: { accessToken: "o", refreshToken: "o", expiresAt: 1 } }));
  });

  test("an mcpOAuth-only Keychain blob never clobbers a working mirror", () => {
    const mcpOnly = JSON.stringify({ mcpOAuth: { notion: { accessToken: "x" } } });
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, gives(mcpOnly))).toBe("missing");
      expect(readFileSync(target, "utf8").trim()).toBe(SECRET); // untouched
    });
  });

  test("a file fresher than the Keychain is left alone (sandbox-rotated token)", () => {
    const older = JSON.stringify({ claudeAiOauth: { accessToken: "k", refreshToken: "k", expiresAt: 1000 } });
    const newer = JSON.stringify({ claudeAiOauth: { accessToken: "f", refreshToken: "f", expiresAt: 2000 } });
    withTarget((target) => {
      // The Keychain (older) must not clobber the file's newer credential.
      expect(syncKeychainCredential("svc", target, gives(older))).toBe("current");
      expect(readFileSync(target, "utf8").trim()).toBe(newer);
      // A Keychain that has caught up (equal/newer) does refresh.
      const caughtUp = JSON.stringify({ claudeAiOauth: { accessToken: "k2", refreshToken: "k2", expiresAt: 3000 } });
      expect(syncKeychainCredential("svc", target, gives(caughtUp))).toBe("synced");
    }, newer);
  });

  test("an unreadable existing mirror fails (warns), rather than reporting absent", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    withTarget((target) => {
      require("node:fs").chmodSync(target, 0o000);
      try {
        expect(syncKeychainCredential("svc", target, gives(SECRET))).toBe("failed");
      } finally {
        require("node:fs").chmodSync(target, 0o600);
      }
    });
  });

  test("distinguishes a missing Keychain entry from a read error", () => {
    withTarget((target) => {
      expect(syncKeychainCredential("svc", target, missing)).toBe("missing");
      expect(syncKeychainCredential("svc", target, errors)).toBe("failed");
    });
  });

  test("a symlinked target is refused, never followed", () => {
    withTarget((target, dir) => {
      const real = join(dir, "elsewhere.json");
      writeFileSync(real, "{}");
      rmSync(target, { force: true });
      symlinkSync(real, target);
      expect(syncKeychainCredential("svc", target, gives(SECRET))).toBe("failed");
      expect(readFileSync(real, "utf8")).toBe("{}"); // the link's target is untouched
    }, "");
  });

  test("a planted staging symlink cannot capture the credential", () => {
    const stale = JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "old", expiresAt: 1 } });
    const fresh = JSON.stringify({ claudeAiOauth: { accessToken: "new", refreshToken: "new", expiresAt: 2 } });
    withTarget((target, dir) => {
      const capture = join(dir, "capture.json");
      symlinkSync(capture, `${target}.${process.pid}.tmp`);
      expect(syncKeychainCredential("svc", target, gives(fresh))).toBe("synced");
      expect(existsSync(capture)).toBe(false); // the link was cleared, not written through
    }, stale);
  });

  test("CODEMUX_NO_KEYCHAIN_SYNC=1 skips before touching anything", () => {
    withTarget((target) => {
      process.env.CODEMUX_NO_KEYCHAIN_SYNC = "1";
      const explode = (_s: string): SecretReadResult => {
        throw new Error("must not read");
      };
      expect(syncKeychainCredential("svc", target, explode)).toBe("skipped");
    });
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
  test("true only for a claudeAiOauth object with a non-empty token", () => {
    expect(hasUsableClaudeCredential(SECRET)).toBe(true);
    expect(hasUsableClaudeCredential(JSON.stringify({ claudeAiOauth: { accessToken: "" } }))).toBe(false);
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
}

describe("ClaudeAdapter.prepareSandbox", () => {
  test("refreshes an existing mirror on a trusted sandbox", () => {
    withTarget((target) => {
      const stale = JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "old" } });
      writeFileSync(target, `${stale}\n`, { mode: 0o600 });
      const adapter = new StubbedClaudeAdapter(target);
      adapter.prepareSandbox({ sandboxTrust: "standard" });
      expect(readFileSync(target, "utf8").trim()).toBe(SECRET);
    });
  });

  test("a passed-through CLAUDE_CONFIG_DIR skips the sync (custom profile)", () => {
    withTarget((target) => {
      const stale = JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "old" } });
      writeFileSync(target, `${stale}\n`, { mode: 0o600 });
      const prev = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = "/tmp/custom";
      try {
        const adapter = new StubbedClaudeAdapter(target);
        adapter.prepareSandbox({ sandboxTrust: "standard", passthroughEnv: ["CLAUDE_CONFIG_DIR"] });
        expect(readFileSync(target, "utf8").trim()).toBe(stale); // untouched
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

  test("a keychain read error warns but never throws", () => {
    withTarget((target) => {
      const adapter = new StubbedClaudeAdapter(target, errors);
      expect(() => adapter.prepareSandbox({ sandboxTrust: "standard" })).not.toThrow();
    });
  });
});
