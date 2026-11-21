import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IDS } from "../src/types.js";
import { agentsSupporting } from "../src/parity/index.js";
import { remedyFor } from "../src/doctor-remedies.js";

const read = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8");
test.each(["docs/isolation.md", "docs/authentication.md", "docs/autonomy-and-sandboxing.md",
  "docs/cli.md", "README.md", "CHANGELOG.md"])("%s states the full login-store exposure and alternatives", (file) => {
  const source = read(file);
  const text = file === "CHANGELOG.md" ? source.split("## [2.0.4]")[1]!.split("## [2.0.3]")[0]! : source;
  for (const phrase of ["Native login-store access is off by default", "--sandbox-login-store", "sandboxLoginStore: true",
    "every process inside the sandbox", "access list trusts `/usr/bin/security` without a dialog",
    "refresh token", "tokens other tools stored through `security`", "GitHub CLI token", "create, modify, or delete files",
    "read and copy `login.keychain-db`", "encrypted with the account login password", "attack it offline",
    "read-only when it exists", "cannot change the default keychain or search list through that preference file",
    "Library/Keychains", "Library/Preferences/com.apple.security.plist", "--sandbox-no-login-store",
    "sandboxNoLoginStore: true", "overrides any opt-in", "provider overrides, and Z.AI never receive",
    "--sandbox-trust untrusted", "A Keychain login cannot then be used", "staged-file", "refresh-lock",
    "use and refresh its existing login in place", "never runs `security`", "not read, copy, or change"]) {
    expect(text, phrase).toContain(phrase);
  }
  if (file === "CHANGELOG.md") {
    expect(text).toContain("### Security");
    expect(text).toContain("### Changed");
  }
});

test("CLI and parity cover opt-in and denial on every harness and launch surface", () => {
  const cli = read("docs/cli.md");
  for (const flag of ["sandbox-login-store", "sandbox-no-login-store"] as const) {
    const row = cli.split("\n").find((line) => line.startsWith(`| \`--${flag}\``))!;
    expect(row).toContain("run, session, tui, and check for every harness, including check canaries");
    expect(row).toContain("no grant changes where the harness has no native login grant");
    expect(row.toLowerCase()).toContain("scode 0.6.8+");
    expect(row.toLowerCase()).toContain("older scode receives");
    for (const mode of ["run", "session", "tui", "check"] as const) {
      expect(agentsSupporting(`${mode}.${flag}`).sort()).toEqual([...AGENT_IDS].sort());
    }
  }
  expect(cli).toContain("`--login-store` only when the grant is effective; otherwise `--no-login-store`");
});

test("existing security preferences require read-only scode support", () => {
  for (const file of ["docs/isolation.md", "docs/authentication.md", "docs/autonomy-and-sandboxing.md", "docs/cli.md"]) {
    const text = read(file);
    expect(text).toContain("scode 0.6.7+");
    expect(text.toLowerCase()).toContain("older versions refuse");
  }
});

test("user config defaults off and denial overrides every opt-in", () => {
  const config = read("docs/configuration.md");
  for (const phrase of ["sandboxLoginStore: false", "sandboxNoLoginStore: false", "boolean, false by default",
    "user/global config", "Project configuration cannot enable the grant", "even if the opt-in flag or config is true"]) {
    expect(config).toContain(phrase);
  }
});

test("session records cannot acquire a previously absent login grant", () => {
  const sessions = read("docs/sessions.md");
  for (const phrase of ["sandbox_login_store", "sandbox_no_login_store", "defaults off",
    "resume cannot enable a grant absent from the original session", "can tighten access",
    "A configured `sandboxLoginStore: true` never refuses a resume", "Records written before 2.0.4 lack the field",
    "the flag changes nothing and never refuses", "Resume can add the restriction; a Claude or agy session recorded with `--sandbox-no-login-store` refuses a resume without it", "once per session"]) {
    expect(sessions).toContain(phrase);
  }
});

test.each(["README.md", "CHANGELOG.md", "docs/authentication.md"])("%s explains the 2.0.3 upgrade", (file) => {
  for (const phrase of ["Upgrade from 2.0.3", "read the Keychain and copied a short-lived Claude access token on every launch",
    "Version 2.0.4 never reads it", "Sandboxed macOS Claude and agy", "every launch, once per session",
    "even when redirected", "denied-grant limitation"]) {
    const text = read(file).replaceAll("including when redirected", "even when redirected");
    expect(text).toContain(phrase);
  }
});

test("release gate and troubleshooting distinguish denied access from logout", () => {
  const gate = read("docs/RELEASE-GATE.md").split("\n").find((line) => line.startsWith("| Native login-store exposure and opt-in"))!;
  for (const phrase of ["--sandbox-login-store", "--sandbox-no-login-store", "every harness and launch surface",
    "TTY-only", "uppercase staging conflicts", "refresh tokens", "offline attack", "read-only",
    "once per session even with redirected stderr", "cannot enable an originally absent grant"]) expect(gate).toContain(phrase);
  const troubleshooting = read("docs/troubleshooting.md");
  expect(troubleshooting).toContain("This does not mean the account is logged out");
  expect(troubleshooting).toContain("Native authentication advice repeats the denied-grant limitation");
});

// Review round 4, contracts-2: the release notes and docs against the code.
const release = () => read("CHANGELOG.md").split("## [2.0.4]")[1]!.split("## [2.0.3]")[0]!;

test("the 2.0.4 notes carry the registry downgrade cost the format comment promises", () => {
  for (const phrase of ["`sandbox_login_store` and `sandbox_no_login_store`", "Older binaries reject the new record shape",
    "Do not share a registry with an older codemux installation"]) expect(release()).toContain(phrase);
  expect(read("src/session/registry/format.ts")).toContain("documented in the release notes (CHANGELOG)");
});

test("the 2.0.4 notes name the health and doctor changes for every harness", () => {
  for (const phrase of ["for any harness", "`LOGIN-UNKNOWN`", "Codex's `auth.json`", "Cursor, OpenCode, and Pi",
    "Gemini, Goose, and Copilot", "no longer skips those accounts", "except the Z.AI key-file command"]) {
    expect(release()).toContain(phrase);
  }
});

test("the 2.0.4 notes state the agy file-token block rule the sandbox applies", () => {
  expect(release()).not.toContain("a caller's `--sandbox-block` over it wins.");
  expect(release()).toContain("Without the login-store opt-in, a caller's `--sandbox-block` over it wins");
  expect(release()).toContain("with `--sandbox-login-store`, a caller block over the token conflicts with the requested grant and the launch is refused");
});

test("the NO-LOGIN row in docs/machine-check.md matches the remedies table", () => {
  const row = read("docs/machine-check.md").split("\n").find((line) => line.startsWith("| `NO-LOGIN`"))!;
  expect(row).not.toContain("supplies no login advice");
  expect(row).toContain("the one remedy is for a missing or refused Z.AI key file");
  const remedies = AGENT_IDS.filter((agent) => remedyFor(agent, "NO-LOGIN") !== null);
  expect(remedies).toEqual(["zai"]);
  for (const agent of AGENT_IDS) expect(remedyFor(agent, "LOGIN-EXPIRED")).toBeNull();
});
