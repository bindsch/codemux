// Synthetic device-state launches only. Never invokes an installed harness.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginKimiPrivateState, withKimiPrivateState } from "../../src/kimi-auth-state.js";

const [brand, mode] = process.argv.slice(2) as [string, string];
const command = ["env", `KIMI_CODE_HOME=${brand}`, "kimi"];
if (mode === "abort") {
  // The abort path: state the harness created, then process.exit with the
  // launch still open and no explicit end.
  beginKimiPrivateState(command, {}, process.cwd());
  writeFileSync(join(brand, "device_id"), "native-before-abort");
  process.exit(3);
}
// "nested": a launch of the same home from inside a running Kimi child.
await withKimiPrivateState(command, {}, process.cwd(), async () => { process.stdout.write("inner-done\n"); });
