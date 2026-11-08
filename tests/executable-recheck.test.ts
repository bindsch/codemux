/**
 * The stat-then-spawn seam (audit gap 3): every trust check records the
 * binary's dev/ino/mode/size/mtimeNs/ctimeNs, and each spawn site re-stats
 * what it is about to exec, refusing a binary that changed in between —
 * including an in-place rewrite, which keeps the inode and the mode.
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertExecutablesUnchanged, executableCheck, resolveTrustedCommand, resolveTrustedExecutable, trustCheckedCommandChecks, trustCheckedCommandPaths } from "../src/executable-security.js";
import * as security from "../src/executable-security.js";
import { runCapturedCommand } from "../src/process-runner.js";
import { runSandboxedWithStdin } from "../src/cli-runtime.js";
import * as scodeModule from "../src/cli-runtime/scode.js";
import { spawnSessionChild } from "../src/session/spawn.js";
import { SessionProcess } from "../src/session/process.js";
import { buildPlaywrightSandboxMcp } from "../src/mcp.js";

describe("executable re-stat before spawn", () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const script = (dir: string, name: string): string => {
    const path = join(dir, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(path, 0o755);
    return path;
  };
  const replace = (path: string): void => {
    rmSync(path);
    writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(path, 0o755);
  };

  test("a refused resolution records no identity (round 14, edges 13)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-recheck-refused-"));
    scratch.push(dir);
    const path = script(dir, "inside");
    // The binary sits inside the forbidden root: the resolution is
    // refused, and no identity may survive it for a later spawn in this
    // process to re-check — and accept — against.
    expect(() => resolveTrustedExecutable(path, "test tool", dir)).toThrow(
      "must not be inside the execution working directory"
    );
    expect(() => assertExecutablesUnchanged([path], "command")).not.toThrow();
  });

  test("a replaced binary is refused and never spawned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-recheck-"));
    scratch.push(dir);
    const trusted = resolveTrustedExecutable(script(dir, "tool"), "test tool");
    replace(trusted);
    await expect(runCapturedCommand([trusted], { cwd: dir, env: {}, timeoutMs: 5000 }))
      .rejects.toThrow("command executable changed after its trust check");
  });

  test("an in-place rewrite keeps the inode and mode and is still refused", () => {
    // open + write, no rename: dev, ino, mode, and even the byte count
    // ("exit 0" -> "exit 1") all survive the rewrite, so only the
    // timestamp fields of the recorded identity catch it.
    const dir = mkdtempSync(join(tmpdir(), "codemux-recheck-"));
    scratch.push(dir);
    const path = resolveTrustedExecutable(script(dir, "inplace"), "test tool");
    const fd = openSync(path, "r+");
    try {
      writeSync(fd, Buffer.from("#!/bin/sh\nexit 1\n"), 0);
    } finally {
      closeSync(fd);
    }
    expect(() => assertExecutablesUnchanged([path], "test tool"))
      .toThrow("test tool executable changed after its trust check");
  });

  test("an in-place rewrite that also grows the file is still refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-recheck-"));
    scratch.push(dir);
    const path = resolveTrustedExecutable(script(dir, "grown"), "test tool");
    const fd = openSync(path, "r+");
    try {
      const grown = Buffer.from("#!/bin/sh\nexit 1 # longer now\n");
      ftruncateSync(fd, 0);
      writeSync(fd, grown, 0);
    } finally {
      closeSync(fd);
    }
    expect(() => assertExecutablesUnchanged([path], "test tool"))
      .toThrow("test tool executable changed after its trust check");
  });

  test("a utimes back-dating that touches no content still fails on ctime", () => {
    // utimes can restore mtime, so a rewrite could hide behind it; ctime
    // cannot be set from user space and always moves.
    const dir = mkdtempSync(join(tmpdir(), "codemux-recheck-"));
    scratch.push(dir);
    const path = resolveTrustedExecutable(script(dir, "backdated"), "test tool");
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(path, past, past);
    expect(() => assertExecutablesUnchanged([path], "test tool"))
      .toThrow("test tool executable changed after its trust check");
  });

  test("a mode change alone is refused; a restored mode still refuses on ctime; unchecked paths are ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-recheck-"));
    scratch.push(dir);
    const widened = resolveTrustedExecutable(script(dir, "widened"), "test tool");
    chmodSync(widened, 0o777);
    expect(() => assertExecutablesUnchanged([widened], "test tool"))
      .toThrow("test tool executable changed after its trust check");
    // chmod moved ctime, and restoring the mode cannot set it back, so the
    // binary stays refused until a fresh trust check re-records it.
    chmodSync(widened, 0o755);
    expect(() => assertExecutablesUnchanged([widened], "test tool"))
      .toThrow("test tool executable changed after its trust check");
    expect(resolveTrustedExecutable(widened, "test tool")).toBe(widened);
    expect(() => assertExecutablesUnchanged([widened], "test tool")).not.toThrow();
    expect(() => assertExecutablesUnchanged([join(dir, "never-checked")], "test tool")).not.toThrow();
  });

  test("re-running the trust check refreshes the recorded identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-recheck-"));
    scratch.push(dir);
    const path = resolveTrustedExecutable(script(dir, "refreshed"), "test tool");
    replace(path);
    expect(() => assertExecutablesUnchanged([path], "test tool")).toThrow();
    expect(resolveTrustedExecutable(path, "test tool")).toBe(path);
    expect(() => assertExecutablesUnchanged([path], "test tool")).not.toThrow();
  });

  test("two launches keep two identities for one path; each verifies, an unknown third is refused (round 11, edges 2)", () => {
    // The record is a list per path, never one entry: a second trust
    // check of a replaced binary must not overwrite the first's expected
    // identity. A past version's identity cannot be brought back through
    // the filesystem (rename bumps ctime on this platform, and ctime is
    // the one timestamp nothing in user space can restore), so each
    // recorded stat is replayed through the re-check's own stat call.
    // This is the LIST FALLBACK the spawn sites keep for a command whose
    // resolution lives in another module; a site holding its own check
    // pins the re-stat to that check alone (the test below).
    const dir = mkdtempSync(join(tmpdir(), "codemux-recheck-two-"));
    scratch.push(dir);
    const path = script(dir, "two-versions");
    const v1 = statSync(path, { bigint: true });
    resolveTrustedExecutable(path, "test tool");
    replace(path);
    const v2 = statSync(path, { bigint: true });
    resolveTrustedExecutable(path, "test tool");
    const replay = (stat: ReturnType<typeof statSync>) => {
      const spy = spyOn(fs, "statSync").mockImplementation((() => stat) as typeof statSync);
      try {
        assertExecutablesUnchanged([path], "test tool");
      } finally {
        spy.mockRestore();
      }
    };
    // The first launch's identity still verifies after the second check
    // recorded a different one — a single record per path would have
    // dropped it.
    expect(() => replay(v1)).not.toThrow();
    // The second launch's identity verifies too.
    expect(() => replay(v2)).not.toThrow();
    // A stat no launch ever saw is still refused.
    const unknown = { ...v2, ino: v2.ino + 1n };
    expect(() => replay(unknown as typeof v2)).toThrow(
      "test tool executable changed after its trust check"
    );
  });

  test("a launch re-checks only its own identity, never the other launch's (round 13, edges 2)", () => {
    // A process that trust-checked two versions of one path holds two
    // recorded identities for it. A re-stat that accepts EITHER lets a
    // launch execute bytes only the other launch checked, so a spawn
    // site passes its own resolution's check and a stat matching the
    // OTHER launch's identity is refused for this one.
    const dir = mkdtempSync(join(tmpdir(), "codemux-recheck-own-"));
    scratch.push(dir);
    const path = script(dir, "own-resolution");
    resolveTrustedExecutable(path, "test tool");
    const first = executableCheck(path);
    expect(first).not.toBeNull();
    replace(path);
    resolveTrustedExecutable(path, "test tool");
    const second = executableCheck(path);
    expect(second).not.toBeNull();
    // Two launches, two different identities for one path.
    expect(first!.identity).not.toEqual(second!.identity);
    const replay = (stat: ReturnType<typeof statSync>, check: ReturnType<typeof executableCheck>) => {
      const spy = spyOn(fs, "statSync").mockImplementation((() => stat) as typeof statSync);
      try {
        assertExecutablesUnchanged([path], "test tool", [path], check === null ? undefined : [check]);
      } finally {
        spy.mockRestore();
      }
    };
    const v2 = statSync(path, { bigint: true });
    // The second launch's own identity verifies for the second launch...
    expect(() => replay(v2, second)).not.toThrow();
    // ...but the FIRST launch's re-stat of the same disk state — now
    // matching only the second launch's identity — is refused: those
    // are bytes the first launch never trust-checked.
    expect(() => replay(v2, first)).toThrow(
      "test tool executable changed after its trust check"
    );
  });

  test("the sandbox runner pins its scode position, not just the wrapped command (round 19, edges 2)", () => {
    // scodeCmd[0] is the launch's own resolveScodeExecutableForEnv result.
    // A second launch in this process may re-record a replaced scode while
    // the first sits between its probe and its spawn; unless the first's
    // own identity is pinned as its check, its re-stat falls back to the
    // process-wide list — which now holds the replacement too — and the
    // first launch execs bytes it never probed. This test replays the
    // exact argument shape src/cli-runtime.ts passes.
    const dir = mkdtempSync(join(tmpdir(), "codemux-recheck-scode-"));
    scratch.push(dir);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    script(bin, "wrapped");
    const scodePath = resolveTrustedExecutable(script(bin, "scode"), "scode");
    const first = executableCheck(scodePath);
    expect(first).not.toBeNull();
    // Another launch resolves the replaced scode: the process-wide list now
    // holds both identities, and the disk matches only the second's.
    replace(scodePath);
    resolveTrustedExecutable(scodePath, "scode");
    const wrapped = resolveTrustedCommand(["wrapped"], "sandbox command", undefined, bin);
    const scodeCmd = [scodePath, "--trust", "standard", "--", ...wrapped];
    const wrappedChecks = trustCheckedCommandChecks(wrapped);
    // The pinned spelling refuses: this launch probed the first identity,
    // and the disk no longer matches it.
    expect(() =>
      assertExecutablesUnchanged(scodeCmd, "sandbox command", [...trustCheckedCommandPaths(wrapped), scodePath], [
        ...wrappedChecks,
        first!,
      ])
    ).toThrow("sandbox command executable changed after its trust check");
    // The pre-fix spelling — the wrapped command pinned, scode left to the
    // process-wide list — accepted the replacement, which is exactly the
    // gap the pin closes.
    expect(() =>
      assertExecutablesUnchanged(scodeCmd, "sandbox command", [...trustCheckedCommandPaths(wrapped), scodePath], wrappedChecks)
    ).not.toThrow();
  });

  test("the captured run pins its command's own identity, not the process-wide list (round 23, edges 1)", async () => {
    // The plain run path (launch.ts runDirect) and the sandboxed-with-stdin
    // path hand runCapturedCommand the launch's own requiredPaths and
    // checks. Without them the runner's pre-spawn re-stat falls back to the
    // process-wide identity list — which another launch's trust check of a
    // replaced binary widened — so this launch would exec bytes it never
    // checked. The same shape the sandbox runner's pin (above) closes.
    const dir = mkdtempSync(join(tmpdir(), "codemux-recheck-plain-"));
    scratch.push(dir);
    const path = resolveTrustedExecutable(script(dir, "plain-tool"), "test tool");
    const own = executableCheck(path);
    expect(own).not.toBeNull();
    // Another launch resolves the replaced binary: the process-wide list
    // now holds both identities, and the disk matches only the second's.
    replace(path);
    resolveTrustedExecutable(path, "test tool");
    // The pinned spelling refuses: this launch checked the first identity,
    // and the disk no longer matches it.
    await expect(
      runCapturedCommand([path], {
        cwd: dir,
        env: {},
        timeoutMs: 5_000,
        requiredPaths: [path],
        checks: [own!],
      })
    ).rejects.toThrow("command executable changed after its trust check");
    // The pre-fix spelling — no pin, the process-wide list — accepted the
    // replacement, which is exactly the gap the pin closes.
    await expect(
      runCapturedCommand([path], { cwd: dir, env: {}, timeoutMs: 5_000 })
    ).resolves.toBeTruthy();
  });

  test("a session spawn pins its own identities like the run path (round 20, minor 6)", async () => {
    // The session's pre-spawn re-stat once passed no checks and no
    // requiredPaths, so it fell back to the process-wide identity list —
    // another launch's record for the same path could satisfy it. The
    // session spawn now builds the same pin the run path applies.
    const dirA = mkdtempSync(join(tmpdir(), "codemux-recheck-session-a-"));
    const bin = mkdtempSync(join(tmpdir(), "codemux-recheck-session-b-"));
    scratch.push(dirA, bin);
    const wrapped = script(bin, "wrapped");
    // The wiring: spawnSessionChild hands its own resolution to the
    // re-stat as required paths and checks, not just the command.
    const recheck = spyOn(security, "assertExecutablesUnchanged");
    try {
      const proc = await spawnSessionChild(
        ["wrapped"],
        { PATH: bin },
        { cwd: dirA, sandboxed: false, autonomy: "high", graceMs: 50 },
        { onLine: () => {}, onFatal: () => {} }
      );
      expect(recheck).toHaveBeenCalledTimes(1);
      const [paths, label, requiredPaths, checks] = recheck.mock.calls[0]!;
      expect(label).toBe("session command");
      expect(paths[0]).toBe(requiredPaths?.[0]);
      expect(checks).toHaveLength(1);
      expect(checks![0]!.path).toBe(paths[0]!);
      await proc.settled;
    } finally {
      recheck.mockRestore();
    }
    // The behavior: the pin compares THIS spawn's identity alone. Another
    // launch re-records the replaced binary; the disk now matches only
    // its identity, so the pinned session spawn refuses.
    const first = executableCheck(wrapped);
    expect(first).not.toBeNull();
    replace(wrapped);
    resolveTrustedExecutable(wrapped, "wrapped");
    expect(() =>
      new SessionProcess({
        command: [wrapped],
        cwd: dirA,
        env: { PATH: bin },
        onLine: () => {},
        onFatal: () => {},
        graceMs: 50,
        executableChecks: { requiredPaths: [wrapped], checks: [first!] },
      })
    ).toThrow("session command executable changed after its trust check");
  });

  test("the run path carries its scode check from its own resolution, across the probes (round 20, minor 7)", async () => {
    // Another launch may re-record a replaced scode while this launch
    // sits in its async probes. A capture at the spawn site read that
    // other launch's identity, and the re-stat passed — this launch then
    // execed bytes it never probed. The check is captured in the
    // resolution's own synchronous block and carried to the spawn.
    const dirA = mkdtempSync(join(tmpdir(), "codemux-recheck-carry-a-"));
    const bin = mkdtempSync(join(tmpdir(), "codemux-recheck-carry-b-"));
    scratch.push(dirA, bin);
    script(bin, "wrapped");
    const scodePath = script(bin, "scode");
    // The other launch's probe, riding this launch's compatibility check.
    const probe = spyOn(scodeModule, "assertCompatibleScode").mockImplementation(async () => {
      replace(scodePath);
      resolveTrustedExecutable(scodePath, "scode");
    });
    try {
      await expect(
        runSandboxedWithStdin(["wrapped"], "", dirA, { PATH: bin }, "high", undefined, 5_000)
      ).rejects.toThrow("sandbox command executable changed after its trust check");
    } finally {
      probe.mockRestore();
    }
  });

  test("a Playwright binary swapped after the --mcp-config build refuses the sandboxed launch (review round 110)", async () => {
    // The binary's path sits inside one JSON argument, so the command
    // re-check never sees it; the launch carries the argument build's own
    // check to the runner, and the pre-spawn re-stat refuses a binary
    // replaced or widened in between. Unchanged, the launch proceeds.
    const dirA = mkdtempSync(join(tmpdir(), "codemux-recheck-mcp-a-"));
    const bin = mkdtempSync(join(tmpdir(), "codemux-recheck-mcp-b-"));
    scratch.push(dirA, bin);
    script(bin, "wrapped");
    script(bin, "scode");
    const probe = spyOn(scodeModule, "assertCompatibleScode").mockImplementation(async () => {});
    const launch = (plan: ReturnType<typeof buildPlaywrightSandboxMcp>) =>
      runSandboxedWithStdin(["wrapped", ...plan.args], "", dirA, { PATH: bin }, "high", undefined, 5_000,
        undefined, undefined, undefined, false, plan.check);
    try {
      // Replaced (a different inode) between the argument build and the
      // recheck: refused.
      const playwrightPath = script(bin, "playwright-mcp");
      const replaced = buildPlaywrightSandboxMcp(true, { enabled: true, binaryPath: playwrightPath, pathEnv: process.env.PATH ?? "" });
      expect(replaced.args[0]).toBe("--mcp-config");
      expect(replaced.check).not.toBeNull();
      replace(playwrightPath);
      await expect(launch(replaced)).rejects.toThrow(
        "sandbox command executable changed after its trust check"
      );
      // Made group-writable in between: refused the same way.
      rmSync(playwrightPath);
      const fresh = script(bin, "playwright-mcp");
      const widened = buildPlaywrightSandboxMcp(true, { enabled: true, binaryPath: fresh, pathEnv: process.env.PATH ?? "" });
      chmodSync(fresh, 0o664);
      await expect(launch(widened)).rejects.toThrow(
        "sandbox command executable changed after its trust check"
      );
      // Unchanged: the launch runs (the fake scode exits 0).
      chmodSync(fresh, 0o755);
      const unchanged = buildPlaywrightSandboxMcp(true, { enabled: true, binaryPath: fresh, pathEnv: process.env.PATH ?? "" });
      await expect(launch(unchanged)).resolves.toBeTruthy();
    } finally {
      probe.mockRestore();
    }
  });
});

// The env-symlink seam (review round 2, edges 2): resolveTrustedCommand
// keeps the as-found spelling of an `env` prefix (argv[0] for multi-call
// binaries), which on macOS is a symlink (/usr/bin/env may be reached as
// bin/env). Recording only the realpath left the re-check lookup empty —
// and the check silently SKIPPED — so repointing that symlink at another
// binary between the trust check and the spawn went unnoticed.
describe("an env prefix reached through a symlink", () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const setup = (): { resolved: string[]; bin: string; envLink: string } => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-envlink-"));
    scratch.push(dir);
    const bin = join(dir, "bin");
    writeFileSync(join(dir, "tool"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    mkdirSync(bin);
    symlinkSync("/usr/bin/env", join(bin, "env"));
    symlinkSync(join(dir, "tool"), join(bin, "tool"));
    const resolved = resolveTrustedCommand(
      ["env", "HOME=/tmp", "tool"],
      "sandbox command",
      undefined,
      bin
    );
    return { resolved, bin, envLink: join(bin, "env") };
  };

  test("the unresolved symlink spelling is re-checked and matches while unrepointed", () => {
    const { resolved } = setup();
    expect(resolved[0]).toContain("/bin/env");
    expect(() =>
      assertExecutablesUnchanged(resolved, "sandbox command", trustCheckedCommandPaths(resolved))
    ).not.toThrow();
  });

  test("repointing the env symlink at another binary is refused", () => {
    const { resolved, bin, envLink } = setup();
    const replacement = join(bin, "other");
    writeFileSync(replacement, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    rmSync(envLink);
    symlinkSync(replacement, envLink);
    // Caught by the recorded identity alone (the symlink spelling is now
    // recorded too) and by the required-paths belt: neither may skip.
    expect(() => assertExecutablesUnchanged(resolved, "sandbox command")).toThrow(
      "sandbox command executable changed after its trust check"
    );
    expect(() =>
      assertExecutablesUnchanged(resolved, "sandbox command", trustCheckedCommandPaths(resolved))
    ).toThrow("sandbox command executable changed after its trust check");
  });

  test("a required path with no recorded identity is refused, not skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-envlink-"));
    scratch.push(dir);
    const neverChecked = join(dir, "never-trust-checked");
    writeFileSync(neverChecked, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(() =>
      assertExecutablesUnchanged([neverChecked], "sandbox command", [neverChecked])
    ).toThrow(
      "sandbox command executable was trust-checked but has no recorded identity to re-check"
    );
  });

  test("trustCheckedCommandPaths names the executable and the env-launched program", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-envlink-"));
    scratch.push(dir);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "plain"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    symlinkSync("/usr/bin/env", join(bin, "env"));
    const plain = resolveTrustedCommand(["plain"], "sandbox command", undefined, bin);
    expect(trustCheckedCommandPaths(plain)).toEqual([plain[0]!]);
    const withEnv = resolveTrustedCommand(
      ["env", "-u", "HISTORY", "HOME=/tmp", "plain"],
      "sandbox command",
      undefined,
      bin
    );
    expect(trustCheckedCommandPaths(withEnv)).toEqual([withEnv[0]!, withEnv[4]!]);
    expect(() => trustCheckedCommandPaths(["env", "-u"])).toThrow(
      "sandbox command env prefix unsets an invalid variable name"
    );
  });
});
