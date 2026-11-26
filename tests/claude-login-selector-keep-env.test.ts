// Review round 5 (security 2, contracts-2 1): CLAUDE_SECURESTORAGE_CONFIG_DIR
// counted as a credential, so every scrubbed macOS Claude launch required
// --keep-env and was refused on scode older than 0.6.0 with a message about
// provider keys. It selects a Keychain item and carries no secret.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { claudeSecureStorageEnv } from "../src/claude-login.js";
import { runSandboxedWithStdin } from "../src/cli-runtime.js";
import { buildSandboxEnv, isCredentialEnvName, withKeepEnvExemption } from "../src/sandbox.js";
import { prepareSessionEnvironment } from "../src/session/cli-environment.js";

const SELECTOR = "CLAUDE_SECURESTORAGE_CONFIG_DIR";
const injected = claudeSecureStorageEnv({ CLAUDE_CONFIG_DIR: "/profile" }, "darwin");

/** A scode of the given version whose --help documents --keep-env or not. */
async function withScode<T>(version: string, keepEnv: boolean,
  fn: (stub: { envPath: string; workdir: string; argv: () => string[] | null; childEnv: () => string }) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "codemux-selector-"));
  const bin = join(dir, "bin"), workdir = join(dir, "work"), argvFile = join(dir, "argv.txt"), envFile = join(dir, "env.txt");
  mkdirSync(bin); mkdirSync(workdir);
  const help = keepEnv ? "echo '  --keep-env NAME[,NAME...]  keep named variables under --scrub-env'" : "true";
  // macOS launches refuse scode older than 0.6.11 (the keychain-services floor),
  // so the fake reports that version there. What these tests vary is the
  // --keep-env line of --help, which is probed and not read from the version.
  const reported = process.platform === "darwin" ? "0.6.11" : version;
  writeFileSync(join(bin, "scode"), `#!/bin/sh\nif [ "$1" = --version ]; then echo 'scode ${reported}'; exit 0; fi\n` +
    `if [ "$1" = --help ]; then echo 'Usage: scode [options] command'; ${help}; exit 0; fi\n` +
    `printf '%s\\n' "$@" > '${argvFile}'\nprintf '%s' "\${${SELECTOR}-unset}" > '${envFile}'\n` +
    `while [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`);
  chmodSync(join(bin, "scode"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  try {
    return await fn({ envPath: `${bin}:${originalPath ?? ""}`, workdir,
      argv: () => existsSync(argvFile) ? readFileSync(argvFile, "utf8").split("\n") : null,
      childEnv: () => readFileSync(envFile, "utf8") });
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

const launch = (stub: { envPath: string; workdir: string }, trust: "standard" | "untrusted", scrubEnv: boolean) =>
  runSandboxedWithStdin([process.execPath, "-e", "process.stdout.write('ok')"], null, stub.workdir,
    { PATH: stub.envPath, ...injected }, "read-only",
    withKeepEnvExemption({ trust, scrubEnv, agentId: "claude" }, injected, false), 5_000);

describe("Claude's login selector under an environment scrub", () => {
  test("the selector is not a credential and never makes the exemption required", () => {
    expect(injected).toEqual({ [SELECTOR]: "/profile" });
    expect(isCredentialEnvName(SELECTOR)).toBe(false);
    expect(isCredentialEnvName("ANTHROPIC_AUTH_TOKEN")).toBe(true);
    const scrubbed = withKeepEnvExemption({ scrubEnv: true }, injected, false);
    expect(scrubbed.keepEnv).toEqual([SELECTOR]);
    expect(scrubbed.keepEnvRequired).toBe(false);
    // A real credential beside it still requires the exemption.
    expect(withKeepEnvExemption({ scrubEnv: true }, { ...injected, ANTHROPIC_AUTH_TOKEN: "synthetic" }, false).keepEnvRequired).toBe(true);
  });

  test("scode 0.5.x runs the scrubbed launch without --keep-env and without a refusal", async () => {
    await withScode("0.5.3", false, async (stub) => {
      const result = await launch(stub, "standard", true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("ok");
      expect(result.stderr).not.toContain("provider override");
      const argv = stub.argv()!;
      expect(argv).toContain("--scrub-env");
      expect(argv).not.toContain("--keep-env");
      // The selector is not credential-shaped, so the older scrub leaves it.
      expect(stub.childEnv()).toBe("/profile");
    });
  });

  test("scode 0.6.8 keeps passing the selector through --keep-env", async () => {
    await withScode("0.6.8", true, async (stub) => {
      const result = await launch(stub, "standard", true);
      expect(result.exitCode).toBe(0);
      const argv = stub.argv()!;
      expect(argv[argv.indexOf("--keep-env") + 1]).toBe(SELECTOR);
      expect(stub.childEnv()).toBe("/profile");
    });
  });

  test.each([["0.5.3", false], ["0.6.8", true]] as const)("untrusted trust on scode %s neither exempts nor injects the selector", async (version, keepEnv) => {
    const options = withKeepEnvExemption({ trust: "untrusted" }, injected, false);
    expect(options.keepEnv).toBeUndefined();
    expect(buildSandboxEnv({ ...injected, OTHER: "kept" }, options)).toEqual({ OTHER: "kept" });
    expect(buildSandboxEnv(injected, { trust: "standard" })).toEqual(injected);
    // Another injected name still rides the exemption; the selector does not.
    expect(withKeepEnvExemption({ trust: "untrusted" }, { ...injected, ANTHROPIC_BASE_URL: "https://example.invalid" }, false).keepEnv)
      .toEqual(["ANTHROPIC_BASE_URL"]);
    await withScode(version, keepEnv, async (stub) => {
      const result = await launch(stub, "untrusted", false);
      expect(result.exitCode).toBe(0);
      expect(stub.argv()!).not.toContain("--keep-env");
      expect(stub.childEnv()).toBe("unset");
    });
  });

  test("a scrubbed Claude session needs no keep-env preflight for the selector alone", () => {
    const adapter = new ClaudeAdapter({ HOME: "/synthetic-home" });
    adapter.getEnv = () => ({ ...injected });
    const prepared = prepareSessionEnvironment({ adapter, runLike: { agent: "claude", prompt: "synthetic" },
      passthroughEnv: [], sandboxed: true, sandboxOptions: { scrubEnv: true }, override: null });
    expect(prepared.needsKeepEnvPreflight).toBe(false);
    adapter.getEnv = () => ({ ...injected, ANTHROPIC_AUTH_TOKEN: "synthetic" });
    expect(prepareSessionEnvironment({ adapter, runLike: { agent: "claude", prompt: "synthetic" },
      passthroughEnv: [], sandboxed: true, sandboxOptions: { scrubEnv: true }, override: null }).needsKeepEnvPreflight).toBe(true);
  });
});
