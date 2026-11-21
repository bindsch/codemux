// Holds the migration lock of a synthetic 2.0.3 agy home, then migrates it.
// Never invokes an installed harness.
import { writeSync } from "node:fs";
import { migrateLegacyAgyHome } from "../../src/session/agy-legacy-home.js";

const [dir, source, holdMs] = process.argv.slice(2) as [string, string, string];
const migrated = migrateLegacyAgyHome(dir, source, "darwin", {
  held: () => { writeSync(1, "held\n"); Bun.sleepSync(Number(holdMs)); },
});
process.exit(migrated ? 0 : 4);
