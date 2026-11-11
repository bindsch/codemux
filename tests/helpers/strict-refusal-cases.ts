import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { buildScodeCommand, type SandboxOptions } from "../../src/sandbox.js";

/** Real builder failures, shared by CLI classification and every per-turn driver. */
export function strictRefusalCases(root: string) {
  const home = join(root, "home"), state = join(root, "state"), other = join(root, "other");
  mkdirSync(home); mkdirSync(state); mkdirSync(other);
  symlinkSync(other, join(state, "opencode"));
  const rootAlias = join(root, "root-alias");
  symlinkSync("/", rootAlias);
  const homeAlias = join(root, "home-alias");
  mkdirSync(homeAlias); symlinkSync(home, join(homeAlias, "opencode"));
  const build = (command = ["/opt/bin/opencode"], env = {}, options: SandboxOptions = {}) =>
    buildScodeCommand(command, root, "low", { agentId: "opencode", strict: true, ...options }, "scode", { HOME: home, ...env });
  return [
    { name: "malformed wrapper", message: "env prefix names no program", fail: () => build(["/usr/bin/env", "A=b"]) },
    { name: "nested malformed wrapper", message: "env prefix names no program", fail: () => build(["/usr/bin/env", "/usr/bin/env", "-i", "/bin/echo"]) },
    { name: "wrapped executable", message: "env-wrapped executable", fail: () => build(["/usr/bin/env", join(home, "harness")]) },
    { name: "nested wrapped executable", message: "env-wrapped executable", fail: () => build(["/usr/bin/env", "/usr/bin/env", join(home, "harness")]) },
    { name: "blocked system executable", message: "env-wrapped executable", fail: () => build(["/usr/bin/env", "/bin/echo"], {}, { blockPaths: ["/bin/echo"] }) },
    { name: "explicit executable grant", message: "writable executable grant", fail: () => build([join(home, "harness")], {}, { harnessStateDirs: [home] }) },
    { name: "OpenCode executable grant", message: "writable executable grant", fail: () => build([join(home, ".opencode/bin/opencode")]) },
    { name: "relative state", message: "absolute path", fail: () => build(undefined, { XDG_STATE_HOME: "relative" }) },
    { name: "state below a file", message: "ENOTDIR", fail: () => build(undefined, { XDG_STATE_HOME: "/dev/null" }) },
    { name: "cache below a file", message: "ENOTDIR", fail: () => build(undefined, { XDG_CACHE_HOME: "/dev/null" }) },
    { name: "HOME below a file", message: "ENOTDIR", fail: () => build(undefined, { HOME: "/dev/null/child" }) },
    { name: "empty HOME wrapper", message: "HOME requires an absolute path", fail: () => build(["/usr/bin/env", "HOME=", "/opt/bin/opencode"]) },
    { name: "root state", message: "filesystem root", fail: () => build(undefined, { XDG_STATE_HOME: "/" }) },
    { name: "root cache alias", message: "filesystem root", fail: () => build(undefined, { XDG_CACHE_HOME: rootAlias }) },
    { name: "HOME grant", message: "HOME or its ancestors", fail: () => build(undefined, { HOME: join(root, "opencode"), XDG_STATE_HOME: root }) },
    { name: "HOME alias grant", message: "HOME or its ancestors", fail: () => build(undefined, { XDG_STATE_HOME: homeAlias }) },
    { name: "redirected state", message: "redirected by a symlink", fail: () => build(undefined, { XDG_STATE_HOME: state }) },
    { name: "state ancestor block", message: "covers the launch's own harness state", fail: () => build(undefined, {}, { blockPaths: [join(home, ".cache")] }) },
    { name: "state descendant block", message: "sits inside the launch's own harness state", fail: () => build(undefined, {}, { blockPaths: [join(home, ".cache/opencode/child")] }) },
  ];
}

export function captureStrictRefusal(fail: () => unknown): Error {
  try { fail(); } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("builder unexpectedly accepted a strict refusal case");
}
