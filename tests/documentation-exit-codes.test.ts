/**
 * Two drift guards the exit-code contract (review round 2, contracts 1)
 * and the docs-path cleanup (edges minor 3) need:
 *
 * 1. Every refusal message the exit-code table in docs/cli.md quotes for
 *    exit 64 must appear in the source next to the construct that makes
 *    it a 64 (UsageRefusalError, usageError, asUsage, promptRefusal,
 *    failInvalidOption, or a direct process.exit(64)), so the table can
 *    never describe a code the implementation no longer produces.
 * 2. Every docs/<name>.md path a test quotes must name an existing file,
 *    the same rule documentation.test.ts already enforces for src/.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { getDefaultConfig } from "../src/config.js";
import { OUTPUT_LIMIT_EXIT_CODE } from "../src/process-capture.js";
import { TIMEOUT_EXIT_CODE } from "../src/process-runner.js";
import { SIGNAL_EXIT_CODE } from "../src/process-runner-exit.js";
import { EMPTY_ANSWER_EXIT_CODE } from "../src/result-empty.js";
import { registerRunCommand } from "../src/run-command.js";
import { exitOnResumeRefusal } from "../src/session/cli-usage.js";
import { registerSessionOptions } from "../src/session/cli-options.js";
import { SESSION_SIGNAL_EXIT_CODE } from "../src/session/process.js";
import type { ResumeLookup } from "../src/session/registry/resume.js";
import { USAGEMUX_UNAVAILABLE_EXIT_CODE } from "../src/usage.js";
import { USAGE_REFUSAL_EXIT_CODE } from "../src/validation.js";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const sourceFiles = (directory: string): string[] =>
  readdirSync(join(root, directory)).flatMap((name) => {
    const path = join(directory, name);
    return statSync(join(root, path)).isDirectory()
      ? sourceFiles(path)
      : path.endsWith(".ts") ? [path] : [];
  });

class ExitSentinel extends Error {
  constructor(readonly code: number) { super(`process.exit(${code})`); }
}

/** Runs `action` with process.exit throwing its code and stderr captured. */
async function captureExit(action: () => Promise<unknown>): Promise<{ code: number | undefined; stderr: string }> {
  const lines: string[] = [];
  const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => { lines.push(values.map(String).join(" ")); });
  const exit = spyOn(process, "exit").mockImplementation(((code?: number) => { throw new ExitSentinel(code ?? 0); }) as typeof process.exit);
  const before = process.exitCode;
  try {
    await action();
    return { code: typeof process.exitCode === "number" ? process.exitCode : undefined, stderr: lines.join("\n") };
  } catch (thrown) {
    if (thrown instanceof ExitSentinel) return { code: thrown.code, stderr: lines.join("\n") };
    throw thrown;
  } finally {
    process.exitCode = before;
    error.mockRestore();
    exit.mockRestore();
  }
}

describe("the exit-64 contract between docs/cli.md and the source", () => {
  const row = read("docs/cli.md")
    .split("## Exit codes\n")[1]!
    .split("\n## ")[0]!
    .split("\n")
    .find((line) => line.startsWith("| 64 |"))!;
  // Only explicit quotations are checked: prose clauses (an unreadable or
  // empty -f file) describe classes of refusals, not literal messages.
  const quoted = [...row.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);

  test("the 64 row quotes the refusal messages it pins", () => {
    expect(quoted.length).toBeGreaterThanOrEqual(7);
  });

  test("each quoted refusal appears in the source beside a 64 construct", () => {
    const sources = sourceFiles("src").map((path) => ({ path, text: read(path) }));
    expect(sources.length).toBeGreaterThan(100);
    const markers = /UsageRefusalError|usageError|asUsage|promptRefusal|failInvalidOption|exit\(64\)/;
    for (const message of quoted) {
      const near = sources.some(({ text }) => {
        const lines = text.split("\n");
        return lines.some((line, index) => {
          if (!line.includes(message)) return false;
          return lines
            .slice(Math.max(0, index - 6), index + 7)
            .some((window) => markers.test(window));
        });
      });
      expect(near, JSON.stringify(message)).toBe(true);
    }
  });

  test("the quoted prompt refusal is what run emits, and only run takes a prompt", async () => {
    // Behavior, not text: a run with no prompt exits 64 with the quoted
    // message. Session has no -p/-f (its prompts arrive as JSONL frames),
    // so the row's prompt refusals describe run alone (review 422 #22).
    const program = new Command();
    program.exitOverride();
    registerRunCommand(program, getDefaultConfig(), () => {});
    // An empty PATH: the refusal must come before any harness is resolved.
    const path = process.env.PATH;
    process.env.PATH = "";
    const outcome = await captureExit(() =>
      program.parseAsync(["node", "codemux", "run", "--no-sandbox", "--auto", "high", "-a", "claude"]))
      .finally(() => { process.env.PATH = path; });
    expect(outcome.code).toBe(64);
    expect(outcome.stderr).toContain(quoted[0]!);
    const session = new Command();
    registerSessionOptions(session, "claude");
    const flags = session.options.flatMap((option) => [option.long, option.short]);
    expect(flags).not.toContain("--prompt");
    expect(flags).not.toContain("--file");
    expect(flags).not.toContain("-p");
  });
});

