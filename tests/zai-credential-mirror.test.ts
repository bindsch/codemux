/**
 * Review round 372, item 1: a sandboxed Z.AI launch runs the same claude
 * binary under the same sandbox as a claude run, reading the same default
 * config directory, yet skipped the credential-mirror guard entirely. A
 * refresh token in the operator's mirror, backed by a Keychain entry, is
 * the hazard the claude adapter refuses on a provider-override run
 * (2026-10-05); zai now refuses it the same way. The reader is injected,
 * so the real Keychain is never touched.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ZaiAdapter } from "../src/adapters/zai.js";
import type { SecretReadResult } from "../src/credentials.js";
import { SECRET, errors, gives, missing, withTarget } from "./helpers/credentials.js";

const saved = process.env.CODEMUX_NO_KEYCHAIN_SYNC;
beforeEach(() => {
  delete process.env.CODEMUX_NO_KEYCHAIN_SYNC;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CODEMUX_NO_KEYCHAIN_SYNC;
  else process.env.CODEMUX_NO_KEYCHAIN_SYNC = saved;
});

class StubbedZaiAdapter extends ZaiAdapter {
  constructor(
    private readonly targetPath: string,
    reader: (service: string) => SecretReadResult = gives(SECRET),
    environment: NodeJS.ProcessEnv = { HOME: "/nonexistent-home", ZAI_API_KEY: "zai-key" }
  ) {
    super(environment);
    this.credentialReader = reader;
  }
  protected override credentialTarget = () => this.targetPath;
}

const WITH_REFRESH = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "LIVE" } });
const ACCESS_ONLY = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "" } });

describe("ZaiAdapter.prepareSandbox guards the operator's Claude credential mirror", () => {
  test("refuses a sandboxed launch when the mirror holds a refresh token a Keychain entry backs", () => {
    withTarget((target) => {
      writeFileSync(target, `${WITH_REFRESH}\n`, { mode: 0o600 });
      const adapter = new StubbedZaiAdapter(target);
      expect(() => adapter.prepareSandbox({ sandboxTrust: "standard" }))
        .toThrow(/zai: the credential mirror at .* holds a refresh token\. A Z\.AI run never uses the operator login/);
      // A Keychain read that fails is still a possible entry: refused too.
      expect(() => new StubbedZaiAdapter(target, errors).prepareSandbox({ sandboxTrust: "standard" }))
        .toThrow(/holds a refresh token/);
    });
  });

  test("a file-only login (no Keychain entry) and an access-only mirror launch", () => {
    withTarget((target) => {
      writeFileSync(target, `${WITH_REFRESH}\n`, { mode: 0o600 });
      expect(() => new StubbedZaiAdapter(target, missing).prepareSandbox({ sandboxTrust: "standard" })).not.toThrow();
      writeFileSync(target, `${ACCESS_ONLY}\n`, { mode: 0o600 });
      expect(() => new StubbedZaiAdapter(target).prepareSandbox({ sandboxTrust: "standard" })).not.toThrow();
    });
  });

  test("an untrusted sandbox denies the file to the child, so nothing is checked", () => {
    withTarget((target) => {
      writeFileSync(target, `${WITH_REFRESH}\n`, { mode: 0o600 });
      expect(() => new StubbedZaiAdapter(target).prepareSandbox({ sandboxTrust: "untrusted" })).not.toThrow();
    });
  });

  test("a passed-through profile redirect is reported like claude's (review 376)", () => {
    withTarget((target, dir) => {
      writeFileSync(target, `${ACCESS_ONLY}\n`, { mode: 0o600 });
      const profile = join(dir, "profile");
      mkdirSync(profile);
      writeFileSync(join(profile, ".credentials.json"), `${WITH_REFRESH}\n`, { mode: 0o600 });
      const adapter = new StubbedZaiAdapter(target, gives(SECRET), {
        HOME: "/nonexistent-home", ZAI_API_KEY: "zai-key", CLAUDE_CONFIG_DIR: profile,
      });
      const lines: string[] = [];
      const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
        lines.push(values.map(String).join(" "));
      });
      try {
        adapter.prepareSandbox({ sandboxTrust: "standard", passthroughEnv: ["CLAUDE_CONFIG_DIR"] });
      } finally {
        error.mockRestore();
      }
      expect(lines.some((line) => line.startsWith("zai: CLAUDE_CONFIG_DIR points the child at a non-default credential mirror")
        && line.includes("holds a refresh token codemux does not manage"))).toBe(true);
    });
  });

  test("the Keychain opt-out reports the file and never refuses", () => {
    withTarget((target) => {
      writeFileSync(target, `${WITH_REFRESH}\n`, { mode: 0o600 });
      process.env.CODEMUX_NO_KEYCHAIN_SYNC = "1";
      const lines: string[] = [];
      const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
        lines.push(values.map(String).join(" "));
      });
      try {
        expect(() => new StubbedZaiAdapter(target).prepareSandbox({ sandboxTrust: "standard" })).not.toThrow();
      } finally {
        error.mockRestore();
      }
      expect(lines.some((line) => line.startsWith("zai: CODEMUX_NO_KEYCHAIN_SYNC is set") && line.includes("refresh token"))).toBe(true);
    });
  });
});
