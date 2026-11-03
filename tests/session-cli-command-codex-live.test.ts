/**
 * A live-wire codex override drive: the only session agent whose id
 * arrives mid-session (thread/start), so the session-keyed harness home
 * the CLI computes for the registry — the harnessHomeFor callback —
 * exists only once the harness has answered. Kept apart from the other
 * drive suites because it pins that adoption order, not a refusal or a
 * fatal.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { codexSessionProviderHomePath } from "../src/codex-provider.js";
import { outcomeEvents, runSessionCommand, tempWorkdir, waitForEvent } from "./helpers/session-command.js";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/live/fake-codex-app-server.ts", import.meta.url));

const withVersion = (body: string, version: string): string =>
  `if [ "$1" = "--version" ]; then printf '${version}\\n'; exit 0; fi\n${body}`;

const userLine = (text: string): string => `${JSON.stringify({ type: "user", text })}\n`;
const shutdownLine = (): string => `${JSON.stringify({ type: "shutdown" })}\n`;

describe("the session command driven in process", () => {
  test("codex override live: the thread id keys the recorded home", async () => {
    const root = tempWorkdir("drive-codex-live");
    const regRoot = tempWorkdir("drive-codex-live-reg");
    const registry = join(regRoot, "live-sessions.json");
    const workdir = join(root, "work");
    const codexHome = join(root, "codex-home");
    mkdirSync(workdir, { recursive: true });
    const baseUrl = "http://127.0.0.1:9/v1";
    const threadId = "0123456789abcdef";
    const stdin = new PassThrough();
    try {
      const outcome = await runSessionCommand(
        [
          "-a", "codex", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "CODEX_HOME,FAKE_STATE_DIR,FAKE_CWD",
        ],
        { codex: withVersion(`exec bun '${FAKE_CODEX}' "$@"`, "codex-cli 0.159.3") },
        {
          registryFile: registry,
          stdin,
          env: {
            CODEX_HOME: codexHome,
            FAKE_STATE_DIR: join(root, "state"),
            FAKE_CWD: workdir,
            CODEMUX_CODEX_PROVIDER_BASE_URL: baseUrl,
            CODEMUX_CODEX_PROVIDER_API_KEY: "e2e-key-do-not-print",
            CODEMUX_CODEX_PROVIDER_MODEL: "clawvm-qwen32b-coder",
          },
          drive: async ({ chunks }) => {
            stdin.write(userLine("scenario:basic hello"));
            const started = await waitForEvent(
              chunks,
              "session_started",
              (event) => event.type === "session_started"
            );
            // The id the fake mints at thread/start is the session's.
            expect(started.session_id).toBe(threadId);
            await waitForEvent(chunks, "turn_completed", (event) => event.type === "turn_completed");
            stdin.write(shutdownLine());
          },
        }
      );
      expect(outcome.exitCode).toBe(0);
      const events = outcomeEvents([outcome.stdout]);
      expect(events.at(-1)?.type).toBe("session_ended");
      // The registry entry's home is the session-keyed path the
      // harnessHomeFor callback computed from the adopted thread id —
      // not the run-shaped directory the child actually ran in.
      const record = JSON.parse(readFileSync(registry, "utf8")) as {
        sessions: Array<{ id: string; harness_home: string }>;
      };
      const entry = record.sessions.find((r) => r.id === threadId);
      expect(entry?.harness_home).toBe(codexSessionProviderHomePath(codexHome, baseUrl, threadId));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
