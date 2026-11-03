import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  claudeCredentialTarget,
  decodeSecurityOutput,
  hasUsableClaudeCredential,
  readKeychainSecret,
} from "../src/credentials.js";
import { SECRET } from "./helpers/credentials.js";

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
