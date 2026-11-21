// Documentation contracts fixed in review round 3 of 2.0.4: each statement
// here was missing or contradicted the code.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8");
const release = () => read("CHANGELOG.md").split("## [2.0.4]")[1]!.split("## [2.0.3]")[0]!;

test("agy's file token is documented as granted without the login-store opt-in", () => {
  for (const text of [read("docs/isolation.md"), read("docs/authentication.md"), release()]) {
    expect(text).toContain("antigravity-cli/antigravity-oauth-token");
    expect(text).toContain("agy's own state file, not the Keychain login store");
    expect(text).toContain("by exact path");
    expect(text).toContain("on every platform");
    expect(text).toMatch(/`--sandbox-trust untrusted` and `--sandbox-no-login-store` withhold it/);
  }
  expect(read("docs/isolation.md")).toContain("Agy's file token is not one of them");
  expect(read("docs/sessions.md")).toContain("Native file-token link, granted to the sandbox without opt-in");
});

test("the inaccessible-login notice is documented as macOS-only and Keychain-only", () => {
  const isolation = read("docs/isolation.md");
  expect(isolation).toContain("The notice is about the macOS Keychain only");
  expect(isolation).toContain("Outside macOS it never prints");
  expect(read("src/sandbox-login-policy.ts")).toContain("The notice is about the macOS Keychain only");
});

test("a plain sandboxed agy session's shared-entry grants are documented", () => {
  for (const text of [read("docs/authentication.md"), release()]) {
    expect(text).toContain("each shared entry the private home links to");
    expect(text).not.toContain("re-allows only its private home");
    expect(text).not.toContain("only the private home is re-allowed");
  }
});

test("2.0.3 agy session homes are documented as migrated, not as already linked", () => {
  for (const text of [read("docs/authentication.md"), release()]) {
    expect(text).toContain("rewrites the marker to `native`");
    expect(text).toContain("removes nothing");
  }
  expect(release()).not.toContain("verify as `native`");
});

test("--harness-home states the macOS Claude HOME exception and its reason", () => {
  const isolation = read("docs/isolation.md");
  expect(isolation).toContain("Claude on macOS is the one exception to the HOME redirect");
  expect(isolation).toContain("native login selector (`CLAUDE_SECURESTORAGE_CONFIG_DIR`");
  const sessions = read("docs/sessions.md");
  expect(sessions).toContain("Claude on macOS is the exception: `HOME` and `USERPROFILE` stay the operator's real home");
  expect(sessions).toContain("keeps the operator's real `HOME` so that selector resolves");
  // The code the documents describe.
  expect(read("src/session/harness-home.ts")).toContain('process.platform === "darwin" && input.agent === "claude"');
});

test("no document describes the scode CI pin as unchanged or 0.6.7", () => {
  const gate = read("docs/RELEASE-GATE.md");
  // Current pages name no commit hash (tests/documentation.test.ts); the changelog does.
  expect(gate).toContain("CI pins scode v0.6.8; the changelog records the pinned commit.");
  expect(gate).not.toMatch(/CI pin[^.]*0\.6\.7/);
  expect(gate).not.toContain("pin remains unchanged");
  expect(read(".github/workflows/ci.yml")).toContain("cc76ea3");
  expect(release()).toContain("CI builds scode v0.6.8 (commit `cc76ea3`)");
});

test("the uniform login-store record and its resume rule are documented", () => {
  const sessions = read("docs/sessions.md");
  expect(sessions).toContain("every session agent records them the same way");
  expect(sessions).toContain("The recorded grant is the effective one");
  // Round 4 replaced the refusal under a configured default with the recorded grant.
  expect(sessions).toContain("On resume the recorded grant applies, whatever the user config says");
  expect(sessions).not.toContain("resumes with `--sandbox-no-login-store`");
  expect(sessions).not.toContain("Both are no-ops for harnesses without native login grants");
});
