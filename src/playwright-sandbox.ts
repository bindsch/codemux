/**
 * What the Playwright MCP server needs from the sandbox on the Claude
 * family (claude, zai): a per-launch socket directory, and the directory
 * Playwright installs its browsers into.
 *
 * Verified on a sandboxed headless zai run (scode 0.6.8): the server's
 * default socket directory is too long for a Unix socket ("Socket
 * directory path is too long"), and without the browser install directory
 * the browser launch fails with EPERM. The server arguments that go with
 * these grants are built in src/mcp.ts (playwrightServerArgs).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { SandboxOptions } from "./sandbox.js";
import { scodeDefaultBlockedPaths } from "./launch/scode-default-blocks.js";
import { containsPath } from "./sandbox-command.js";
import { canonicalSandboxBlockPath } from "./session/registry/format.js";
import type { AgentId, RunRequest } from "./types.js";
import { UsageRefusalError } from "./validation.js";

/** The server's registry directory inside the socket directory. Playwright
 * writes one descriptor file per browser there at launch; its default is
 * `ms-playwright/b` in the platform cache directory (the default browser
 * install directory, whatever PLAYWRIGHT_BROWSERS_PATH says), which the
 * sandbox does not let it write. */
export const PLAYWRIGHT_REGISTRY_NAME = "r";
export const playwrightRegistryDir = (socketDir: string): string => join(socketDir, PLAYWRIGHT_REGISTRY_NAME);

/** The longest socket directory codemux hands the server, in bytes.
 * Playwright puts `<directory>/<domain>/<name>.sock` in a `sun_path` of at
 * most 103 bytes; its longest domain and its 16-character fallback name
 * need 32 of them, and the rest is margin. */
export const PLAYWRIGHT_SOCKET_DIR_MAX_BYTES = 64;

const SOCKET_DIR_PREFIX = "cmx-pw-";

/** The agents whose launches carry the socket directory and the grants. */
export function usesPlaywrightSandboxDirs(agent: AgentId): boolean {
  return agent === "claude" || agent === "zai";
}

/** One launch's socket directory. `path` is fixed at reservation, so a
 * command or a printed preview can name it; nothing exists on disk until
 * `create`, and `finalize` removes only what `create` made. */
export interface PlaywrightSocketDir {
  readonly path: string;
  /** Makes the directory, mode 0700. Refuses a path that already exists. */
  create(): void;
  /** Removes the directory this launch created. Safe to call repeatedly. */
  finalize(): void;
}

/** `/tmp` where it is the short system temporary directory; elsewhere the
 * platform's own, which the length check then judges. */
function socketRoot(platform: NodeJS.Platform): string {
  return platform === "darwin" || platform === "linux" ? "/tmp" : tmpdir();
}

