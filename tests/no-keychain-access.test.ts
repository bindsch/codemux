import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : entry.isFile() ? [join(dir, entry.name)] : []);
}

const forbidden = /(?:\/security\b|["'`]security["'`]|\bsecurity\s+(?:-[a-z]|\w+-\w+)|default-keychain|find-generic-password|add-generic-password|unlock-keychain|create-keychain|list-keychains)/i;
const retiredCredentialMutation = /\b(?:syncKeychainCredential|scrubbedCredential|pruneOlderBackups|defaultCredentialBackupDir|credentialBackupDir|credentialReader)\b|["'][^"']*credentials\/(?:sync|backups|oauth)\.[jt]s["']/;

test.each([
  'Bun.spawn(["security", "help"])', 'spawnSync("/usr/bin/security", [])',
  'exec("/bin/security -q")', 'const tool = `security`',
  "find-generic-password", "add-generic-password", "default-keychain", "unlock-keychain",
  "create-keychain", "list-keychains",
])("the source gate rejects native credential operations: %s", (source) => {
  expect(forbidden.test(source)).toBe(true);
});

test("release gate: source and scripts cannot invoke Keychain commands", () => {
  const violations = ["src", "scripts"].flatMap((dir) => files(join(import.meta.dir, "..", dir)))
    .flatMap((file) => readFileSync(file, "utf8").split("\n").flatMap((line, index) =>
      forbidden.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : []));
  expect(violations).toEqual([]);
});

test.each([
  "syncKeychainCredential(service, target)", "scrubbedCredential(secret)",
  "pruneOlderBackups(backupDir)", "defaultCredentialBackupDir()", "this.credentialReader(service)",
  'import { sync } from "./credentials/sync.js"',
])("the source gate rejects retired login mutation code: %s", (source) => {
  expect(retiredCredentialMutation.test(source)).toBe(true);
});

test("release gate: source and scripts contain no credential sync, scrub, or backup path", () => {
  const violations = ["src", "scripts"].flatMap((dir) => files(join(import.meta.dir, "..", dir)))
    .filter((file) => /\.[cm]?[jt]s$/.test(file))
    .flatMap((file) => readFileSync(file, "utf8").split("\n").flatMap((line, index) =>
      retiredCredentialMutation.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : []));
  expect(violations).toEqual([]);
});

test("credential target and adapter helpers have no filesystem mutation capability", () => {
  for (const path of ["src/credentials.ts", "src/adapters/claude-credentials.ts", "src/claude-login.ts"]) {
    const source = readFileSync(join(import.meta.dir, "..", path), "utf8");
    expect(source).not.toMatch(/(?:Bun\.write|writeFile|unlink|rename|copyFile|mkdir|chmod|truncate)/);
  }
});

test("the only Claude credential-file writer is guarded off on macOS before file operations", () => {
  const copy = join(import.meta.dir, "../src/claude-credential-mirror.ts");
  const writers = ["src", "scripts"].flatMap((dir) => files(join(import.meta.dir, "..", dir)))
    .filter((file) => /\.[cm]?[jt]s$/.test(file))
    .filter((file) => /(?:writePrivateFile|writeFileSync|writeFile|copyFile|Bun\.write)\([^;]*?["']\.credentials\.json["']/s.test(readFileSync(file, "utf8")));
  expect(writers).toEqual([copy]);
  const source = readFileSync(copy, "utf8");
  const body = source.slice(source.indexOf("export function copyClaudeCredentialMirror"));
  const guard = body.indexOf('if (platform === "darwin") return;');
  expect(guard).toBeGreaterThan(0);
  for (const operation of ["lstatSync(", "openSync(", "readSync(", "writePrivateFile(", "removeStaleCredentialCopy("]) {
    expect(body.indexOf(operation)).toBeGreaterThan(guard);
  }
});
