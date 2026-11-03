/**
 * --sandbox-block canonicalization on the session path (round 19, edges
 * 1): the registry record was canonicalized, but the children scode ran
 * carried the caller's raw spelling, so a symlink retargeted between
 * turns made later children block the new target and regain the tree the
 * operator named. The canonical form (the dereferenced path captured when
 * the request was parsed) must be what every child enforces, on every
 * turn, whatever the link points at later.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  outcomeEvents,
  runSessionCommand,
  tempWorkdir,
  waitForEvent,
} from "./helpers/session-command.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";

const FAKE_OPENCODE = fileURLToPath(new URL("./fixtures/live/fake-opencode-run.ts", import.meta.url));
const fakeHarness = (fixture: string): string =>
  // The session floor probe reads the harness version first (1.18.18 is
  // the minimum the opencode session driver supports).
  `if [ "$1" = "--version" ]; then printf '1.18.18\\n'; exit 0; fi\nexec bun '${fixture}' "$@"`;
const userLine = (text: string): string => `${JSON.stringify({ type: "user", text })}\n`;
const shutdownLine = (): string => `${JSON.stringify({ type: "shutdown" })}\n`;

registerNoLeakedSignals();

describe("a sandboxed session enforces the canonical block paths", () => {
  test("every turn passes scode the dereferenced path, even after a retarget", async () => {
    const root = tempWorkdir("session-block-retarget");
    const regRoot = tempWorkdir("session-block-retarget-reg");
    const registry = join(regRoot, "live-sessions.json");
    const workdir = join(root, "work");
    const stateDir = join(root, "state");
    const targetOne = join(root, "tree-one");
    const targetTwo = join(root, "tree-two");
    const link = join(root, "block-link");
    mkdirSync(workdir);
    mkdirSync(stateDir);
    mkdirSync(targetOne);
    mkdirSync(targetTwo);
    symlinkSync(targetOne, link);
    // macOS temp roots are symlinked (/var -> /private/var): every path
    // compared with what the command records is realpathed first.
    const canonicalOne = realpathSync(targetOne);
    const scodeArgv = join(stateDir, "scode-argv.txt");
    // A scode that records the argv of each wrap (one argument per line,
    // one ENDOFARGV marker per invocation) and then runs the wrapped
    // child, so the fake harness completes real turns through it.
    const recordScode = `printf '%s\\n' "$@" >> ${JSON.stringify(scodeArgv)}\n` +
      `printf 'ENDOFARGV\\n' >> ${JSON.stringify(scodeArgv)}\n` +
      'while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"';
    const stdin = new PassThrough();
    try {
      const outcome = await runSessionCommand(
        [
          "-a", "opencode", "--sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--sandbox-block", link,
          "--pass-env", "FAKE_STATE_DIR",
        ],
        { opencode: fakeHarness(FAKE_OPENCODE), scode: recordScode },
        {
          registryFile: registry,
          stdin,
          env: { FAKE_STATE_DIR: stateDir, XDG_DATA_HOME: join(root, "data") },
          drive: async ({ chunks }) => {
            stdin.write(userLine("scenario:basic one"));
            await waitForEvent(chunks, "turn 1", (event) => event.type === "turn_completed");
            // Retarget the symlink the caller spelled: without the
            // canonicalization a later turn would dereference this new
            // target at block time and hand back the original tree.
            rmSync(link);
            symlinkSync(targetTwo, link);
            stdin.write(userLine("scenario:basic two"));
            await waitForEvent(chunks, "turn 2", (event) => event.type === "turn_completed");
            stdin.write(shutdownLine());
          },
        }
      );
      expect(outcome.exitCode).toBe(0);
      expect(outcomeEvents([outcome.stdout]).at(-1)?.type).toBe("session_ended");
      const wraps = readFileSync(scodeArgv, "utf8")
        .split("ENDOFARGV\n")
        .filter((record) => record.trim() !== "")
        .map((record) => record.split("\n").filter((line) => line !== ""));
      // Both turns spawned through scode.
      expect(wraps.length).toBeGreaterThanOrEqual(2);
      for (const argv of wraps) {
        const blocked = argv.filter((_, index) => argv[index - 1] === "--block");
        expect(blocked).toEqual([canonicalOne]);
        expect(argv).not.toContain(link);
      }
      // The record carries the same canonical spelling the children
      // enforce: the two sets are the same strings.
      const record = JSON.parse(readFileSync(registry, "utf8")) as {
        sessions: Array<{ sandbox_block?: string[] }>;
      };
      expect(record.sessions[0]?.sandbox_block).toEqual([canonicalOne]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
