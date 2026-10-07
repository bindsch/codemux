/**
 * The recorded live fixtures are committed to a public repository, and
 * the fixtures README promises the operator's home is sanitized. Review
 * live19 found a derived spelling that survived: claude's dash-encoded
 * project slug (`-Users-<name>-<repo path>`) in every zai init frame.
 * This scan reads the identity from the machine running it, never from a
 * hardcoded list, and refuses any spelling of it in tests/fixtures/live.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const FIXTURES = join(import.meta.dir, "fixtures", "live");
const REPO = resolve(import.meta.dir, "..");

function fixtureFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? fixtureFiles(path) : [path];
  });
}

/** The main checkout when this tree is a git worktree, from the common
 * git dir; null when git or the repository is unavailable. */
function mainCheckout(): string | null {
  const probe = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (probe.exitCode !== 0) return null;
  return dirname(probe.stdout.toString().trim());
}

/** Claude's project slug for a path: every `/` and `.` becomes `-`. */
function slug(path: string): string {
  return path.replace(/[/.]/g, "-");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every spelling of the operator's identity a fixture must not carry:
 * the home path and its slug, the username, the home's components below
 * the top-level root, and each checkout's path below the home in both
 * spellings, with its directory components. The checkout's own directory
 * name is the project's name and legitimately appears in the wire
 * (`codemux-probe`), so it is excluded as a lone component. */
function forbiddenSpellings(): string[] {
  const home = homedir();
  const words = new Set<string>();
  const strings = new Set<string>([home, slug(home)]);
  const username = userInfo().username;
  if (username.length >= 3) words.add(username);
  for (const part of home.split(sep).filter((entry) => entry !== "").slice(1)) words.add(part);
  for (const checkout of [REPO, mainCheckout()]) {
    if (checkout === null) continue;
    const below = relative(home, checkout);
    if (below === "" || below.startsWith("..")) continue;
    strings.add(below);
    strings.add(slug(below));
    for (const part of below.split(sep)) {
      if (part !== basename(checkout) && part.length >= 3) words.add(part);
    }
  }
  return [
    ...[...strings].map((text) => escapeRegExp(text)),
    ...[...words].map((word) => `(?<![A-Za-z0-9])${escapeRegExp(word)}(?![A-Za-z0-9])`),
  ];
}

describe("live fixtures carry no operator identity (review live19)", () => {
  test("no spelling of the home, username, or checkout path appears in tests/fixtures/live", () => {
    const patterns = forbiddenSpellings().map((source) => new RegExp(source));
    const hits: string[] = [];
    for (const file of fixtureFiles(FIXTURES)) {
      const text = readFileSync(file, "utf8");
      for (const pattern of patterns) {
        if (pattern.test(text)) hits.push(`${relative(REPO, file)} matches ${pattern.source}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
