import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ClineAdapter } from "../src/adapters/cline.js";
import { supportsPlaywrightMcpAgent } from "../src/mcp.js";
import { SESSION_AGENTS } from "../src/session/cli-agents.js";
import { GOOSE_DRIVER_PROFILE } from "../src/session/goose-driver.js";
import { OPENHANDS_DRIVER_PROFILE } from "../src/session/openhands-driver.js";
import { engineSession, fakeTurnProcess, wireProfile } from "./helpers/session-turn-engine.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

for (const profile of [GOOSE_DRIVER_PROFILE, OPENHANDS_DRIVER_PROFILE]) {
  for (const end of ["shutdown", "stdin-close"] as const) {
    for (const closed of [false, true]) {
      test(`${profile.agent}: ${end} during spawn never writes ${closed ? "closed" : "open"} stdin`, async () => {
        const child = fakeTurnProcess();
        child.failWrites = closed;
        const write = spyOn(child, "writeRaw");
        const endInput = spyOn(child, "endInput");
        const pending = Promise.withResolvers<typeof child>();
        const session = engineSession({ options: {
          profile: wireProfile({}, { agent: profile.agent, promptCarrier: profile.promptCarrier }),
          spawnTurn: () => pending.promise,
        } });
        try {
          session.user();
          if (end === "shutdown") session.shutdown();
          else session.close();
          pending.resolve(child);
          child.exit(0);
          expect(await session.code()).toBe(0);
          expect(write).not.toHaveBeenCalled();
          expect(endInput).not.toHaveBeenCalled();
          expect(session.events.filter((event) => event.type === "turn_completed"))
            .toMatchObject([{ finish: "end" }]);
          expect(session.events.at(-1)).toMatchObject({ type: "session_ended", reason: end, exit_code: 0 });
          expect(session.events.some((event) => event.type === "error")).toBe(false);
        } finally {
          session.dispose();
          write.mockRestore();
          endInput.mockRestore();
        }
      });
    }
  }
}

test("Qwen release notes distinguish run tool exclusion from the session refusal", () => {
  expect(SESSION_AGENTS.qwen?.tools).toBe(false);
  const notes = read("CHANGELOG.md");
  expect(notes).toContain("Qwen session tool selection remains refused by the CLI");
  expect(notes).not.toContain("with per-turn tool exclusion");
});

test("Cline release notes match its native effort and provider support", () => {
  const adapter = new ClineAdapter({});
  expect(adapter.capabilities()).toMatchObject({ supportsEffort: true, supportsProviderOverride: true });
  expect(adapter.mapEffort("high")).toEqual(["--thinking", "high"]);
  const notes = read("CHANGELOG.md");
  expect(notes).toContain("Cline accepts provider overrides and maps `--effort` to `--thinking`");
  expect(notes).not.toContain("cline keeps both refusals");
});

test("Kimi machine documentation describes its supported turn timeout", () => {
  expect(SESSION_AGENTS.kimi?.interrupt).toBe(true);
  const source = read("src/session/kimi-machine.ts");
  expect(source).toContain("`turn_timeout` stops the active turn child");
  expect(source).not.toContain("There is no turn_timeout row");
  expect(source).not.toContain("no verified interrupt channel");
});

test("Agy registry comment scopes the Playwright refusal to Agy", () => {
  expect(supportsPlaywrightMcpAgent("agy")).toBe(false);
  expect(supportsPlaywrightMcpAgent("codex")).toBe(true);
  expect(supportsPlaywrightMcpAgent("kimi")).toBe(true);
  const source = read("src/session/agy-finalize.ts");
  expect(source).toContain("Agy sessions do not support --enable-playwright-mcp");
  expect(source).not.toContain("outside the claude family");
});

test("the merged changelog contains one unreleased section with all three lines of work", () => {
  const notes = read("CHANGELOG.md");
  expect(notes.match(/^## \[Unreleased\]$/gm)).toHaveLength(1);
  expect(notes).not.toMatch(/^(?:<{7}|={7}|>{7})/m);
  const unreleased = notes.split("## [Unreleased]")[1]!.split("## [2.0.0]")[0]!;
  expect(unreleased).toContain("`--sandbox-strict`");
  expect(unreleased).toContain("`codemux complete serve|once`");
  expect(unreleased).toContain("Session IDs reject path separators");
  const bullets = unreleased.split("\n").filter((line) => line.startsWith("- "));
  expect(new Set(bullets).size).toBe(bullets.length);
});
