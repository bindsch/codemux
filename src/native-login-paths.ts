import { existsSync } from "node:fs";
import { join } from "node:path";

export const NATIVE_LOGIN_PATHS = ["Library/Keychains", "Library/Preferences/com.apple.security.plist"] as const;

/** Native harnesses read and refresh their own login, including database sidecars. */
export function nativeLoginPaths(home: string, platform = process.platform): string[] {
  if (platform !== "darwin") return [];
  return NATIVE_LOGIN_PATHS.map((relative) => join(home, relative)).filter(existsSync);
}
