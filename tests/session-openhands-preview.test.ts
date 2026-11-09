/** OpenHands `codemux session --print-sandbox` for plain and hermetic
 * sessions: the representative first turn's scode argv, printed without
 * starting a child, writing a task file, or opening a home. */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildOpenhandsPreviewCommand, openhandsPreviewContext, openhandsPreviewTaskFile } from "../src/session/openhands-preview.js";
import { runSessionCommand, removeDir } from "./helpers/session-command.js";
import { openhandsHermeticFixture } from "./helpers/openhands-hermetic-fixture.js";

const resumeId = "0f8fad5b-d9cb-469f-a165-70867728950e"; // a synthetic v4 UUID

describe("openhands session preview", () => {
  test("the builder names a representative task path and the hermetic prefix", () => {
    expect(openhandsPreviewContext()).toEqual({});
    expect(openhandsPreviewTaskFile("/synthetic/caller")).toBe("/synthetic/caller/.openhands/.codemux/preview/task.txt");
    const plain = buildOpenhandsPreviewCommand({ privateDir: null });
    expect(plain.slice(0, 4)).toEqual(["openhands", "--headless", "--json", "--file"]);
    expect(plain).not.toContain("--override-with-envs");
    expect(plain).not.toContain("--resume");
    const modeled = buildOpenhandsPreviewCommand({ privateDir: null, model: "m" });
    expect(modeled).toContain("--override-with-envs");
    const hermetic = buildOpenhandsPreviewCommand({ privateDir: "/synthetic/home", resumeId });
    expect(hermetic.slice(0, 5)).toEqual(["env", "HOME=/synthetic/home",
      "OPENHANDS_PERSISTENCE_DIR=/synthetic/home/.openhands",
      "OPENHANDS_CONVERSATIONS_DIR=/synthetic/home/.openhands/conversations", "openhands"]);
    expect(hermetic.slice(-3)).toEqual(["--resume", resumeId, "--override-with-envs"]);
    const caller = buildOpenhandsPreviewCommand({ privateDir: null, callerHomeDir: "/synthetic/caller" });
    expect(caller[caller.indexOf("--file") + 1]).toBe("/synthetic/caller/.openhands/.codemux/preview/task.txt");
    expect(caller).toContain("--override-with-envs");
  });

  for (const mode of ["plain", "hermetic"] as const) test(`${mode}: prints the argv and starts no child`, async () => {
    const f = openhandsHermeticFixture(`openhands-preview-${mode}`);
    try {
      const flags = mode === "hermetic" ? ["--hermetic", "--print-sandbox"] : ["--print-sandbox"];
      const result = await runSessionCommand(f.args(flags), f.binaries, { env: f.env, registryFile: f.registryFile });
      expect(result.exitCode, result.stderr).toBe(0);
      const printed = result.stdout.trim().split("\n");
      expect(printed.some((line) => line.endsWith("/openhands"))).toBe(true);
      expect(printed).toContain("--headless");
      expect(printed).toContain(join(f.operator, ".openhands", ".codemux", "preview", "task.txt"));
      if (mode === "hermetic") {
        const home = printed.find((line) => line.startsWith("HOME="))!;
        expect(home.startsWith(`HOME=${f.parent}/session-`)).toBe(true);
        expect(printed).toContain("--override-with-envs");
      } else {
        expect(printed.some((line) => line.startsWith("HOME="))).toBe(false);
      }
      // Nothing ran and nothing was written: no child, no scode, no task
      // file directory, no private home, no registry record.
      expect(f.observations()).toEqual([]);
      expect(existsSync(join(f.state, "scode.txt"))).toBe(false);
      expect(existsSync(join(f.operator, ".openhands"))).toBe(false);
      expect(existsSync(f.registryFile)).toBe(false);
    } finally { removeDir(f.root); }
  }, 20_000);

  test("a resumed hermetic preview names the recorded home and conversation", async () => {
    const f = openhandsHermeticFixture("openhands-preview-resume");
    try {
      const first = await f.run(["--hermetic"], { turns: 1 });
      expect(first.exitCode, first.stderr).toBe(0);
      const id = first.events.find((event) => event.type === "session_started")!.session_id as string;
      const home = join(f.parent, `session-${id}`);
      const result = await runSessionCommand(f.args(["--hermetic", "--print-sandbox", "--resume", id]), f.binaries,
        { env: f.env, registryFile: f.registryFile });
      expect(result.exitCode, result.stderr).toBe(0);
      const printed = result.stdout.trim().split("\n");
      expect(printed).toContain(`HOME=${home}`);
      expect(printed.slice(printed.indexOf("--resume"), printed.indexOf("--resume") + 2)).toEqual(["--resume", id]);
      // Only the real turn ran; the preview started nothing.
      expect(f.observations()).toHaveLength(1);
      expect(existsSync(home)).toBe(true);
    } finally { removeDir(f.root); }
  }, 20_000);
});
