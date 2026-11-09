import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGoosePlaywrightExtension } from "../src/goose-playwright.js";
import { executableCheck } from "../src/executable-security.js";

function bin(parent: string, name = "playwright-mcp"): { dir: string; path: string } {
  const dir = join(parent, `bin-${name}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return { dir, path };
}

function scratch(label: string): string {
  const parent = join(process.cwd(), "scratch", "fix", "goose-playwright-synthetic");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, `${label}-`));
}

describe("goose playwright extension carrier", () => {
  test("no sandbox or no flag carries no extension", () => {
    expect(buildGoosePlaywrightExtension(undefined, { enabled: true, pathEnv: "" })).toEqual({ args: [], check: null });
    expect(buildGoosePlaywrightExtension(true, { enabled: false, pathEnv: "" })).toEqual({ args: [], check: null });
  });

  test("a missing binary refuses the launch", () => {
    const root = scratch("missing");
    expect(() => buildGoosePlaywrightExtension(true, { enabled: true, pathEnv: join(root, "absent") }))
      .toThrow("--enable-playwright-mcp requires a locally installed playwright-mcp binary");
    rmSync(root, { recursive: true, force: true });
  });

  test("the extension names the resolved binary and captures its trust check", () => {
    const root = scratch("resolve");
    const { dir, path } = bin(root);
    const extension = buildGoosePlaywrightExtension(true, { enabled: true, pathEnv: dir });
    expect(extension.args).toEqual(["--with-extension", `playwright:${path}`]);
    expect(extension.check?.path).toBe(path);
    expect(executableCheck(path)?.path).toBe(path);
    rmSync(root, { recursive: true, force: true });
  });

  test("a binary inside the execution working directory is refused", () => {
    const root = scratch("forbidden");
    const { dir } = bin(root);
    expect(() => buildGoosePlaywrightExtension(true, { enabled: true, pathEnv: dir, forbiddenRoot: root }))
      .toThrow("playwright-mcp binary must not be inside the execution working directory");
    rmSync(root, { recursive: true, force: true });
  });
});
