/**
 * A hermetic OpenCode run keeps the operator's model preference
 * (`$XDG_STATE_HOME/opencode/model.json`): without it the private state
 * directory made OpenCode fall to the provider's first model, one the
 * subscription did not include (live gate, 2026-11-02). The copy is
 * refused for anything but a regular, user-owned, small, valid-JSON file.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext } from "../src/adapters/base.js";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import { opencodeRealStateDir } from "../src/adapters/opencode-home.js";
import * as fs from "node:fs";
import { carryOpencodeModelState, createOpencodeHermeticHome } from "../src/opencode-hermetic.js";
import type { RunRequest } from "../src/types.js";

describe("hermetic opencode model preference", () => {
  const scratch: string[] = [];
  const prepared: { adapter: OpencodeAdapter; context: RunContext }[] = [];
  afterEach(() => {
    for (const { adapter, context } of prepared.splice(0)) adapter.cleanupRun(context);
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const home = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-opencode-model-"));
    scratch.push(dir);
    return dir;
  };
  const preference = JSON.stringify({ recent: [{ providerID: "openai", modelID: "gpt-5.6-sol" }] });

  test("the state directory follows XDG_STATE_HOME, else ~/.local/state", () => {
    expect(opencodeRealStateDir({ XDG_STATE_HOME: "/s" }, "/h")).toBe("/s/opencode");
    expect(opencodeRealStateDir({}, "/h")).toBe("/h/.local/state/opencode");
    expect(() => opencodeRealStateDir({ XDG_STATE_HOME: "rel" }, "/h")).toThrow("absolute");
  });

  test("prepareRun copies model.json into the private state byte for byte", () => {
    const userHome = home();
    const stateDir = join(userHome, ".local", "state", "opencode");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "model.json"), preference);
    const adapter = new OpencodeAdapter({}, userHome);
    const request: RunRequest = { agent: "opencode", prompt: "p", hermetic: true };
    const context = adapter.prepareRun(request);
    prepared.push({ adapter, context });
    const privateHome = context.opencodeHermeticHome!.home;
    expect(readFileSync(join(privateHome, ".local", "state", "opencode", "model.json"), "utf8")).toBe(preference);
  });

  test("a missing preference copies nothing and says nothing", () => {
    const userHome = home();
    const target = join(userHome, "private");
    mkdirSync(target);
    expect(carryOpencodeModelState(join(userHome, "none"), target)).toBeUndefined();
    expect(existsSync(join(target, ".local"))).toBe(false);
  });

  test("a symlink, an oversized file, and malformed JSON are refused with the reason", () => {
    const userHome = home();
    const stateDir = join(userHome, "state");
    mkdirSync(stateDir);
    const target = join(userHome, "private");
    mkdirSync(target);
    writeFileSync(join(userHome, "elsewhere.json"), preference);
    symlinkSync(join(userHome, "elsewhere.json"), join(stateDir, "model.json"));
    expect(carryOpencodeModelState(stateDir, target)).toContain("not a regular file");
    rmSync(join(stateDir, "model.json"));
    writeFileSync(join(stateDir, "model.json"), `{"pad":"${"x".repeat(64 * 1024)}"}`);
    expect(carryOpencodeModelState(stateDir, target)).toContain("larger than");
    writeFileSync(join(stateDir, "model.json"), "{not json");
    expect(carryOpencodeModelState(stateDir, target)).toContain("not readable JSON");
    // Writable by other accounts: another local user could choose the model
    // of a hermetic run (round 29, edges 3).
    writeFileSync(join(stateDir, "model.json"), preference);
    chmodSync(join(stateDir, "model.json"), 0o666);
    expect(carryOpencodeModelState(stateDir, target)).toContain("writable by other accounts");
    expect(existsSync(join(target, ".local"))).toBe(false);
  });

  test("a copy that throws removes the home it was filling (review round 22, edges 3)", () => {
    const userHome = home();
    const dataDir = join(userHome, ".local", "share", "opencode");
    const stateDir = join(userHome, ".local", "state", "opencode");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "model.json"), preference);
    const write = spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("ENOSPC: no space left"); });
    try {
      expect(() => createOpencodeHermeticHome(dataDir, stateDir)).toThrow("ENOSPC");
    } finally {
      write.mockRestore();
    }
    const parent = join(dataDir, ".codemux-hermetic");
    expect(existsSync(parent) ? readdirSync(parent).filter((name) => name.startsWith("run-")) : []).toEqual([]);
  });
});
