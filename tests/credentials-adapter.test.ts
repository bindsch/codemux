import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import { withTarget } from "./helpers/credentials.js";

const provider = {
  CODEMUX_CLAUDE_PROVIDER_BASE_URL: "http://127.0.0.1:9999",
  CODEMUX_CLAUDE_PROVIDER_API_KEY: "synthetic-key",
  CODEMUX_CLAUDE_PROVIDER_MODEL: "synthetic-model",
};

test.each(["plain", "profile", "provider", "zai"])("%s preparation never reads or changes login files", (kind) => {
  withTarget((target, dir) => {
    const profile = join(dir, "profile");
    fs.mkdirSync(profile);
    const profileLogin = join(profile, ".credentials.json");
    const seed = fs.readFileSync(target, "utf8");
    fs.writeFileSync(profileLogin, seed);
    class TestClaude extends ClaudeAdapter { protected override credentialTarget = () => target; }
    class TestZai extends ZaiAdapter { protected override credentialTarget = () => target; }
    const environment = { HOME: dir, CLAUDE_CONFIG_DIR: profile, CLAUDE_SECURESTORAGE_CONFIG_DIR: profile };
    const adapter = kind === "zai" ? new TestZai({ ...environment, ZAI_API_KEY: "synthetic" })
      : new TestClaude(kind === "provider" ? { ...environment, ...provider } : kind === "profile" ? environment : { HOME: dir });
    const reads = spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("unexpected login read"); });
    const writes = spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("unexpected login write"); });
    const open = spyOn(fs, "openSync").mockImplementation(() => { throw new Error("unexpected login open"); });
    const spawn = spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("unexpected native command"); });
    try {
      for (const sandboxTrust of ["trusted", "standard", "untrusted"] as const) {
        expect(() => adapter.prepareSandbox({ sandboxTrust, passthroughEnv: ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"] })).not.toThrow();
      }
      expect(() => adapter.beforeLaunch()).not.toThrow();
      for (const probe of [reads, writes, open, spawn]) expect(probe).not.toHaveBeenCalled();
    } finally { reads.mockRestore(); writes.mockRestore(); open.mockRestore(); spawn.mockRestore(); }
    expect(fs.readFileSync(target, "utf8")).toBe(seed);
    expect(fs.readFileSync(profileLogin, "utf8")).toBe(seed);
    expect(fs.readdirSync(dir).sort()).toEqual([".credentials.json", "profile"]);
  });
});

test("missing and invalid login files never prevent adapter preparation", () => {
  withTarget((target) => {
    class TestClaude extends ClaudeAdapter { protected override credentialTarget = () => target; }
    const adapter = new TestClaude({});
    expect(() => adapter.prepareSandbox()).not.toThrow();
    fs.writeFileSync(target, "invalid JSON");
    expect(() => adapter.prepareSandbox()).not.toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("invalid JSON");
  }, "");
});
