/**
 * The scode contract script (scripts/check-scode-version.ts): the skip
 * valve CI greps for and the fail-closed rule around it. The script is
 * what CI runs, so each case spawns it exactly as the gate does, against
 * a fake scode from createFakeBinaryEnv — never the operator's.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeBinaryEnv, minimalPath } from "./helpers/cli.js";

async function runScript(
  path: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "scripts/check-scode-version.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, PATH: path },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("the scode contract script", () => {
  test("no scode installed skips with the CI-grepped line", async () => {
    const result = await runScript(minimalPath());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("scode contract SKIPPED on this runner");
  });

  test("a sandbox that cannot create its namespace skips too (round 11, edges 9)", async () => {
    // The documented valve: a bubblewrap scode whose kernel refuses user
    // namespaces still answers --version, so only the sandboxed probe
    // detects it — the skip line, not a failure. The phrases are bwrap's
    // own, matched at line start (round 12, contracts 2).
    const phrases = [
      "bwrap: Creating new namespace failed: Operation not permitted",
      "bwrap: Creating new namespace failed, likely because the kernel does not support user namespaces.",
      "bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.",
      "bwrap: No permissions to creating new namespace, likely because the kernel does not allow non-privileged user namespaces.",
      "bwrap: setting up uid map: Permission denied",
      "bwrap: setting up gid map: Permission denied",
    ];
    for (const phrase of phrases) {
      const fake = createFakeBinaryEnv({
        scode: `if [ "$1" = "--" ]; then printf '${phrase}\\n' >&2; exit 1; fi`,
      });
      try {
        const result = await runScript(fake.env.PATH!);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("scode contract SKIPPED on this runner");
      } finally {
        fake.cleanup();
      }
    }
  });

  test("a failure that merely mentions a namespace fails the gate (round 12, contracts 2)", async () => {
    // The old matcher skipped on any output containing "namespace",
    // "bwrap", or "clone()", so a real scode defect whose message used one
    // of those words greened the Linux gate. Only bwrap's own
    // user-namespace failure lines at line start skip.
    const phrases = [
      "scode: mount namespace error: could not remount /proc",
      "bwrap failed to launch: mount namespace error",
      "clone() returned EINVAL in the scode preloader",
      "unshare: unprivileged user namespaces are disabled",
    ];
    for (const phrase of phrases) {
      const fake = createFakeBinaryEnv({
        scode: `if [ "$1" = "--" ]; then printf '${phrase}\\n' >&2; exit 1; fi`,
      });
      try {
        const result = await runScript(fake.env.PATH!);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("could not run one sandboxed command (/bin/sh -c 'exit 0')");
        expect(result.stderr).toContain(phrase);
        expect(result.stdout).not.toContain("SKIPPED");
      } finally {
        fake.cleanup();
      }
    }
  });

  test("a sandboxed probe failing for any other reason fails closed", async () => {
    const fake = createFakeBinaryEnv({
      scode: `if [ "$1" = "--" ]; then printf 'scode: bad runtime config\\n' >&2; exit 1; fi`,
    });
    try {
      const result = await runScript(fake.env.PATH!);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("could not run one sandboxed command (/bin/sh -c 'exit 0')");
      expect(result.stderr).toContain("bad runtime config");
      expect(result.stdout).not.toContain("SKIPPED");
    } finally {
      fake.cleanup();
    }
  });

  test("a scode too old for the contract fails closed", async () => {
    const fake = createFakeBinaryEnv({ scode: "exit 1" }, "0.1.0");
    try {
      const result = await runScript(fake.env.PATH!);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("is too old");
    } finally {
      fake.cleanup();
    }
  });

  test("the contract probe drops ambient SCODE_* variables from the spawn environment (review round 162)", async () => {
    // The fake (whose --version preamble the helper prepends) records
    // which SCODE_* names reach the sandboxed probe and fails when it
    // sees either accounting name: the script passes the ambient
    // environment minus SCODE_*, so an ambient SCODE_ACCOUNT_FILE cannot
    // aim the probe's accounting at a path of its choosing. Names only,
    // never values (review round 165): the ambient environment holds
    // credentials no test should write to disk.
    const dir = mkdtempSync(join(tmpdir(), "codemux-scode-contract-"));
    const record = join(dir, "probe-env.txt");
    const fake = createFakeBinaryEnv({
      scode: `env | grep '^SCODE_\\|^PROBE_ENV_RECORD=' | cut -d= -f1 | sort > "\${PROBE_ENV_RECORD}"\n` +
        'if [ -n "${SCODE_ACCOUNT_FILE}" ] || [ -n "${SCODE_ACCOUNT_ID}" ]; then exit 3; fi\n' +
        "exit 0",
    });
    try {
      const proc = Bun.spawn([process.execPath, "scripts/check-scode-version.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          PATH: fake.env.PATH!,
          PROBE_ENV_RECORD: record,
          SCODE_ACCOUNT_FILE: "/ambient/account-file",
          SCODE_ACCOUNT_ID: "ambient-account-id",
          SCODE_ANY_OTHER_NAME: "ambient",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("scode sandbox contract passed");
      expect(stderr).toBe("");
      expect(readFileSync(record, "utf8")).toBe("PROBE_ENV_RECORD\n");
    } finally {
      fake.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
