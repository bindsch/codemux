import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { setup, cleanupAgyIsolation } from "./helpers/agy-isolation-setup.js";
afterEach(cleanupAgyIsolation);
test("symlinked Gemini configuration supports absent and existing probe roots", () => {
  const { home, adapter, request } = setup();
  const configuration = join(home, "dotfiles-gemini");
  fs.mkdirSync(configuration);
  fs.symlinkSync(configuration, join(home, ".gemini"));
  expect(adapter.prepareRun({ ...request, sandboxed: false })).toEqual({});
  for (const hermetic of [false, true]) {
    const context = adapter.prepareRun({ ...request, hermetic });
    const privateHome = context.agyProbe!.home!;
    expect(privateHome.startsWith(fs.realpathSync(configuration))).toBe(true);
    adapter.cleanupRunSync(context);
    expect(fs.existsSync(privateHome)).toBe(false);
  }
});
