import { expect, spyOn, test } from "bun:test";
import { abandonFreshSessionDirectories } from "../src/session/cli-abandon.js";
import type { ProjectSettingsSessionDir } from "../src/claude-project-config.js";
import { watchingHome } from "./helpers/session-turn-engine.js";

test("abort cleanup removes fresh directories and preserves resumed directories", () => {
  const projectHome = watchingHome();
  const project = projectHome as unknown as ProjectSettingsSessionDir;
  const privateHome = watchingHome();
  abandonFreshSessionDirectories(project, true, privateHome, true);
  expect([projectHome.removals, privateHome.removals]).toEqual([0, 0]);
  abandonFreshSessionDirectories(project, false, privateHome, false);
  expect([projectHome.removals, privateHome.removals]).toEqual([1, 1]);
  expect(() => abandonFreshSessionDirectories(null, false, null, false)).not.toThrow();
});

test.each([new Error("remove refused"), "remove refused"])(
  "private-directory removal failures preserve the abort path: %s",
  (failure) => {
    const home = watchingHome();
    home.remove = () => { throw failure; };
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => abandonFreshSessionDirectories(null, false, home, false)).not.toThrow();
      expect(error).toHaveBeenCalledWith(expect.stringContaining("remove refused"));
      expect(error).toHaveBeenCalledWith(expect.stringContaining("the stale sweep removes it later"));
    } finally {
      error.mockRestore();
    }
  }
);
