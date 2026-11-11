import { expect, test } from "bun:test";
import { AGENT_IDS } from "../src/adapters/index.js";
import { buildScodeCommand, withKeepEnvExemption } from "../src/sandbox.js";
import { prepareSessionChild } from "../src/session/cli-spawn-prep.js";
import { buildSessionTurnSpawn } from "../src/session/turn-driver-spawn.js";
import { applyTurnProjectSandbox } from "../src/session/turn-driver-launch.js";
import { sessionPreviewFixture } from "./helpers/session-preview.js";
import { treeSnapshot } from "./helpers/tree-snapshot.js";

for (const agent of AGENT_IDS) {
  test(`${agent} preview cannot add grants to a later real turn`, async () => {
    const f = sessionPreviewFixture(agent);
    try {
      const before = structuredClone(f.policy), tree = treeSnapshot(f.home);
      const { child } = await f.prepare();
      expect(child.printedSandbox).toBe(true);
      expect(f.policy).toEqual(before);
      expect(treeSnapshot(f.home)).toEqual(tree);
      const { turnSandboxOptions } = buildSessionTurnSpawn({ ...f.common,
        options: { sandbox: true }, hermetic: f.request.hermetic === true,
        experimentProjectSettings: f.request.experimentProjectSettings === true,
        buildSessionEnvironment: () => ({ runEnv: {}, env: {} }), requestedAutonomy: "low",
        shutdownGraceMs: 100, sessionPrivateHome: null, driverRef: () => { throw new Error("no driver"); } });
      const argv = buildScodeCommand([f.adapter.binaryName], f.cwd, "low", turnSandboxOptions({}));
      expect(argv).toEqual(buildScodeCommand([f.adapter.binaryName], f.cwd, "low",
        withKeepEnvExemption(before, f.adapter.getEnv(), f.override !== null)));
      expect(argv.filter((_, i) => argv[i - 1] === "--allow")).toEqual([]);
    } finally { f.cleanup(); }
  });
}

for (const agent of ["copilot", "opencode", "pi", "gemini", "droid", "goose", "cline", "openhands", "qwen", "cursor"] as const) {
  test(`${agent} credential preflight cannot reopen a blocked preview directory on a real turn`, async () => {
    const f = sessionPreviewFixture(agent);
    try {
      const previewDir = `${f.parent}/preview`;
      f.policy.blockPaths = [previewDir]; f.policy.callerBlockPaths = [previewDir];
      const before = structuredClone(f.policy), tree = treeSnapshot(f.home);
      const buildSessionEnvironment = (context: Parameters<typeof f.adapter.getRunEnv>[1]) => {
        const runEnv = f.adapter.getRunEnv(f.request, context);
        return { runEnv, env: f.adapter.buildExecutionEnv(runEnv) };
      };
      const preflight = prepareSessionChild({ ...f.common, options: { sandbox: true }, resumeId: undefined,
        requestedAutonomy: "low", claudeBuilt: null, codexSessionHome: null,
        sessionProjectDir: null, sessionPrivateHome: null, turnPerProcess: true,
        needsKeepEnvPreflight: true, buildSessionEnvironment });
      // Cline refuses a block of its own representative settings path.
      // Even a failing preflight must leave the real policy untouched.
      if (agent === "cline") await expect(preflight).rejects.toThrow("covers the launch's own harness state");
      else await preflight;
      expect(f.policy).toEqual(before);
      expect(treeSnapshot(f.home)).toEqual(tree);
      const { turnSandboxOptions } = buildSessionTurnSpawn({ ...f.common,
        options: { sandbox: true }, hermetic: f.request.hermetic === true,
        experimentProjectSettings: f.request.experimentProjectSettings === true,
        buildSessionEnvironment, requestedAutonomy: "low", shutdownGraceMs: 100,
        sessionPrivateHome: null, driverRef: () => { throw new Error("no driver"); } });
      const realPolicy = turnSandboxOptions({});
      if (agent === "copilot") applyTurnProjectSandbox(agent, f.request, realPolicy,
        f.parent, f.privateDir, {});
      const argv = buildScodeCommand([f.adapter.binaryName], f.cwd, "low", realPolicy);
      expect(argv.filter((_, i) => argv[i - 1] === "--block")).toContain(previewDir);
      expect(argv.filter((_, i) => argv[i - 1] === "--allow")).not.toContain(previewDir);
      if (agent === "copilot") expect(argv.filter((_, i) => argv[i - 1] === "--allow")).toEqual([f.privateDir]);
    } finally { f.cleanup(); }
  });
}
