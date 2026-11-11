import { buildEffectiveScodeCommands } from "../../src/verify.js";
import { createFakeBinaryEnv, runCli } from "./cli.js";

function fixture() {
  return createFakeBinaryEnv(Object.fromEntries(["codex", "cursor-agent", "opencode"].map(
    (name) => [name, "echo 'unexpected harness launch' >&2; exit 99"]
  )));
}

export function buildFixtureScodeCommands(...args: Parameters<typeof buildEffectiveScodeCommands>) {
  const fake = fixture(), savedPath = process.env.PATH;
  process.env.PATH = fake.env.PATH;
  try { return buildEffectiveScodeCommands(...args); }
  finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    fake.cleanup();
  }
}

export async function withVerifyExecutables<T>(run: () => Promise<T>): Promise<T> {
  const fake = fixture(), savedPath = process.env.PATH;
  process.env.PATH = fake.env.PATH;
  try { return await run(); }
  finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    fake.cleanup();
  }
}

export async function runVerifyCli(args: string[]) {
  const fake = fixture();
  try { return await runCli(args, fake.env); }
  finally { fake.cleanup(); }
}
