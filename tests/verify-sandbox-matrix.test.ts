import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IDS, getAdapter } from "../src/adapters/index.js";
import { SCODE_TRUST_LEVELS } from "../src/sandbox.js";
import { buildEffectiveScodeCommands } from "../src/verify.js";
import { verifiedScodeCommand } from "../src/verify-scode.js";
import { minimalPath, runCli } from "./helpers/cli.js";

const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/verify-sandbox-")));
const systemBinary = realpathSync("/usr/bin/true");
const binaries = [...new Set(AGENT_IDS.map((agent) => getAdapter(agent, {}).binaryName))];
const bin = join(root, "bin");
mkdirSync(bin);
// Resolve real symlinks into a system read root without executing a harness.
for (const binary of binaries) symlinkSync(systemBinary, join(bin, binary));
const env = { PATH: `${bin}:${minimalPath()}` };
afterAll(() => rmSync(root, { recursive: true, force: true }));

for (const agent of AGENT_IDS) {
  for (const trust of SCODE_TRUST_LEVELS) {
    for (const strict of [false, true]) {
      test(`verify ${agent}, ${trust}, strict=${strict} resolves all eight command rows`, async () => {
        const result = await runCli(["verify", "-a", agent, "--show-scode", "--sandbox-trust", trust,
          ...(strict ? ["--sandbox-strict"] : [])], env);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout).not.toContain("Unavailable:");
        const rows = result.stdout.split("\n").filter((line) => /^\| \w+ \| (read-only|low|medium|high) \|/.test(line));
        expect(rows).toHaveLength(8);
        for (const row of rows) {
          expect(row).toContain(systemBinary);
          expect(row).toContain(`--trust ${trust}`);
          expect(/ --strict(?: |`)/.test(row)).toBe(strict);
          if (trust === "untrusted") expect(row).not.toContain("--rw");
        }
      });
    }
  }
}

test("verify lists every agent after a genuine strict wrapped-executable refusal", async () => {
  const local = join(root, "local"); mkdirSync(local);
  const executable = join(local, "agy");
  writeFileSync(executable, "#!/bin/sh\necho 'unexpected harness launch' >&2\nexit 99\n", { mode: 0o700 });
  const result = await runCli(["verify", "--show-scode", "--sandbox-trust", "untrusted"], {
    PATH: `${local}:${env.PATH}`,
  });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain(`Unavailable: strict sandbox cannot read env-wrapped executable ${executable}`);
  expect(result.stderr).not.toContain("unexpected harness launch");
  for (const agent of AGENT_IDS) {
    expect(result.stdout).toContain(`| ${agent} | high | tui |`);
  }
  expect(result.stdout).toContain(`| codex | high | tui | \`scode`);
});

test("missing executables leave diagnostic rows without unresolved launch commands", async () => {
  const result = await runCli(["verify", "--show-scode", "--sandbox-strict"], { PATH: minimalPath() });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("Unavailable: sandbox command executable 'agy' was not found");
  for (const agent of AGENT_IDS) expect(result.stdout).toContain(`| ${agent} | high | tui |`);
});

test("verify warns when strict is supplied without a preview", async () => {
  const result = await runCli(["verify", "-a", "codex", "--sandbox-strict"], env);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("sandbox policy flags require --show-scode");
});

test("the in-process matrix retains later rows after a strict executable refusal", () => {
  const local = join(root, "in-process"); mkdirSync(local);
  const executable = join(local, "agy");
  writeFileSync(executable, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${local}:${env.PATH}`;
  try {
    const rows = buildEffectiveScodeCommands(["agy", "codex"], { trust: "untrusted" });
    expect(rows).toHaveLength(16);
    for (const row of rows.filter((row) => row.agentId === "agy" && row.mode === "run")) {
      expect(row.command).toEqual([]);
      expect(row.error).toBe(`strict sandbox cannot read env-wrapped executable ${executable}; scode has no read-only path grant`);
    }
    for (const row of rows.filter((row) => row.agentId === "codex" || row.mode === "tui")) {
      expect(row.error).toBeUndefined();
      expect(row.command).toContain(row.agentId === "agy" ? executable : systemBinary);
    }
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});

test("the in-process preview reports a missing executable without emitting raw argv", () => {
  const missing = join(root, "absent-executable");
  expect(verifiedScodeCommand([missing], root, "low", { strict: true })).toEqual({
    command: [], error: `sandbox command executable '${missing}' was not found`,
  });
});
