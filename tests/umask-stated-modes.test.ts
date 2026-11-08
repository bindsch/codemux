/**
 * Review round 401, item 1: open and mkdir modes are masked by the
 * process umask, so a hardened umask (0277 strips the owner's write bit)
 * made every codemux-created file and directory arrive narrower than its
 * stated mode. The registry's reader then refuses its own writer's file
 * (mode must be 0600) and every session command wedges. The fix states
 * the mode after every create; these tests set the umask around one
 * write and assert the stated mode lands. The umask is process-wide, so
 * each test restores it in a finally — bun runs one file's tests in one
 * process, sequentially.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRegistry, recordSessionStart } from "../src/session/registry.js";
import { writePrivateFile } from "../src/private-write.js";
import { createCodexHermeticHome, prepareRunDirParent } from "../src/hermetic-home.js";
import { writeMirror } from "../src/credentials/backups.js";
import { appendCallRecord, CALL_LOG_ENV } from "../src/call-log.js";
import { writeCodexProviderConfigInto } from "../src/codex-provider/config.js";
import { codexProviderSessionsParent, createCodexSessionProviderHome } from "../src/codex-provider/home.js";
import { writeOwnedSync } from "../src/fs-durable.js";
import { createKimiHermeticHome } from "../src/kimi-hermetic.js";
import { MODEL, OVERRIDE, makeCodexHome } from "./helpers/codex-provider.js";
import { makeRoot, newRecord, registryIn } from "./helpers/session-registry.js";
import { SECRET, withTarget } from "./helpers/credentials.js";
import { BASE_RECORD, tempEnv } from "./helpers/call-log.js";

describe("stated modes survive an owner-stripping umask (round 401, item 1)", () => {
  test("a registry write lands 0600 in a 0700 directory the reader accepts", () => {
    const root = makeRoot();
    const path = registryIn(root);
    const previous = process.umask(0o277);
    try {
      expect(recordSessionStart(path, newRecord()).ok).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
      // The reader enforces the unmasked mode; a masked write is refused.
      expect(readRegistry(path).outcome).toBe("ok");
    } finally {
      process.umask(previous);
    }
  });

  test("writePrivateFile lands 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "cmx-pw-umask-"));
    const previous = process.umask(0o277);
    try {
      writePrivateFile(root, "secret.txt", "bytes");
      expect(statSync(join(root, "secret.txt")).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prepareRunDirParent lands 0700", () => {
    const root = mkdtempSync(join(tmpdir(), "cmx-sweep-umask-"));
    const previous = process.umask(0o277);
    try {
      expect(statSync(prepareRunDirParent(root, ".codemux-hermetic")).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previous);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a hermetic run's private HOME and CODEX_HOME land 0700", () => {
    const source = mkdtempSync(join(tmpdir(), "cmx-hh-umask-"));
    const previous = process.umask(0o277);
    let hermetic: ReturnType<typeof createCodexHermeticHome> | null = null;
    try {
      hermetic = createCodexHermeticHome(source, true);
      expect(statSync(hermetic.home).mode & 0o777).toBe(0o700);
      expect(statSync(hermetic.codexHome).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previous);
      hermetic?.finalize();
      rmSync(source, { recursive: true, force: true });
    }
  });

  test("the credential mirror's replacement lands 0600", () => {
    withTarget((target, dir) => {
      const scrubbed = { accessToken: "a", refreshToken: "" };
      const previous = process.umask(0o277);
      try {
        expect(writeMirror(target, `${SECRET}\n`, scrubbed, join(dir, "backups"))).toBe("written");
        expect(statSync(target).mode & 0o777).toBe(0o600);
      } finally {
        process.umask(previous);
      }
    });
  });

  test("the call ledger lands 0600 in a 0700 directory and keeps accepting appends", () => {
    const { env, dir, cleanup } = tempEnv();
    const previous = process.umask(0o277);
    try {
      const path = join(dir, "calls.jsonl");
      const withPath = { ...env, [CALL_LOG_ENV]: path };
      appendCallRecord(BASE_RECORD, withPath);
      appendCallRecord(BASE_RECORD, withPath);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(path.endsWith("calls.jsonl")).toBe(true);
    } finally {
      process.umask(previous);
      cleanup();
    }
  });
  test("a codex override session home and its config land 0700 and 0600 (review round 408)", () => {
    // The provider-override session home was mkdtemp'd (masked) and its
    // config staged with a masked open mode; under umask 0277 the home
    // landed 0500 and the config write inside it failed EACCES at spawn.
    const home = makeCodexHome();
    const previous = process.umask(0o277);
    try {
      createCodexSessionProviderHome(home, OVERRIDE, MODEL, null);
      const parent = codexProviderSessionsParent(home);
      const created = readdirSync(parent).filter((name) => name.startsWith("run-"));
      expect(created).toHaveLength(1);
      const sessionHome = join(parent, created[0]!);
      expect(statSync(sessionHome).mode & 0o777).toBe(0o700);
      // The config is written after the resume claim (prepareConfig), by
      // this writer; staged exclusively with the mode on the descriptor.
      writeCodexProviderConfigInto(sessionHome, OVERRIDE, MODEL, null);
      expect(statSync(join(sessionHome, "config.toml")).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a kimi hermetic home, its config, skills dir, and agent file state their modes", () => {
    const root = mkdtempSync(join(tmpdir(), "codemux-umask-kimi-"));
    writeFileSync(join(root, "config.toml"), 'default_model = "fixture"\n', { mode: 0o600 });
    const previous = process.umask(0o277);
    let created: ReturnType<typeof createKimiHermeticHome> | null = null;
    try {
      created = createKimiHermeticHome(root, false, false);
      expect(statSync(created.home).mode & 0o777).toBe(0o700);
      expect(statSync(created.kimiHome).mode & 0o777).toBe(0o700);
      expect(statSync(created.skillsDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(created.kimiHome, "config.toml")).mode & 0o777).toBe(0o600);
      expect(statSync(created.agentFile).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
      created?.finalize();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writeOwnedSync replaces a profile file in place and states 0600 under the umask", () => {
    // The kimi experiment rewrites the agent file the hermetic home
    // created, so the writer must replace, not refuse, an existing file.
    const dir = mkdtempSync(join(tmpdir(), "codemux-umask-owned-"));
    const path = join(dir, "agent.md");
    const previous = process.umask(0o277);
    try {
      writeOwnedSync(path, "first\n", 0o600);
      writeOwnedSync(path, "second\n", 0o600);
      expect(readFileSync(path, "utf8")).toBe("second\n");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
