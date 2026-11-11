import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "../src/adapters/index.js";
import { prepareSessionChild } from "../src/session/cli-spawn-prep.js";
import { turnAgentStateRoot } from "../src/session/turn-driver-homes.js";
import { createFakeBinaryEnv } from "./helpers/cli.js";
import { treeSnapshot } from "./helpers/tree-snapshot.js";

const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/turn-preview-resume-")));
const agents = ["pi", "gemini", "copilot", "droid", "goose", "cline", "openhands", "qwen"] as const;
const fake = createFakeBinaryEnv({
  ...Object.fromEntries(agents.map((agent) => [agent, "echo 'unexpected harness launch' >&2; exit 99"])),
  scode: "if [ \"$1\" = --help ]; then echo --keep-env; exit 0; fi; exit 99",
});
afterAll(() => { fake.cleanup(); rmSync(root, { recursive: true, force: true }); });

for (const agent of agents) {
  for (const state of ["missing", "directory", "symlink", "file"] as const) {
    test(`${agent} resumed hermetic preview validates ${state} home without writes`, async () => {
      const home = join(root, `${agent}-${state}`), cwd = join(home, "project");
      mkdirSync(join(cwd, ".git"), { recursive: true });
      const original = { ...process.env };
      const environment = { ...fake.env, HOME: home, QWEN_HOME: join(home, ".qwen"), XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
        XDG_CACHE_HOME: join(home, ".cache"),
        [`CODEMUX_${agent.toUpperCase()}_PROVIDER_BASE_URL`]: "https://provider.invalid/v1",
        [`CODEMUX_${agent.toUpperCase()}_PROVIDER_API_KEY`]: "synthetic",
        [`CODEMUX_${agent.toUpperCase()}_PROVIDER_MODEL`]: "synthetic" };
      Object.assign(process.env, environment);
      const output = spyOn(process.stdout, "write").mockReturnValue(true);
      try {
        const id = agent === "cline" ? "1234567890123" : agent === "openhands"
          ? "1234567890abcdef1234567890abcdef" : "1b91a970-7a85-421e-b9d0-09b06665b637";
        const parent = join(turnAgentStateRoot(agent, []), ".codemux-hermetic");
        expect(parent.startsWith(home + "/")).toBe(true);
        const privateDir = join(parent, `session-${id}`);
        if (state !== "missing") {
          mkdirSync(parent, { recursive: true });
          if (state === "directory") mkdirSync(privateDir);
          else if (state === "symlink") symlinkSync(cwd, privateDir);
          else writeFileSync(privateDir, "not a directory");
        }
        const before = treeSnapshot(home);
        const adapter = getAdapter(agent, environment);
        const request = { agent, prompt: "unused", cwd, hermetic: true, sandboxed: true, autonomy: "low" as const };
        const pending = prepareSessionChild({
          options: { sandbox: true, printSandbox: true }, agentId: agent, adapter,
          override: adapter.providerOverride(), runLike: request, resumeId: id,
          model: "synthetic", autonomy: "low", requestedAutonomy: "low", effort: undefined,
          workdir: cwd, sandboxOptions: { trust: "standard" }, claudeBuilt: null,
          codexSessionHome: null, sessionProjectDir: null, sessionPrivateHome: null,
          turnPerProcess: true, needsKeepEnvPreflight: false,
          buildSessionEnvironment: (context) => {
            const runEnv = adapter.getRunEnv(request, context);
            return { runEnv, env: { ...environment, ...adapter.getEnv(), ...runEnv } };
          },
        });
        if (state === "directory" || agent === "qwen") {
          expect((await pending).printedSandbox).toBe(true);
          expect(output).toHaveBeenCalled();
        } else {
          await expect(pending).rejects.toThrow(state === "missing" ? "so it cannot resume" : /directory|symlink/);
          expect(output).not.toHaveBeenCalled();
        }
        expect(treeSnapshot(home)).toEqual(before);
      } finally {
        output.mockRestore();
        for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
        Object.assign(process.env, original);
      }
    });
  }
}
