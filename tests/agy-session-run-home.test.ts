import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { prepareAgySessionRunHome } from "../src/session/agy-run-home.js";
import { prepareSessionChild } from "../src/session/cli-spawn-prep.js";
import type { SandboxOptions } from "../src/sandbox.js";
import { cleanup, setup } from "./helpers/agy-login.js";

afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

test("ordinary agy session context supplies the shared login to its command and environment", async () => {
  const f = setup();
  const previousHome = process.env.HOME;
  process.env.HOME = f.home;
  const prepared = prepareAgySessionRunHome(f.adapter, f.request, {}, false, false);
  try {
    const home = prepared.context!.agyProbe!.home!;
    expect(readlinkSync(join(home, ".gemini/antigravity-cli/conversations")))
      .toBe(join(f.home, ".gemini/antigravity-cli/conversations"));
    const child = await prepareSessionChild({
      options: { sandbox: true }, agentId: "agy", adapter: f.adapter, override: null,
      runLike: f.request, resumeId: undefined, model: undefined, autonomy: "read-only", effort: undefined,
      workdir: f.request.cwd!, requestedAutonomy: "read-only", sandboxOptions: {}, claudeBuilt: null,
      codexSessionHome: null, sessionProjectDir: null, sessionPrivateHome: null, agyRunContext: prepared.context,
      turnPerProcess: false, needsKeepEnvPreflight: false,
      buildSessionEnvironment: (context) => {
        expect(context).toBe(prepared.context);
        return { runEnv: {}, env: f.env };
      },
    });
    expect(child.argv).toContain(`HOME=${home}`);
    child.buildLongLivedEnvironment();
    await prepared.cleanup();
    await prepared.cleanup();
    expect(existsSync(home)).toBe(false);
    expect(existsSync(join(f.home, ".gemini/antigravity-cli/conversations"))).toBe(true);
  } finally {
    await prepared.cleanup();
    process.env.HOME = previousHome;
  }
});

test("agy session run-home preparation skips existing session homes and unsandboxed requests", async () => {
  const f = setup();
  for (const [request, hasHome] of [[f.request, true], [{ ...f.request, sandboxed: false }, false]] as const) {
    const prepared = prepareAgySessionRunHome(f.adapter, request, undefined, false, hasHome);
    expect(prepared.context).toBeUndefined();
    await prepared.cleanup();
  }
  const preview = prepareAgySessionRunHome(f.adapter, f.request, {}, true, false);
  expect(preview.context!.agyProbe!.printOnly).toBe(true);
  await preview.cleanup();
});

test("agy session validates HOME before creating shared conversation state", () => {
  const f = setup();
  const previousHome = process.env.HOME;
  process.env.HOME = relative(process.cwd(), f.home);
  try {
    expect(() => prepareAgySessionRunHome(f.adapter, f.request, {}, false, false))
      .toThrow("agy probe HOME must be absolute");
    expect(existsSync(join(f.home, ".gemini/antigravity-cli/conversations"))).toBe(false);
  } finally { process.env.HOME = previousHome; }
});

test("a plain sandboxed agy session blocks the operator's real .gemini and re-allows its private home", async () => {
  const f = setup();
  const previousHome = process.env.HOME;
  process.env.HOME = f.home;
  const sandboxOptions: SandboxOptions = { agentId: "agy" };
  const prepared = prepareAgySessionRunHome(f.adapter, f.request, sandboxOptions, false, false);
  try {
    const home = prepared.context!.agyProbe!.home!;
    // The run path's isolation (launch.ts): the real state tree is blocked,
    // the private home is the one harness state directory re-allowed, and
    // the caller's own blocks stay distinguishable from the launcher's.
    expect(sandboxOptions.blockPaths).toEqual([join(f.home, ".gemini")]);
    // The private home, then the real path of every shared entry: the
    // links' targets sit inside the blocked tree and need their own grant.
    expect(sandboxOptions.harnessStateDirs).toEqual([home, join(f.home, ".gemini/antigravity-cli/conversations")]);
    expect(sandboxOptions.callerBlockPaths).toEqual([]);
  } finally {
    await prepared.cleanup();
    process.env.HOME = previousHome;
  }
});

test("a caller block over the session's private home is refused without leaking the probe home", async () => {
  const f = setup();
  const previousHome = process.env.HOME;
  process.env.HOME = f.home;
  const probes = join(f.home, ".gemini", ".codemux-isolation-probes");
  const sandboxOptions: SandboxOptions = { agentId: "agy", blockPaths: [join(f.home, ".gemini")] };
  try {
    expect(() => prepareAgySessionRunHome(f.adapter, f.request, sandboxOptions, false, false))
      .toThrow(/--sandbox-block .* covers the launch's own harness state directory/);
    expect(readdirSync(probes)).toEqual([]);
  } finally {
    process.env.HOME = previousHome;
  }
});

test("agy session cleanup failures preserve abort handling and remain retryable", async () => {
  const f = setup();
  const previousCode = process.exitCode;
  const prepared = prepareAgySessionRunHome(f.adapter, f.request, {}, true, false);
  const clean = spyOn(f.adapter, "cleanupRun").mockImplementationOnce(() => { throw new Error("synthetic cleanup failure"); });
  const pending = spyOn(f.adapter, "cleanupRetryPending").mockReturnValue(true);
  const report = spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(prepared.cleanup()).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(report).toHaveBeenCalledWith(expect.stringContaining("synthetic cleanup failure"));
    clean.mockRestore();
    await prepared.cleanup();
  } finally {
    clean.mockRestore(); pending.mockRestore(); report.mockRestore();
    process.exitCode = previousCode ?? 0;
  }
});
