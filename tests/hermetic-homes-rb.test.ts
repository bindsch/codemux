import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGeminiHermeticHome, GEMINI_NO_TOOLS_SETTINGS } from "../src/gemini-hermetic.js";
import { createCopilotHermeticHome } from "../src/copilot-hermetic.js";
import { createGooseHermeticHome } from "../src/goose-hermetic.js";
import { createOpenhandsHermeticHome } from "../src/openhands-hermetic.js";
import { createAiderHermeticHome } from "../src/aider-hermetic.js";

// The shared private-home contract every parity-lane hermetic module
// holds: a 0700 run directory under the harness's real state directory,
// removed by finalize, never touching anything beside it.
describe("the parity hermetic homes", () => {
  let source: string;
  const makeSource = (): void => {
    source = mkdtempSync(join(tmpdir(), "hermetic-src-"));
  };
  const cleanUp = (): void => rmSync(source, { recursive: true, force: true });

  test.each([
    ["gemini", (dir: string) => createGeminiHermeticHome(dir, { apiKeyAuth: true })],
    ["copilot", (dir: string) => createCopilotHermeticHome(dir, { copyLogin: false })],
    ["goose", createGooseHermeticHome],
    ["openhands", createOpenhandsHermeticHome],
    ["aider", createAiderHermeticHome],
  ])("%s: private home under the source directory, mode 0700, removed by finalize", (_name, create) => {
    makeSource();
    try {
      const home = create(join(source, "state"));
      const parent = join(source, "state", ".codemux-hermetic");
      expect(home.home.startsWith(join(parent, `run-${process.pid}-`))).toBe(true);
      expect(statSync(home.home).isDirectory()).toBe(true);
      expect((statSync(home.home).mode & 0o777)).toBe(0o700);
      home.finalize();
      expect(existsSync(home.home)).toBe(false);
      expect(existsSync(join(source, "state"))).toBe(true);
      // Idempotent: a second finalize is a no-op, not a throw.
      home.finalize();
    } finally {
      cleanUp();
    }
  });

  test("gemini: writes the deny-all tools settings only for --tools none", () => {
    makeSource();
    try {
      const plain = createGeminiHermeticHome(join(source, "g1"), { apiKeyAuth: true });
      expect(existsSync(join(plain.geminiDir, "settings.json"))).toBe(false);
      plain.finalize();
      const toolsNone = createGeminiHermeticHome(join(source, "g2"), {
        toolsNone: true,
        apiKeyAuth: true,
      });
      expect(readFileSync(join(toolsNone.geminiDir, "settings.json"), "utf-8"))
        .toBe(GEMINI_NO_TOOLS_SETTINGS);
      expect((statSync(join(toolsNone.geminiDir, "settings.json")).mode & 0o777)).toBe(0o600);
      toolsNone.finalize();
    } finally {
      cleanUp();
    }
  });

  test("gemini: hard links the login files, and carries none under an API-key override", () => {
    makeSource();
    try {
      const sourceDir = join(source, "g3");
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, "oauth_creds.json"), "{}");
      const linked = createGeminiHermeticHome(sourceDir);
      const link = join(linked.geminiDir, "oauth_creds.json");
      expect(existsSync(link)).toBe(true);
      // A hard link shares the inode with the operator's login file: a
      // refresh in either place lands in both (the codex rule).
      expect(lstatSync(link).ino).toBe(lstatSync(join(sourceDir, "oauth_creds.json")).ino);
      linked.finalize();
      const overridden = createGeminiHermeticHome(sourceDir, { apiKeyAuth: true });
      expect(existsSync(join(overridden.geminiDir, "oauth_creds.json"))).toBe(false);
      overridden.finalize();
    } finally {
      cleanUp();
    }
  });

  test("copilot: hard links the login file, falls back to a symlink, and env-token logins carry none", () => {
    makeSource();
    try {
      const sourceDir = join(source, "copilot");
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, "config.json"), "{}");
      const linked = createCopilotHermeticHome(sourceDir);
      const link = join(linked.home, "config.json");
      expect(existsSync(link)).toBe(true);
      expect(lstatSync(link).ino).toBe(lstatSync(join(sourceDir, "config.json")).ino);
      linked.finalize();
      // A filesystem that refuses hard links (a cross-device home, for
      // instance) gets a symlink instead of a failure.
      const symlinked = createCopilotHermeticHome(sourceDir, {
        loginLinks: {
          hard: () => {
            throw new Error("EPERM");
          },
          symlink: (from, to) => {
            // bun:test runs on a real FS; emulate by copying is wrong, so
            // plant a real symlink to the source file.
            const { symlinkSync } = require("node:fs") as typeof import("node:fs");
            symlinkSync(from, to);
          },
        },
      });
      expect(lstatSync(join(symlinked.home, "config.json")).isSymbolicLink()).toBe(true);
      symlinked.finalize();
      // No login file at all (an env-token login) is not a failure.
      const bare = createCopilotHermeticHome(join(source, "empty"));
      expect(existsSync(join(bare.home, "config.json"))).toBe(false);
      bare.finalize();
    } finally {
      cleanUp();
    }
  });

  test("goose: the env assignments redirect GOOSE_PATH_ROOT and all three XDG roots into the home", () => {
    makeSource();
    let home: ReturnType<typeof createGooseHermeticHome> | undefined;
    try {
      home = createGooseHermeticHome(join(source, "goose"));
      // GOOSE_PATH_ROOT selects the root directly (goose 1.50.1 paths.rs).
      expect(home.envAssignments).toEqual([
        `GOOSE_PATH_ROOT=${home.home}`,
        `XDG_CONFIG_HOME=${join(home.home, "config")}`,
        `XDG_DATA_HOME=${join(home.home, "share")}`,
        `XDG_CACHE_HOME=${join(home.home, "cache")}`,
      ]);
    } finally {
      // Finalize even when an assertion fails: a home left tracked keeps
      // its signal handlers installed for every later test file (F47).
      home?.finalize();
      cleanUp();
    }
  });
});
