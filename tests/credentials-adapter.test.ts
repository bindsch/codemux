import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { syncKeychainCredential, type SecretReadResult } from "../src/credentials.js";
import { SECRET, errors, gives, withTarget } from "./helpers/credentials.js";

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
