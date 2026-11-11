import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveTrustedCommand, trustCheckedCommandPaths } from "../src/executable-security.js";
import { spawnSessionChild, type ResolvedSessionLaunch } from "../src/session/spawn.js";
import { readClineSessionUsage } from "../src/session/cline-history.js";

test.each([false, true])("Cline history reuses the pinned launch, sandboxed=%s", async (sandboxed) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cline-launch-pin-")));
  const work = join(root, "work"), bin = join(root, "bin");
  mkdirSync(work); mkdirSync(bin);
  const cline = join(bin, "cline"), scode = join(bin, "scode");
  writeFileSync(cline, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(scode, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "scode 0.6.6"; exit 0; fi\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o700 });
  let launch: ResolvedSessionLaunch | undefined;
  try {
    const child = await spawnSessionChild(["env", "HOME=" + root, "env", "CLINE_SESSION_BACKEND_MODE=local", "cline", "--acp"],
      { PATH: `${bin}:/usr/bin:/bin`, HOME: root }, { cwd: work, sandboxed, autonomy: "high",
        onResolvedLaunch: (value) => { launch = value; } }, { onLine() {}, onFatal(error) { throw new Error(String(error)); } });
    await child.settled;
    expect(launch).toBeDefined();
    expect(launch!.command[launch!.programIndex]).toBe(cline);
    expect(launch!.executablePin.requiredPaths).toContain(cline);
    if (sandboxed) expect(launch!.command[0]).toBe(scode);
    // A project binary planted after the turn must never be looked up.
    writeFileSync(join(work, "cline"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    launch!.env.PATH = `${work}:${bin}:/usr/bin:/bin`;
    let calls = 0;
    let captured: { command: string[]; options: any } | undefined;
    const execute = async (command: string[], options: any) => {
      calls++;
      captured = { command, options };
      return { success: true, exitCode: 0, stdout: "[]", stderr: "" };
    };
    await readClineSessionUsage({ sessionId: "id", cwd: work, home: root, launch: launch!, execute });
    expect(calls).toBe(1);
    expect(captured!.command.slice(0, launch!.programIndex + 1)).toEqual(launch!.command.slice(0, launch!.programIndex + 1));
    expect(captured!.command.slice(launch!.programIndex + 1)).toEqual(["--config", `${root}/.cline`, "history", "--json", "--limit", "2000"]);
    expect(captured!.options.env).toBe(launch!.env);
    expect(captured!.options.checks).toBe(launch!.executablePin.checks);
    writeFileSync(cline, "#!/bin/sh\nexit 23\n"); chmodSync(cline, 0o700);
    expect(await readClineSessionUsage({ sessionId: "id", cwd: work, launch: launch!, execute })).toBeNull();
    expect(calls).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("nested env programs receive containment checks", () => {
  const root = mkdtempSync(join(tmpdir(), "nested-env-trust-"));
  const harness = join(root, "harness");
  writeFileSync(harness, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  try {
    expect(() => resolveTrustedCommand(["env", "A=b", "env", "C=d", harness], "test", root, "/usr/bin:/bin"))
      .toThrow("inside the execution working directory");
    const resolved = resolveTrustedCommand(["env", "A=b", "env", "C=d", "/bin/echo"], "test", root, "/usr/bin:/bin");
    expect(trustCheckedCommandPaths(resolved)).toEqual([resolved[0]!, resolved[2]!, resolved[4]!]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
