import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";

// The account home from the password database, never from HOME. Bun's
// os.userInfo().homedir returns HOME, so this reads what scode 0.6.6 reads:
// dscl on macOS, /etc/passwd by uid on Linux.

let cached: string | null | undefined;
let cachedForScode: string | null | undefined;

/**
 * The value in `dscl . -read /Users/<name> NFSHomeDirectory` output. dscl
 * prints a value without spaces on the key's line (`NFSHomeDirectory: /Users/a`)
 * and a value with spaces on the next line, indented by one space
 * (`NFSHomeDirectory:\n /Users/a b`). Null when the output has no such key.
 */
export function parseDsclHome(output: string): string | null {
  const match = /^NFSHomeDirectory:(?: ([^\n]*)|\n ([^\n]*))\n?$/.exec(output);
  return match === null ? null : (match[1] ?? match[2] ?? null);
}

/** scode's own parse of the same output (${line#NFSHomeDirectory: }): it
 * reads the one-line form only, and falls back to HOME for the other. */
function parseDsclHomeAsScode(output: string): string {
  return output.replace(/^NFSHomeDirectory: /, "").replace(/\n$/, "");
}

function lookup(scodeParse = false): string | null {
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  let home: string | undefined;
  if (process.platform === "darwin") {
    const user = spawnSync("/usr/bin/id", ["-un"], { encoding: "utf8" }).stdout?.trim();
    if (!user) return null;
    const line = spawnSync("/usr/bin/dscl", [".", "-read", `/Users/${user}`, "NFSHomeDirectory"], { encoding: "utf8" }).stdout ?? "";
    home = scodeParse ? parseDsclHomeAsScode(line) : parseDsclHome(line) ?? undefined;
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

/** The account home as scode itself reads it, for the account-home block
 * (sandbox.ts). A home with spaces prints on the next line; scode then
 * falls back to HOME and adds no account-home block, and this returns
 * null, so neither side blocks. */
export function scodeAccountHome(): string | null {
  if (cachedForScode === undefined) {
    try { cachedForScode = lookup(true); } catch { cachedForScode = null; }
  }
  return cachedForScode;
}
