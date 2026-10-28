import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { CursorAdapter } from "../src/adapters/cursor.js";
import { launchRunRequest } from "../src/launch.js";
import type { RunRequest, RunResult } from "../src/types.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

const STORE_ENV = "AGENT_CLI_CREDENTIAL_STORE";
const HINT = "codemux: cursor's default login lives in the macOS Keychain, which the sandbox blocks; " +
  "log in once with the file store (AGENT_CLI_CREDENTIAL_STORE=file cursor-agent login), " +
  "pass an API key or auth token, or run with --no-sandbox";
const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

function setup(authFile = true, extraEnv: NodeJS.ProcessEnv = {}) {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "cursor-credentials-test-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  for (const dir of [home, cwd, bin]) mkdirSync(dir);
  if (authFile) {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor/auth.json"), "{}", { mode: 0o600 });
  }
  const env = { HOME: home, PATH: bin, ...extraEnv };
  const adapter = new CursorAdapter(undefined, env);
  const request: RunRequest = {
    agent: "cursor", prompt: "test", cwd, autonomy: "read-only", sandboxed: true,
  };
  return { adapter, request, env, home, bin };
}

describe.skipIf(process.platform !== "darwin")("Cursor's sandbox credential store on macOS", () => {
  test("selects the file store when auth.json exists in the adapter's HOME", () => {
    const { adapter, request } = setup(true, { [STORE_ENV]: "keychain" });
    expect(adapter.getRunEnv(request)).toEqual({ [STORE_ENV]: "file" });
    expect(() => adapter.validateRunRequest(request)).not.toThrow();
  });

  test.each([false, undefined])("keeps the default store when sandboxed is %s", (sandboxed) => {
    const { adapter, request } = setup();
    expect(adapter.getRunEnv({ ...request, sandboxed })).toEqual({});
  });

  test.each([true, false])("preserves an explicit store when auth.json exists: %s", (authFile) => {
    const { adapter, request } = setup(authFile, { [STORE_ENV]: "keychain" });
    request.passthroughEnv = [STORE_ENV];
    const injected = adapter.getRunEnv(request);
    expect(injected).toEqual({});
    expect(adapter.buildExecutionEnv(injected, request.passthroughEnv)[STORE_ENV]).toBe("keychain");
    expect(() => adapter.validateRunRequest(request)).not.toThrow();
  });

  test("keeps the default store when auth.json is missing", () => {
    const { adapter, request } = setup(false);
    expect(adapter.getRunEnv(request)).toEqual({});
    expect(() => adapter.validateRunRequest(request)).not.toThrow();
  });

  test("allows a passed-through auth token without an auth file", () => {
    const { adapter, request } = setup(false, { CURSOR_AUTH_TOKEN: "synthetic-auth-token" });
    request.passthroughEnv = ["CURSOR_AUTH_TOKEN"];
    expect(() => adapter.validateRunRequest(request)).not.toThrow();
    expect(adapter.getRunEnv(request)).toEqual({});
    expect(adapter.buildExecutionEnv({}, request.passthroughEnv).CURSOR_AUTH_TOKEN)
      .toBe("synthetic-auth-token");
  });

  test.each([false, true])("allows an API key without an auth file, explicit passthrough: %s", (explicit) => {
    const { adapter, request } = setup(false, { CURSOR_API_KEY: "synthetic-api-key" });
    if (explicit) request.passthroughEnv = ["CURSOR_API_KEY"];
    expect(() => adapter.validateRunRequest(request)).not.toThrow();
    expect(adapter.getRunEnv(request)).toEqual({});
    expect(adapter.buildExecutionEnv({}, request.passthroughEnv).CURSOR_API_KEY).toBe("synthetic-api-key");
  });

  test.each([false, true])("selects the store with an ambient API key, explicit override: %s", (explicit) => {
    const { adapter, request } = setup(true, {
      CURSOR_API_KEY: "synthetic-api-key", [STORE_ENV]: "keychain",
    });
    if (explicit) request.passthroughEnv = [STORE_ENV];
    const injected = adapter.getRunEnv(request);
    expect(injected).toEqual(explicit ? {} : { [STORE_ENV]: "file" });
    const env = adapter.buildExecutionEnv(injected, request.passthroughEnv);
    expect(env[STORE_ENV]).toBe(explicit ? "keychain" : "file");
    expect(env.CURSOR_API_KEY).toBe("synthetic-api-key");
    expect(() => adapter.validateRunRequest(request)).not.toThrow();
  });

  test.each([undefined, ""])("selects the file store when the passed-through store is %s", (value) => {
    const { adapter, request } = setup(true, { [STORE_ENV]: value });
    request.passthroughEnv = [STORE_ENV];
    const injected = adapter.getRunEnv(request);
    expect(injected).toEqual({ [STORE_ENV]: "file" });
    expect(adapter.buildExecutionEnv(injected, request.passthroughEnv)[STORE_ENV]).toBe("file");
    expect(() => adapter.validateRunRequest(request)).not.toThrow();
  });

  test.each([false, undefined])("allows a missing auth file when sandboxed is %s", (sandboxed) => {
    const { adapter, request } = setup(false);
    expect(() => adapter.validateRunRequest({ ...request, sandboxed })).not.toThrow();
  });

  test.each(["Authentication required", "status\nAuthentication required\n"])(
    "appends the hint to a failed run's stderr: %j", (stderr) => {
      const { adapter, request } = setup(false);
      const result: RunResult = { stdout: "output", stderr, exitCode: 7, success: false };
      expect(adapter.processRunResult(result, request)).toEqual({
        ...result,
        stderr: `${stderr}${stderr.endsWith("\n") ? "" : "\n"}${HINT}\n`,
      });
    }
  );

  test("does not append the hint to a successful run", () => {
    const { adapter, request } = setup(false);
    const result: RunResult = {
      stdout: "OK", stderr: "Authentication required\n", exitCode: 0, success: true,
    };
    expect(adapter.processRunResult(result, request)).toBe(result);
  });

  test.each([false, undefined])("does not append the hint when sandboxed is %s", (sandboxed) => {
    const { adapter, request } = setup(false);
    const result: RunResult = {
      stdout: "", stderr: "Authentication required\n", exitCode: 1, success: false,
    };
    expect(adapter.processRunResult(result, { ...request, sandboxed })).toBe(result);
  });

  test.each(["", "Connection refused\n"])("does not append the hint to unrelated stderr: %j", (stderr) => {
    const { adapter, request } = setup(false);
    const result: RunResult = { stdout: "Authentication required", stderr, exitCode: 1, success: false };
    expect(adapter.processRunResult(result, request)).toBe(result);
  });

  test("the CLI prints the post-run hint and preserves Cursor's exit code", async () => {
    const fake = createFakeBinaryEnv({
      "cursor-agent": `if [ "$1" = "--version" ]; then printf '2026.08.11\\n'; exit 0; fi
printf 'Authentication required' >&2
exit 7`,
      scode: `while [ "$1" != "--" ]; do shift; done; shift; exec "$@"`,
    });
    cleanup.push(fake.cleanup);
    const result = await runCli(["run", "-a", "cursor", "--sandbox", "-p", "test"], fake.env);
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("");
    expect(result.stderr).toEndWith(`Authentication required\n${HINT}\n`);
  });

  test.each([true, false])("skips credentials for a PATH-only environment, auth file: %s", (authFile) => {
    const { home, bin, request } = setup(authFile);
    const homeOf = spyOn(os, "homedir").mockReturnValue(home);
    try {
      const adapter = new CursorAdapter(undefined, { PATH: bin });
      expect(adapter.getRunEnv(request)).toEqual({});
      expect(homeOf).not.toHaveBeenCalled();
      expect(() => adapter.validateRunRequest(request)).not.toThrow();
    } finally {
      homeOf.mockRestore();
    }
  });

  test.each([false, true])("the spawned command receives the selected store, explicit override: %s", async (explicit) => {
    const { env, bin, request } = setup(true, { [STORE_ENV]: "keychain" });
    writeFileSync(join(bin, "cursor-agent"), `#!/bin/sh
if [ "$1" = "--version" ]; then printf '2026.08.11\\n'; exit 0; fi
printf '%s' "$AGENT_CLI_CREDENTIAL_STORE"
`, { mode: 0o700 });
    writeFileSync(join(bin, "scode"), `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'scode 0.6.0\\n'; exit 0; fi
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`, { mode: 0o700 });
    const adapter = new CursorAdapter(undefined, env);
    if (explicit) request.passthroughEnv = [STORE_ENV];
    const result = await launchRunRequest(adapter, request, {
      sandbox: true, requestedAutonomy: "read-only", cwd: request.cwd,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(explicit ? "keychain" : "file");
    expect(result.stderr).toBe("");
  });
});

test.skipIf(process.platform === "darwin")("Cursor does not append the macOS hint on other platforms", () => {
  const { adapter, request } = setup(false);
  const result: RunResult = {
    stdout: "", stderr: "Authentication required\n", exitCode: 1, success: false,
  };
  expect(adapter.processRunResult(result, request)).toBe(result);
});
