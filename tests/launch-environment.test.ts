import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyAdapter } from "../src/adapters/agy.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { DroidAdapter } from "../src/adapters/droid.js";
import { launchRunRequest } from "../src/launch.js";
import type { RunRequest } from "../src/types.js";
import { scodeGatePlatform } from "../src/cli-runtime/scode.js";
import { existsSync } from "node:fs";
import { createRunFakeBinaryEnv as createFakeBinaryEnv } from "./helpers/cli.js";

test.each(["agy", "claude"] as const)("%s version gates reject old binaries in the adapter's per-run PATH despite new ambient binaries", async (agent) => {
  const cwd = mkdtempSync(join(tmpdir(), "codemux-launch-env-"));
  const ambient = createFakeBinaryEnv({ scode: "exit 0", claude: "printf '2.1.280\\n'" });
  const selected = createFakeBinaryEnv({
    scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
    claude: "printf '2.1.279\\n'", agy: "printf 'OK\\n'",
    // The claude case is about the harness version gate, so its scode passes every floor.
  }, agent === "agy" ? "0.5.0" : "0.6.11");
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
      // agy's own scode floor is 0.6.0; macOS raises every floor to 0.6.11.
      await expect(launchRunRequest(adapter, request, {
        sandbox: true, requestedAutonomy: "read-only", cwd,
      })).rejects.toThrow(agent === "agy" ? `requires scode ${process.platform === "darwin" ? "0.6.11" : "0.6.0"}` : "2.1.280");
      expect(command).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally { dispose.mockRestore(); command.mockRestore(); env.mockRestore(); prepare.mockRestore(); }
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    selected.cleanup(); ambient.cleanup(); rmSync(cwd, { recursive: true, force: true });
  }
});

// Review finding 3: on macOS the scode floor applies to every agent, and the
// refusal comes before the harness is probed and before the experiment
// server starts. The platform is set for this process so the test runs on
// every host.
test.each(["claude", "droid"] as const)("on macOS a sandboxed %s launch with scode 0.6.8 is refused before anything starts", async (agent) => {
  const cwd = mkdtempSync(join(tmpdir(), "codemux-launch-floor-"));
  const harnessRan = join(cwd, "harness-ran"), serverRan = join(cwd, "server-ran"), scodeRan = join(cwd, "scode-ran");
  const fake = createFakeBinaryEnv({
    scode: `touch '${scodeRan}'; exit 0`,
    [agent]: `touch '${harnessRan}'; printf '99.0.0\\n'`,
  }, "0.6.8");
  const spec = join(cwd, "experiment.json");
  writeFileSync(spec, JSON.stringify({ name: "experiment", command: "/usr/bin/touch", args: [serverRan], env: [] }));
  const previousPath = process.env.PATH, previousPlatform = scodeGatePlatform.value;
  process.env.PATH = fake.env.PATH;
  scodeGatePlatform.value = "darwin";
  try {
    const adapter = agent === "claude" ? new ClaudeAdapter(fake.env) : new DroidAdapter(fake.env);
    const prepare = spyOn(adapter, "prepareRun").mockReturnValue({});
    const command = spyOn(adapter, "buildRunCommand").mockReturnValue([agent]);
    const dispose = spyOn(adapter, "cleanupRun");
    // claude as an experiment run (a server would start), droid as a plain run.
    const request: RunRequest = { agent, prompt: "probe", cwd, sandboxed: true, autonomy: "read-only",
      ...(agent === "claude" ? { hermetic: true, tools: "none", experimentMcp: spec } : {}) };
    try {
      await expect(launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only", cwd }))
        .rejects.toThrow(`every sandboxed ${agent} run requires scode 0.6.11 or newer: scode 0.6.8 is too old; 0.6.11 or newer is required on macOS`);
      expect(command).not.toHaveBeenCalled();
      for (const marker of [harnessRan, serverRan, scodeRan]) expect(existsSync(marker)).toBe(false);
    } finally { dispose.mockRestore(); command.mockRestore(); prepare.mockRestore(); }
    // Off macOS the same launch is not refused for its scode version.
    scodeGatePlatform.value = "linux";
    const elsewhere = spyOn(adapter, "prepareRun").mockReturnValue({});
    try {
      await launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only", cwd }).then(
        () => undefined, (error: unknown) => expect(String(error)).not.toContain("requires scode"));
    } finally { elsewhere.mockRestore(); }
  } finally {
    scodeGatePlatform.value = previousPlatform;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    fake.cleanup(); rmSync(cwd, { recursive: true, force: true });
  }
});
