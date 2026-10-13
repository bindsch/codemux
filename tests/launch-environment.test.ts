import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyAdapter } from "../src/adapters/agy.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { launchRunRequest } from "../src/launch.js";
import type { RunRequest } from "../src/types.js";
import { createFakeBinaryEnv } from "./helpers/cli.js";

test.each(["agy", "claude"] as const)("%s version gates reject old binaries in the adapter's per-run PATH despite new ambient binaries", async (agent) => {
  const cwd = mkdtempSync(join(tmpdir(), "codemux-launch-env-"));
  const ambient = createFakeBinaryEnv({ scode: "exit 0", claude: "printf '2.1.280\\n'" });
  const selected = createFakeBinaryEnv({
    scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
    claude: "printf '2.1.279\\n'", agy: "printf 'OK\\n'",
  }, "0.5.0");
  const previousPath = process.env.PATH;
  const spec = join(cwd, "experiment.json");
  writeFileSync(spec, JSON.stringify({ name: "experiment", command: process.execPath, args: [], env: [] }));
  try {
    process.env.PATH = ambient.env.PATH;
    const adapter = agent === "agy" ? new AgyAdapter(ambient.env) : new ClaudeAdapter(ambient.env);
    const prepare = spyOn(adapter, "prepareRun").mockReturnValue({});
    const env = spyOn(adapter, "getRunEnv").mockReturnValue({ PATH: selected.env.PATH! });
    const command = spyOn(adapter, "buildRunCommand").mockReturnValue([agent]);
    const dispose = spyOn(adapter, "cleanupRun");
    const request: RunRequest = { agent, prompt: "probe", cwd, sandboxed: true, autonomy: "read-only",
      ...(agent === "claude" ? { hermetic: true, tools: "none", experimentMcp: spec } : {}) };
    try {
      await expect(launchRunRequest(adapter, request, {
        sandbox: true, requestedAutonomy: "read-only", cwd,
      })).rejects.toThrow(agent === "agy" ? "requires scode 0.6.0" : "2.1.280");
      expect(command).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally { dispose.mockRestore(); command.mockRestore(); env.mockRestore(); prepare.mockRestore(); }
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    selected.cleanup(); ambient.cleanup(); rmSync(cwd, { recursive: true, force: true });
  }
});