/** Names a private socket directory without creating it. */
export function reservePlaywrightSocketDir(
  root: string = socketRoot(process.platform)
): PlaywrightSocketDir {
  const path = join(root, `${SOCKET_DIR_PREFIX}${randomBytes(4).toString("hex")}`);
  const bytes = Buffer.byteLength(path);
  if (!isAbsolute(path) || bytes > PLAYWRIGHT_SOCKET_DIR_MAX_BYTES) {
    throw new UsageRefusalError(
      `--enable-playwright-mcp needs a short socket directory, and ${path} is ${bytes} bytes ` +
        `(limit ${PLAYWRIGHT_SOCKET_DIR_MAX_BYTES}): a Unix socket path cannot hold it`
    );
  }
  let identity: { dev: number; ino: number } | null = null;
  const remove = (): void => {
    if (identity === null) return;
    const created = identity;
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      identity = null;
      return;
    }
    // Only the directory this launch made: a path that now names something
    // else is left alone and reported.
    if (!stat.isDirectory() || stat.dev !== created.dev || stat.ino !== created.ino) {
      identity = null;
      throw new Error(`the Playwright socket directory ${path} was replaced; it was not removed`);
    }
    rmSync(path, { recursive: true, force: true });
    identity = null;
  };
  // The backstop for exits no cleanup path reaches. An exit hook must not
  // throw: that would replace the exit code and skip later hooks.
  const onExit = (): void => {
    try { remove(); }
    catch (error) {
      console.error(`codemux: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return {
    path,
    create(): void {
      if (identity !== null) return;
      // Not recursive: an existing path (a planted link included) fails.
      mkdirSync(path, { mode: 0o700 });
      // Recorded at once: a later step that fails must not strand the directory.
      const stat = lstatSync(path);
      identity = { dev: stat.dev, ino: stat.ino };
      process.once("exit", onExit);
      chmodSync(path, 0o700);
      mkdirSync(playwrightRegistryDir(path), { mode: 0o700 });
    },
    finalize(): void {
      process.off("exit", onExit);
      remove();
    },
  };
}

/** Cleanup for the TUI's and the session's `finally`, which run after the
 * exit code is set and have more to do: a directory that was replaced is
 * reported and costs exit 1, and nothing is thrown. A run's cleanup throws
 * instead (the adapters' cleanupRun), and the launcher reports it the way
 * it reports every other cleanup failure. */
export function finalizePlaywrightSocketDir(dir: { finalize(): void } | null | undefined): void {
  try { dir?.finalize(); }
  catch (error) {
    console.error(`codemux: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = Math.max(Number(process.exitCode ?? 0), 1);
  }
}

/** The reservation step shared by the run, TUI and session paths: names
 * the directory and records it on the launch's sandbox options, so the
 * scode argv grants it. Creation stays with the caller. */
export function attachPlaywrightSocketDir(sandbox: SandboxOptions | undefined): PlaywrightSocketDir {
  const dir = reservePlaywrightSocketDir();
  if (sandbox !== undefined) sandbox.playwrightSocketDir = dir.path;
  return dir;
}

/** prepareRun's step: a sandboxed run that asked for the browser gets its
 * socket directory, created unless the launch only prints. */
export function preparePlaywrightSocketDir(
  request: RunRequest,
  sandbox: SandboxOptions | undefined,
  printOnly: boolean | undefined
): PlaywrightSocketDir | null {
  if (!request.sandboxed || !request.enablePlaywrightMcp) return null;
  const dir = attachPlaywrightSocketDir(sandbox);
  if (!printOnly) dir.create();
  return dir;
}

/** The directory Playwright keeps its browsers in, for the child's
 * environment: `PLAYWRIGHT_BROWSERS_PATH` when it is an absolute path,
 * else the platform default. Null when that directory does not exist. */
export function playwrightBrowsersDir(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): string | null {
  const configured = environment.PLAYWRIGHT_BROWSERS_PATH;
  const home = environment.HOME || homedir();
  const cache = environment.XDG_CACHE_HOME;
  const refuse = (what: string, why: string): never => {
    throw new UsageRefusalError(`${what}, which ${why}; --enable-playwright-mcp under the sandbox grants the browser ` +
      "install directory read-only, so it must be a plain absolute directory outside scode's blocked paths");
  };
  const standard = platform === "darwin" ? join(home, "Library/Caches/ms-playwright") : join(home, ".cache/ms-playwright");
  const set = (value: string | undefined): value is string => value !== undefined && value !== "";
  // Playwright resolves a relative value (PLAYWRIGHT_BROWSERS_PATH's special
  // `0` included) against its own package or working directory, which
  // codemux cannot name: granting a default instead would leave the real
  // directory closed.
  if (set(configured) && !isAbsolute(configured)) {
    refuse(`PLAYWRIGHT_BROWSERS_PATH is ${JSON.stringify(configured)}`, "is not an absolute path");
  }
  if (platform === "linux" && !set(configured) && set(cache) && !isAbsolute(cache)) {
    refuse(`XDG_CACHE_HOME is ${JSON.stringify(cache)}`, "is not an absolute path");
  }
  const [dir, source] = set(configured) ? [configured, "PLAYWRIGHT_BROWSERS_PATH"]
    : platform === "darwin" ? [standard, "the default location"]
    : platform === "linux" ? (set(cache) ? [join(cache, "ms-playwright"), "XDG_CACHE_HOME"] : [standard, "the default location"])
      : [null, ""];
  if (dir === null || dir.includes("\0") || !existsSync(dir)) return null;
  // Every source is judged by where it really points: a link at the
  // standard location is no safer than a variable (review of 2.0.5).
  const real = realpathSync(dir);
  const realHome = existsSync(home) ? realpathSync(home) : home;
  const what = `the Playwright browser install directory ${dir} (${source})${real === dir ? "" : ` resolves to ${real}`}`;
  // A browser install directory is never the home directory or above it.
  if (containsPath(real, realHome)) refuse(what, "contains the home directory");
  // scode re-allows a grant beneath one of its default blocks (~/.ssh,
  // ~/Library, ...): only the real standard cache location may sit in one.
  const realStandard = join(realHome, platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  if (real !== realStandard) {
    for (const blocked of scodeDefaultBlockedPaths(realHome)) {
      if (containsPath(blocked, real) || containsPath(real, blocked)) {
        refuse(what, `overlaps scode's default-blocked path ${blocked}`);
      }
    }
  }
  return dir;
}

/** The scode grants of a launch that attaches the server, as flag and
 * path pairs: the socket directory read-write, and the browser install
 * directory when it exists. A caller's `--sandbox-block` that overlaps
 * either one is refused: scode cannot honor a block and an allow of the
 * same tree (the rule of assertNoCallerBlockOverStateDirs). */
export function playwrightSandboxGrants(
  socketDir: string,
  environment: NodeJS.ProcessEnv,
  callerBlockPaths: readonly string[],
  supportsAllowRo: boolean,
  platform: NodeJS.Platform = process.platform,
  launcherBlocks: readonly string[] = []
): Array<{ flag: "--allow" | "--allow-ro"; path: string }> {
  if (!isAbsolute(socketDir) || socketDir.includes("\0")) {
    throw new Error("the Playwright socket directory must be an absolute non-NUL path");
  }
  const browsers = playwrightBrowsersDir(environment, platform);
  // The directory holds the browser executables the operator's own
  // Playwright runs outside any sandbox: it is never granted writable.
  if (browsers !== null && !supportsAllowRo) {
    throw new UsageRefusalError("--enable-playwright-mcp under the sandbox requires scode 0.6.7 or newer: " +
      `the browser install directory ${browsers} is granted read-only, which an older scode cannot do`);
  }
  const grants: Array<{ flag: "--allow" | "--allow-ro"; path: string; role: string }> = [
    { flag: "--allow", path: socketDir, role: "socket directory" },
    ...(browsers === null ? [] : [{
      flag: "--allow-ro" as const, path: browsers, role: "browser install directory",
    }]),
  ];
  for (const blocked of callerBlockPaths) {
    const canonicalBlocked = canonicalSandboxBlockPath(blocked);
    for (const grant of grants) {
      const canonical = canonicalSandboxBlockPath(grant.path);
      if (containsPath(canonicalBlocked, canonical) || containsPath(canonical, canonicalBlocked)) {
        throw new UsageRefusalError(
          `--sandbox-block ${blocked} overlaps the Playwright ${grant.role} ${grant.path}, ` +
            "which --enable-playwright-mcp must allow; scode cannot honor both. " +
            "Remove or narrow the block, or drop --enable-playwright-mcp."
        );
      }
    }
  }
  // What this launch blocks itself (other harness homes, the account home,
  // a project-settings run's real config root) is never reopened by the
  // browser grant. The caller's own blocks were refused above, by name.
  for (const blocked of browsers === null ? [] : launcherBlocks.map(canonicalSandboxBlockPath)) {
    const canonical = canonicalSandboxBlockPath(browsers!);
    if (containsPath(blocked, canonical) || containsPath(canonical, blocked)) {
      throw new UsageRefusalError(`the Playwright browser install directory ${browsers} overlaps ${blocked}, ` +
        "which this launch blocks; --enable-playwright-mcp does not grant it");
    }
  }
  return grants.map(({ flag, path }) => ({ flag, path }));
}
