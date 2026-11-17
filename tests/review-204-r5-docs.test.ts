// Review round 5: documentation findings, each pinned to the code's behavior.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const release = (): string => {
  const changelog = read("CHANGELOG.md");
  const start = changelog.indexOf("## [2.0.4]");
  return changelog.slice(start, changelog.indexOf("\n## [", start + 1));
};

test("empty Kimi token fields are documented as LOGIN-UNKNOWN, never NO-LOGIN", () => {
  // contracts 1, contracts-2 2: doctor prints LOGIN-UNKNOWN for that store
  // (tests/doctor-login-usage.test.ts), and both pages said NO-LOGIN.
  const row = read("docs/machine-check.md").split("\n").find((line) => line.startsWith("| `NO-LOGIN`"))!;
  expect(row).not.toMatch(/such as readable empty Kimi token fields/);
  expect(row).toContain("empty token fields is not this row");
  expect(row).toContain("`LOGIN-UNKNOWN`");
  const entry = release().split("\n").find((line) => line.includes("`NO-LOGIN` remains"))!;
  expect(entry).toContain("`NO-LOGIN` remains only for a missing or refused Z.AI key file");
  expect(entry).toContain("empty token fields reports `LOGIN-UNKNOWN`");
  expect(release()).not.toContain("such as empty Kimi token fields");
});

test("the configuration page says a removed opt-in does not revoke a session's recorded grant", () => {
  // contracts 2: resumedLoginStoreGrant returns the recorded grant whatever the config says.
  const page = read("docs/configuration.md");
  expect(page).not.toContain("Removing the key restores the default denial.");
  expect(page).toContain("for new launches and new sessions");
  expect(page).toContain("a resumed session keeps its recorded grant whatever the config says");
  expect(page).toContain("`--sandbox-no-login-store`");
});

test("the Kimi pages describe the shared refresh-lock directory and no launch serialization", () => {
  const pages = ["docs/authentication.md", "docs/isolation.md", "docs/sessions.md", "docs/troubleshooting.md"];
  for (const page of pages) {
    const text = read(page);
    expect(text, page).toContain("oauth");
    expect(text, page).not.toMatch(/serializes Kimi launches|cross-process `flock`|credentials lock until it exits/);
  }
  expect(read("docs/authentication.md")).toContain("Codemux holds no lock of its own while a Kimi child runs");
  expect(read("docs/authentication.md")).toContain("KIMI_DISABLE_OAUTH_LOCK");
  const notes = release();
  expect(notes).not.toMatch(/Kimi launches sharing a canonical credentials directory are serialized/);
  expect(notes).not.toContain("credential-lock waits");
  expect(notes).not.toContain("wait for the Kimi credential lock");
  expect(notes).toContain("links `oauth` to the real brand home's `oauth` directory");
  expect(notes).toContain("start without waiting");
  // The lifetime lock's modules are gone.
  for (const path of ["src/kimi-auth-lock.ts", "src/session/kimi-locked-process.ts", "tests/fixtures/kimi-lock-worker.ts"]) {
    expect(existsSync(join(root, path)), path).toBe(false);
  }
  for (const path of ["src/process-runner.ts", "src/session/process.ts", "src/output-probe.ts", "src/cli-runtime.ts"]) {
    expect(read(path), path).not.toContain("credentialLockFd");
  }
});

test("the scrub table and the session page state the selector and the recorded-restriction rules", () => {
  const sandboxing = read("docs/autonomy-and-sandboxing.md");
  expect(sandboxing).toContain("`CLAUDE_SECURESTORAGE_CONFIG_DIR` it injects selects a Keychain item and is not a credential");
  expect(read("docs/sessions.md")).toContain("For every other agent the restriction changes no sandbox grant, so resuming without it is accepted");
});
