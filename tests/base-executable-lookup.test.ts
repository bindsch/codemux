import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdapter } from "../src/adapters/index.js";
import { assertHarnessSupported, resolveScodeExecutableForEnv } from "../src/cli-runtime.js";
import { spawnSessionChild } from "../src/session/spawn.js";
import { verifyAgentWiring } from "../src/verify.js";

test("adapter executable lookup uses only the injected PATH (al40)", async () => {
  const savedPath = process.env.PATH;
  const ambient = mkdtempSync(join(tmpdir(), "codemux-ambient-path-"));
  const injected = realpathSync(mkdtempSync(join(tmpdir(), "codemux-injected-path-")));
  try {
    for (const name of ["codex", "cursor-agent", "qwen", "scode"]) {
      writeFileSync(join(ambient, name), "#!/bin/sh\necho codex-cli 0.0.1\n", { mode: 0o700 });
    }
    process.env.PATH = ambient;
    // Diagnostics explicitly supply PATH while excluding operator opt-ins.
    expect(verifyAgentWiring("codex").installed).toBe(true);
    for (const environment of [{ PATH: injected }, {}, { PATH: "" }]) {
      const executionEnv = getAdapter("codex", environment).buildExecutionEnv();
      expect(resolveScodeExecutableForEnv(executionEnv)).toBeNull();
      // The version probe must not inspect the ambient fake's old version.
      await assertHarnessSupported("codex", "codex", process.cwd(), executionEnv);
      await expect(spawnSessionChild(["codex", "--version"], executionEnv, {
        cwd: process.cwd(), sandboxed: false, autonomy: "high",
      }, { onLine: () => {}, onFatal: () => {} })).rejects.toThrow("was not found");
      for (const agent of ["codex", "cursor", "qwen"] as const) {
        const adapter = getAdapter(agent, environment);
        expect(adapter.isAvailable(), agent).toBe(false);
        expect(() => adapter.resolveExecutionCommand([adapter.binaryName, "--version"], injected))
          .toThrow("was not found");
      }
    }
    // A different injected installation must win over the ambient one.
    writeFileSync(join(injected, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const codex = getAdapter("codex", { PATH: injected });
    expect(codex.isAvailable()).toBe(true);
    expect(codex.resolveExecutionCommand(["codex", "--version"], process.cwd())[0])
      .toBe(join(injected, "codex"));
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(ambient, { recursive: true, force: true });
    rmSync(injected, { recursive: true, force: true });
  }
});
