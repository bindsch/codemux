import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgyAdapter } from "../src/adapters/agy.js";
import { agyKeychainHost } from "../src/agy-keychain.js";
import type { RunRequest } from "../src/types.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

function setup(autonomy: RunRequest["autonomy"] = "medium", settings?: unknown) {
  mkdirSync(join(import.meta.dir, "../scratch"), { recursive: true });
  const home = mkdtempSync(join(import.meta.dir, "../scratch/agy-autonomy-test-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const homeMock = spyOn(agyKeychainHost, "home").mockReturnValue(home);
  cleanup.push(() => homeMock.mockRestore());
  const state = join(home, ".gemini/antigravity-cli");
  mkdirSync(state, { recursive: true });
  const settingsPath = join(state, "settings.json");
  if (settings !== undefined) writeFileSync(settingsPath, JSON.stringify(settings));
  const adapter = new AgyAdapter({ HOME: home, GEMINI_API_KEY: "synthetic-api-key" });
  const request: RunRequest = { agent: "agy", prompt: "test", cwd: home, autonomy, sandboxed: true };
  return { adapter, request, settingsPath };
}

function prepare(adapter: AgyAdapter, request: RunRequest) {
  const context = adapter.prepareRun(request);
  cleanup.push(() => adapter.cleanupRun(context));
  const settingsPath = join(context.agyProbe!.home!, ".gemini/antigravity-cli/settings.json");
  return { context, settingsPath };
}

test("headless medium grants commands in private settings when no settings exist", () => {
  const { adapter, request, settingsPath: original } = setup();
  const { context, settingsPath } = prepare(adapter, request);
  expect(existsSync(settingsPath)).toBe(true);
  expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ permissions: { allow: ["command(*)"] } });
  expect(lstatSync(settingsPath).isFile()).toBe(true);
  expect(lstatSync(settingsPath).mode & 0o777).toBe(0o600);
  expect(existsSync(original)).toBe(false);
  const command = adapter.buildRunCommand(request, context);
  expect(command).toContain("--mode=accept-edits");
  expect(command).not.toContain("--dangerously-skip-permissions");
});

test.each([{ commands: [] }, { commands: ["command(*)"] }])("headless medium preserves operator settings and permission rules: %j", ({ commands }) => {
  const original = {
    model: "saved-model", unknownSetting: { preserved: true },
    permissions: {
      allow: ["read_url(example.com)", ...commands], ask: ["command(git push)"],
      deny: ["command(rm)", "write_file(/protected)", "mcp(private/*)"],
    },
  };
  const { adapter, request, settingsPath: operatorPath } = setup("medium", original);
  const operatorText = readFileSync(operatorPath, "utf8");
  const { settingsPath } = prepare(adapter, request);
  expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
    ...original, permissions: { ...original.permissions, allow: ["read_url(example.com)", "command(*)"] },
  });
  expect(lstatSync(settingsPath).isSymbolicLink()).toBe(false);
  expect(readFileSync(operatorPath, "utf8")).toBe(operatorText);
});

test.each(["read-only", "low"] as const)("headless %s preserves shared settings without granting commands", (autonomy) => {
  const original = { permissions: { allow: ["read_url(example.com)"], deny: ["command(rm)"] } };
  const { adapter, request } = setup(autonomy, original);
  const { settingsPath } = prepare(adapter, request);
  expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(original);
});

test.each(["read-only", "low"] as const)("headless %s creates no settings when none exist", (autonomy) => {
  const { adapter, request } = setup(autonomy);
  const { settingsPath } = prepare(adapter, request);
  expect(existsSync(settingsPath)).toBe(false);
});

test("tools none keeps the complete deny list without an allow grant", () => {
  const { adapter, request } = setup("read-only");
  request.tools = "none";
  const { settingsPath } = prepare(adapter, request);
  expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ permissions: { deny: [
    "read_file(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "command(*)", "unsandboxed(*)", "mcp(*)",
  ] } });
});

test("interactive medium keeps the native accept-edits command", () => {
  const { adapter } = setup();
  expect(adapter.mapAutonomy("medium")).toEqual(["--mode=accept-edits"]);
  expect(adapter.buildTuiCommand(undefined, "medium")).toEqual(["agy", "--mode=accept-edits"]);
});

test.each([null, [], { permissions: [] }, { permissions: { allow: "command(*)" } },
  { permissions: { allow: [3] } }].map((settings) => ({ settings })))("headless medium rejects malformed settings without changing them: %j", ({ settings }) => {
  const { adapter, request, settingsPath } = setup("medium", settings);
  const original = readFileSync(settingsPath, "utf8");
  expect(() => adapter.prepareRun(request)).toThrow("invalid agy settings");
  expect(readFileSync(settingsPath, "utf8")).toBe(original);
});

test("headless medium reports invalid JSON without exposing its contents", () => {
  const { adapter, request, settingsPath } = setup();
  writeFileSync(settingsPath, "synthetic-private-invalid-json");
  expect(() => adapter.prepareRun(request)).toThrow(`cannot read agy settings: ${settingsPath}`);
  expect(readFileSync(settingsPath, "utf8")).toBe("synthetic-private-invalid-json");
});
