import { expect, test } from "bun:test";
import { getDefaultConfig } from "../src/config.js";
import type { HarnessRow } from "../src/doctor-model.js";
import type { CodemuxConfig } from "../src/types.js";
import { createFakeBinaryEnv } from "./helpers/cli.js";
import { cleanupFixtureHomes, fakeScodeHelp, fixtureHome, runDoctor } from "./helpers/doctor.js";

for (const platform of ["darwin", "linux"] as const) {
  test(`doctor reports the configured native sandbox login store on ${platform} without changing severity`, async () => {
    const previousPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const homes: string[] = [];
    const fake = createFakeBinaryEnv({
      scode: fakeScodeHelp(),
      claude: "printf '2.1.300 (Claude Code)\\n'",
      agy: "printf '1.20.0\\n'",
      codex: "printf 'codex-cli 0.166.0\\n'",
    });
    const home = fixtureHome({}, homes);
    try {
      Object.defineProperty(process, "platform", { value: platform });
      const policies: [Partial<CodemuxConfig>, string][] = [
        [{}, "disabled"],
        [{ sandboxLoginStore: false }, "disabled"],
        [{ sandboxNoLoginStore: false }, "disabled"],
        [{ sandboxLoginStore: true }, "enabled"],
        [{ sandboxLoginStore: true, sandboxNoLoginStore: false }, "enabled"],
        [{ sandboxLoginStore: true, sandboxNoLoginStore: true }, "disabled"],
      ];
      let baseline: string | undefined;
      for (const [policy, expected] of policies) {
        const result = await runDoctor(["--only", "claude,agy,codex", "--format", "json", "--strict"], {
          path: fake.env.PATH!, home,
          config: { ...getDefaultConfig(), quota: false, ...policy },
        });
        const report = JSON.parse(result.output) as { harnesses: HarnessRow[]; summary: unknown };
        expect(report.harnesses).toHaveLength(3);
        for (const row of report.harnesses) {
          const facts = row.detail.filter((line) => line.startsWith("sandbox login store:"));
          expect(facts).toEqual(platform === "darwin" && row.id !== "codex"
            ? [`sandbox login store: ${expected} (effective configuration)`] : []);
        }
        const outcome = JSON.stringify({
          exitCode: result.exitCode,
          summary: report.summary,
          rows: report.harnesses.map(({ id, severity, state, remedy }) => ({ id, severity, state, remedy })),
        });
        baseline ??= outcome;
        expect(outcome).toEqual(baseline);
      }
    } finally {
      Object.defineProperty(process, "platform", previousPlatform);
      fake.cleanup();
      cleanupFixtureHomes(homes);
    }
  });
}