describe("documented exit codes equal the codes the code emits", () => {
  const listed = (text: string): number[] => [...text.matchAll(/^\| (\d+) \|/gm)]
    .map((match) => Number(match[1]!)).sort((a, b) => a - b);
  const sorted = (values: Iterable<number>): number[] => [...new Set(values)].sort((a, b) => a - b);

  // The resume verdicts, observed: exitOnResumeRefusal is the one place
  // the session CLI maps a lookup to 66, 78, or 1.
  async function resumeCodes(): Promise<number[]> {
    const lookups: ResumeLookup[] = [{ outcome: "not_found" }, { outcome: "untrusted", reason: "r" },
      { outcome: "refused", reason: "r" }, { outcome: "unavailable", reason: "r" }];
    const codes: number[] = [];
    for (const lookup of lookups) {
      codes.push((await captureExit(async () => exitOnResumeRefusal("id", "/registry", lookup))).code!);
    }
    return codes;
  }

  test("docs/cli.md lists every code and no other (review 422 #23)", async () => {
    const documented = listed(read("docs/cli.md").split("## Exit codes\n")[1]!.split("\n## ")[0]!);
    // doctor's config verdict is a ternary inside runMachineCheck, which
    // probes installed harnesses; read the expression instead of running it.
    const doctorConfig = Number(read("src/doctor-machine-check.ts").match(/configError !== undefined\s*\?\s*(\d+)/)![1]);
    expect(documented).toEqual(sorted([0, EMPTY_ANSWER_EXIT_CODE, doctorConfig, USAGE_REFUSAL_EXIT_CODE,
      ...await resumeCodes(), USAGEMUX_UNAVAILABLE_EXIT_CODE, TIMEOUT_EXIT_CODE, OUTPUT_LIMIT_EXIT_CODE, SIGNAL_EXIT_CODE]));
  });

  test("the session CLI header lists the codes a session can end with", async () => {
    const header = read("src/session/cli.ts").split("Exit codes:")[1]!.split("*/")[0]!;
    const session = sorted([...header.matchAll(/\b(\d{1,3})\b/g)].map((match) => Number(match[1]!)));
    expect(session).toEqual(sorted([0, EMPTY_ANSWER_EXIT_CODE, USAGE_REFUSAL_EXIT_CODE, ...await resumeCodes(),
      SESSION_SIGNAL_EXIT_CODE]));
  });
});

describe("docs paths quoted in tests", () => {
  test("every docs/<name>.md path a test names exists", () => {
    let named = 0;
    for (const path of sourceFiles("tests")) {
      const text = read(path).replace(/https?:\/\/[^\s"'`)]+/g, "");
      // A fixture the test writes itself (a synthetic installed-layout
      // document) is not a repository document reference: its name on a
      // writeFileSync line (the path may be joined from parts) exempts
      // every mention of that basename in the file.
      const written = new Set(
        text.split("\n")
          .filter((line) => line.includes("writeFileSync"))
          .flatMap((line) => [...line.matchAll(/([A-Za-z0-9_.-]+\.md)/g)].map((m) => m[1]!))
      );
      for (const match of text.matchAll(/docs\/[A-Za-z0-9_./-]+\.md/g)) {
        if (written.has(match[0]!.split("/").pop()!)) continue;
        named++;
        expect(existsSync(join(root, match[0]!)), path + " names " + match[0]).toBe(true);
      }
    }
    expect(named).toBeGreaterThan(0);
  });
});
