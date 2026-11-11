import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "../src/adapters/index.js";
import { resolveTrustedCommand } from "../src/executable-security.js";
import { resolveSandboxOptionsForAgent } from "../src/sandbox-policy.js";
import { buildScodeCommand } from "../src/sandbox.js";
import { strictRuntimeGrants } from "../src/sandbox-runtime-grants.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/runtime-identity-")));
const fake = createFakeBinaryEnv({ scode: 'if [ "$1" = --help ]; then echo --keep-env; exit 0; fi; exit 99' });
afterAll(() => { fake.cleanup(); rmSync(root, { recursive: true, force: true }); });
const grants = (argv: string[]) => argv.slice(0, argv.indexOf("--"))
  .flatMap((value, index) => value === "--allow" ? [argv[index + 1]!] : []);

for (const agent of ["claude", "zai", "opencode"] as const) {
  const home = join(root, agent), cwd = join(home, "project"), bin = join(home, ".local/bin");
  const binary = getAdapter(agent, {}).binaryName;
  const versions = join(home, ".local/share", binary, "versions"), target = join(versions, "99.0.0");
  mkdirSync(bin, { recursive: true }); mkdirSync(versions, { recursive: true });
  mkdirSync(join(cwd, ".git"), { recursive: true });
  writeFileSync(target, '#!/bin/sh\nif [ "$1" = --version ]; then echo 99.0.0; exit 0; fi\necho "unexpected harness launch" >&2; exit 99\n');
  chmodSync(target, 0o700);
  symlinkSync("99.0.0", join(versions, "current"));
  symlinkSync(join(versions, "current"), join(bin, binary));
  const env = { ...fake.env, HOME: home, PATH: `${bin}:${fake.env.PATH}`, ZAI_API_KEY: "synthetic",
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache") };
  const expected = agent === "opencode"
    ? [join(home, ".opencode"), join(home, ".local/state/opencode"), join(home, ".cache/opencode")]
    : process.platform === "darwin" ? [`/private/tmp/claude-${process.getuid!()}`] : [];

  test(`${agent} runtime grants survive native version symlink resolution and policy copying`, () => {
    const adapter = getAdapter(agent, env);
    const command = resolveTrustedCommand(adapter.buildRunCommand({ agent, prompt: "unused", sandboxed: true, cwd }),
      adapter.id, cwd, env.PATH);
    expect(command[0]).toBe(target);
    for (const trust of ["standard", "trusted", "untrusted"] as const) {
      const options = structuredClone(resolveSandboxOptionsForAgent(adapter.id, "low", { strict: true, trust }));
      expect(grants(buildScodeCommand(command, cwd, "low", options, "scode", env)))
        .toEqual(trust === "untrusted" ? [] : expected);
    }
    expect(strictRuntimeGrants(agent, command, env, "darwin", 1234)).toEqual(
      agent === "opencode" ? expected : ["/private/tmp/claude-1234"]);
  });

  for (const mode of ["run", "check", "tui", "session"] as const) {
    test(`${agent} ${mode} preview carries runtime identity through a native symlink chain`, async () => {
      const result = await runCli([mode, "-a", agent, "--sandbox-strict", "--print-sandbox", "--cwd", cwd,
        ...(mode === "run" ? ["-p", "unused"] : [])], env);
      expect(result.exitCode, result.stderr).toBe(0);
      const argv = result.stdout.trimEnd().split("\n");
      expect(argv).toContain(target);
      expect(grants(argv)).toEqual(expected);
      expect(result.stderr).not.toContain("unexpected harness launch");
    });
  }
}

test("a resolved basename or argument never supplies a missing or different adapter identity", () => {
  for (const agent of [undefined, "codex"] as const) {
    expect(strictRuntimeGrants(agent, ["/opt/bin/claude", "/opt/bin/opencode"], {}, "darwin", 1234)).toEqual([]);
    expect(strictRuntimeGrants(agent, ["/opt/bin/opencode"], {}, "darwin", 1234)).toEqual([]);
  }
});
