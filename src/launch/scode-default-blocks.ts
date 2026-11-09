/**
 * scode's built-in default blocks, relative to the operator's HOME: the
 * DEFAULT_BLOCKED, LINUX_EXTRA_BLOCKED, and DARWIN_EXTRA_BLOCKED arrays of
 * the installed scode script (read 2026-11-09). Both platform lists apply
 * everywhere here: a caller home inside either is never a private
 * directory. tests/session-cli-harness-home-scode-defaults.test.ts compares
 * this table with an installed scode when one is present.
 *
 * Why codemux needs the list: scode re-allows an `--allow` path beneath a
 * blocked parent, and its final guards re-deny only config, project, CLI,
 * and defense blocks, not these defaults. A `--harness-home` granted
 * read-write inside `~/Library` would therefore reopen codemux's own
 * credential backups (review R420 M2).
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const SCODE_DEFAULT_BLOCKS = [
  // Personal files
  "Documents", "Desktop", "Pictures", "Downloads", "Music", "Movies", "Videos",
  // Cloud credentials
  ".aws", ".azure", ".config/gcloud", ".kube", ".docker", ".config/containers", ".oci",
  ".terraform.d", ".terraformrc", ".pulumi", ".config/pulumi", ".config/doctl", ".config/helm",
  ".config/rclone/rclone.conf", ".config/sops/age", ".vercel", ".netlify", ".config/railway",
  ".fly", ".config/fly", ".config/hcloud",
  // Cryptographic keys
  ".ssh", ".gnupg", ".pki",
  // Password managers
  ".1password", ".op", ".password-store", ".config/Bitwarden CLI", ".config/Bitwarden",
  ".local/share/keyrings", ".local/share/kwalletd",
  // Auth tokens
  ".npmrc", ".yarnrc", ".yarnrc.yml", ".bunfig.toml", ".netrc", ".git-credentials",
  ".config/git/credentials", ".pypirc", ".config/pip", ".config/pypoetry/auth.toml",
  ".gem/credentials", ".cargo/credentials", ".cargo/credentials.toml", ".m2/settings.xml",
  ".gradle/gradle.properties", ".nuget/NuGet/NuGet.Config", ".composer/auth.json",
  ".config/gh", ".config/hub", ".config/glab-cli", ".huggingface", ".cache/huggingface/token",
  // Shell and database histories
  ".bash_history", ".zsh_history", ".python_history", ".mysql_history", ".psql_history",
  ".sqlite_history",
  // Linux extras
  ".mozilla", ".config/google-chrome", ".config/chromium", ".config/BraveSoftware",
  ".thunderbird", ".config/Signal", ".var/app", "snap",
  // macOS extras: ~/Library is blocked wholesale
  "Library",
] as const;

/** Absolute default-blocked paths for the operator HOME scode will see. */
export function scodeDefaultBlockedPaths(home: string = process.env.HOME || homedir()): string[] {
  return SCODE_DEFAULT_BLOCKS.map((entry) => join(home, entry));
}
