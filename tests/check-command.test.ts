import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { AgyAdapter } from "../src/adapters/agy.js";
import type { RunContext } from "../src/adapters/base.js";
import { agyKeychainHost } from "../src/agy-keychain.js";
import { registerCheckCommand } from "../src/check-command.js";
import { getDefaultConfig } from "../src/config.js";
import type { RunRequest } from "../src/types.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

test.each([
  { flags: ["--agy-isolation-probe", "login"] },
  { flags: ["--hermetic"] },
  { flags: ["--tools", "none"] },
])("check $flags refuses agy below its supported version before a request", async ({ flags }) => {
  const fake = createFakeBinaryEnv({
    agy: 'if [ "$1" = "--version" ]; then printf "1.2.13\\n"; exit 0; fi; printf "LIVE-REQUEST\\n"',
    scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
  });
  try {
    const result = await runCli(["check", "-a", "agy", ...flags], {
      ...fake.env,
      CODEMUX_ALLOW_UNTESTED_HARNESS: "",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("agy 1.2.13 is older than");
    expect(result.stdout).toBe("");
  } finally { fake.cleanup(); }
});

test.each([
  { flags: ["--agy-isolation-probe", "login"], launches: 1 },
  { flags: ["--hermetic"], launches: 2 },
  { flags: ["--tools", "none"], launches: 2 },
])("check $flags probes agy's version once and retains it in every launch context", async ({ flags, launches }) => {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "codemux-check-version-"));
  const versions = join(home, "versions.log");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const events = [{ event: "init", init: { tools: [] } },
    { event: "result", result: { status: "SUCCESS", response: "OK" } }]
    .map((event) => JSON.stringify(event)).join("\n");
  const fake = createFakeBinaryEnv({
    agy: `if [ "$1" = "--version" ]; then printf '1.2.14\\n' >> ${quote(versions)}; printf '1.2.14\\n'; exit 0; fi; printf '%s\\n' ${quote(events)}`,
    scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
  });
  const environment = { ...fake.env, HOME: home, CODEMUX_ALLOW_UNTESTED_HARNESS: "" };
  const previous = Object.fromEntries(Object.keys(environment).map((name) => [name, process.env[name]]));
  const previousExit = process.exitCode;
  const contexts: RunContext[] = [];
  const original = AgyAdapter.prototype.buildRunCommand;
  const build = spyOn(AgyAdapter.prototype, "buildRunCommand").mockImplementation(function (
    this: AgyAdapter, request: RunRequest, context: RunContext = {}
  ) {
    contexts.push(context);
    return original.call(this, request, context);
  });
  const hostHome = spyOn(agyKeychainHost, "home").mockReturnValue(home);
  try {
    Object.assign(process.env, environment);
    const program = new Command();
    registerCheckCommand(program, getDefaultConfig(), () => {});
    await program.parseAsync(["check", "-a", "agy", ...flags], { from: "user" });
    expect(contexts).toHaveLength(launches);
    for (const context of contexts) expect(context.harnessVersion).toBe("1.2.14");
    expect(readFileSync(versions, "utf8")).toBe("1.2.14\n");
  } finally {
    build.mockRestore();
    hostHome.mockRestore();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    process.exitCode = previousExit;
    fake.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});
