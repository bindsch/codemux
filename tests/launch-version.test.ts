import { expect, test } from "bun:test";
import { BaseAdapter, type RunContext } from "../src/adapters/base.js";
import { launchRunRequest } from "../src/launch.js";
import type { AdapterCapabilities, RunRequest, RunResult } from "../src/types.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

class VersionContextAdapter extends BaseAdapter {
  readonly id = "claude";
  readonly binaryName = "claude";
  contexts: RunContext[] = [];

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true, supportsInteractive: true, supportsModel: false,
      supportsAutonomy: true, autonomyLevels: ["high"], supportsEffort: false, effortLevels: [],
    };
  }

  buildRunCommand(_request: RunRequest, context: RunContext = {}): string[] {
    this.contexts.push(context);
    return [this.binaryName];
  }

  buildTuiCommand(): string[] { return [this.binaryName]; }

  override processRunResult(result: RunResult, _request: RunRequest, context: RunContext = {}): RunResult {
    this.contexts.push(context);
    return result;
  }

  override cleanupRun(context: RunContext): void { this.contexts.push(context); }
}

const oldClaude = 'if [ "$1" = "--version" ]; then printf "1.4.4\\n"; exit 0; fi; printf "OK\\n"';

test("programmatic adapter.run does not probe or gate a harness version", async () => {
  const fake = createFakeBinaryEnv({ claude: oldClaude });
  try {
    const adapter = new VersionContextAdapter(fake.env);
    const result = await adapter.run({ agent: "claude", prompt: "probe", autonomy: "high" });
    expect(result.stdout).toBe("OK\n");
    expect(adapter.contexts).toHaveLength(3);
    expect(adapter.contexts[0]?.harnessVersion).toBeUndefined();
  } finally { fake.cleanup(); }
});

test.each([false, true])("launch preserves the CLI's version on one context (sandbox=%s)", async (sandbox) => {
  const fake = createFakeBinaryEnv({
    claude: oldClaude,
    scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
  });
  try {
    const adapter = new VersionContextAdapter(fake.env);
    const result = await launchRunRequest(adapter,
      { agent: "claude", prompt: "probe", autonomy: "high", sandboxed: sandbox },
      { sandbox, requestedAutonomy: "high", harnessVersion: "2.1.280" });
    expect(result.stdout).toBe("OK\n");
    expect(adapter.contexts).toHaveLength(3);
    for (const context of adapter.contexts) {
      expect(context).toBe(adapter.contexts[0]!);
      expect(context.harnessVersion).toBe("2.1.280");
    }
  } finally { fake.cleanup(); }
});

test.each(["run", "check"])("CLI %s retains its harness compatibility gate", async (command) => {
  const fake = createFakeBinaryEnv({ claude: oldClaude });
  try {
    const result = await runCli([
      command, "-a", "claude", "--no-sandbox", "--auto", "high",
      ...(command === "run" ? ["-p", "probe"] : []),
    ], { ...fake.env, CODEMUX_ALLOW_UNTESTED_HARNESS: "" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("claude 1.4.4 is older than");
    expect(result.stdout).toBe("");
  } finally { fake.cleanup(); }
});
