import type { SessionPrivateHome } from "./private-home-types.js";
import { isCallerHarnessHome } from "./harness-home.js";

/** The driver still owns the record and has settled every child. Keep
 * ownership through both removal attempts; release and stamp afterward. */
export function removeFinalPrivateHome(home: SessionPrivateHome | null | undefined): boolean {
  if (home == null || isCallerHarnessHome(home)) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (home.remove()) return true;
    } catch (error) {
      console.error(`codemux: could not remove the session's private home ${home.dir}: ${String(error)}`);
    }
  }
  return false;
}
