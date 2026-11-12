import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";

// The account home from the password database, never from HOME. Bun's
// os.userInfo().homedir returns HOME, so this mirrors scode 0.6.6's own
// lookup: dscl on macOS, /etc/passwd by uid on Linux.

let cached: string | null | undefined;

function lookup(): string | null {
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  let home: string | undefined;
  if (process.platform === "darwin") {
    const user = spawnSync("/usr/bin/id", ["-un"], { encoding: "utf8" }).stdout?.trim();
    if (!user) return null;
    const line = spawnSync("/usr/bin/dscl", [".", "-read", `/Users/${user}`, "NFSHomeDirectory"], { encoding: "utf8" }).stdout ?? "";
    // Same parse as scode (${line#NFSHomeDirectory: }). A home with spaces
    // prints on the next line; scode then falls back to HOME and adds no
    // account-home block, and this returns null, so neither side blocks.
    home = line.replace(/^NFSHomeDirectory: /, "").replace(/\n$/, "");
  } else if (process.platform === "linux") {
    for (const entry of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const fields = entry.split(":");
      if (fields.length >= 7 && Number(fields[2]) === uid) { home = fields[5]; break; }
    }
  }
  // scode's validity rule: absolute, not /, a directory the user owns.
  if (!home || !home.startsWith("/") || home === "/" || /[\0-\x1f\x7f]/.test(home)) return null;
  const stat = statSync(home, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.uid !== uid) return null;
  return realpathSync(home);
}

/** The canonical account home, or null when it cannot be established. */
export function accountHome(): string | null {
  if (cached === undefined) {
    try { cached = lookup(); } catch { cached = null; }
  }
  return cached;
}
