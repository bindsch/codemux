import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDsclHome } from "../src/account-home.js";
import { KEYCHAIN_DIRECTORY, LOGIN_KEYCHAIN, SECURITY_PREFERENCES, defaultKeychainResolves, guardChildKeychainHomes, linkAccountKeychain } from "../src/darwin-keychain-home.js";
import { PLUTIL, expandRecordedKeychain, recordedDefaultKeychain, recordedKeychain } from "../src/darwin-keychain-preferences.js";
import { UsageRefusalError } from "../src/validation.js";
import { NO_DEFAULT_KEYCHAIN, darwinWith, defaultKeychain, fakeAccountHome, scratchRoot } from "./helpers/keychain-home.js";

// A home's keychain preference file, and the directory-service output
// the account home is read from. Nothing here touches a keychain: the
// preference files are fixtures, read with plutil (a stand-in script on
// every platform, and the real /usr/bin/plutil on macOS).
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("parseDsclHome", () => {
  test("a home without spaces is on the key's line", () => {
    expect(parseDsclHome("NFSHomeDirectory: /Users/alex\n")).toBe("/Users/alex");
    expect(parseDsclHome("NFSHomeDirectory: /Users/alex")).toBe("/Users/alex");
  });

  test("a home with spaces is on the following line, indented by one space", () => {
    expect(parseDsclHome("NFSHomeDirectory:\n /Users/alex smith\n")).toBe("/Users/alex smith");
    expect(parseDsclHome("NFSHomeDirectory:\n /Volumes/My Disk/Home Folders/alex\n")).toBe("/Volumes/My Disk/Home Folders/alex");
    // Inner and trailing spaces belong to the path.
    expect(parseDsclHome("NFSHomeDirectory:\n /Users/a  b \n")).toBe("/Users/a  b ");
  });

  test("output without the key, or with more than one value, gives no home", () => {
    expect(parseDsclHome("")).toBeNull();
    expect(parseDsclHome("No such key: NFSHomeDirectory\n")).toBeNull();
    expect(parseDsclHome("<dscl_cmd> DS Error: -14136 (eDSRecordNotFound)\n")).toBeNull();
    expect(parseDsclHome("NFSHomeDirectory:\n /Users/a b\n /Users/c d\n")).toBeNull();
    expect(parseDsclHome("RealName: NFSHomeDirectory: /Users/alex\n")).toBeNull();
  });
});

describe("expandRecordedKeychain (no files)", () => {
  const present = (...paths: string[]) => (path: string): boolean => paths.includes(path);
  test("~/ names are read against the home; absolute names are kept", () => {
    expect(expandRecordedKeychain("/h", "~/Library/Keychains/a.keychain-db", present())).toBe("/h/Library/Keychains/a.keychain-db");
    expect(expandRecordedKeychain("/h", "/elsewhere/a.keychain-db", present())).toBe("/elsewhere/a.keychain-db");
  });
  test("a missing .keychain name stands for its -db file; an existing one is kept", () => {
    expect(expandRecordedKeychain("/h", "~/Library/Keychains/login.keychain", present())).toBe("/h/Library/Keychains/login.keychain-db");
    expect(expandRecordedKeychain("/h", "~/Library/Keychains/login.keychain", present("/h/Library/Keychains/login.keychain")))
      .toBe("/h/Library/Keychains/login.keychain");
    expect(expandRecordedKeychain("/h", "~/Library/Keychains/x.keychain-db", present())).toBe("/h/Library/Keychains/x.keychain-db");
  });
});

// The stand-in answers as plutil does, for fixtures written as text:
// `DbName0=<path>` is a DefaultKeychain array whose element zero is a
// dictionary with that string DbName; `ARRAY_EMPTY`, `ARRAY_STRING` and
// `ARRAY_NO_NAME` are arrays without a usable first element; `DICT` is a
// dictionary-shaped DefaultKeychain; any other content has no such key,
// as an unparsable file has none for the real tool. The same lines with a
// `Login` prefix (`LoginDbName0=`, `LoginARRAY_EMPTY`) describe the
// LoginKeychain key. It also answers the `-type k -` capability question.
const FAKE_PLUTIL = `#!/bin/sh
for last; do :; done
has() { grep -q "$1" "$last"; }
[ "$1" = "-lint" ] && exit 0
[ "$1 $2 $3" = "-type k -" ] && { echo array; exit 0; }
case "$2" in DefaultKeychain*) p="";; LoginKeychain*) p="Login";; *) exit 2;; esac
sub="\${2#*Keychain}"
case "$1 $sub" in
  "-type ") if has "^\${p}DbName0=" || has "^\${p}ARRAY_"; then echo array; elif has "^\${p}DICT"; then echo dictionary; else exit 1; fi;;
  "-type .0") if has "^\${p}DbName0=" || has "^\${p}ARRAY_NO_NAME"; then echo dictionary; elif has "^\${p}ARRAY_STRING"; then echo string; else exit 1; fi;;
  "-type .0.DbName") if has "^\${p}DbName0="; then echo string; else exit 1; fi;;
  "-extract .0.DbName") has "^\${p}DbName0=" || exit 1; sed -n "s/^\${p}DbName0=//p" "$last";;
  *) exit 2;;
esac
`;

function fixture(): { root: string; account: string; home: string; file: string; plutil: string } {
  const root = scratchRoot("keychain-preferences");
  roots.push(root);
  const home = join(root, "private");
  mkdirSync(join(home, dirname(SECURITY_PREFERENCES)), { recursive: true });
  const plutil = join(root, "plutil");
  writeFileSync(plutil, FAKE_PLUTIL);
  chmodSync(plutil, 0o755);
  return { root, account: fakeAccountHome(root), home, file: join(home, SECURITY_PREFERENCES), plutil };
}
const refusal = (run: () => unknown): Error => {
  let thrown: unknown;
  try { run(); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(UsageRefusalError);
  return thrown as Error;
};

describe("a home's keychain preference file (stand-in plutil)", () => {
  test("no file, an empty file, and a file without a recorded name record none and do not refuse", () => {
    const f = fixture();
    const read = () => recordedDefaultKeychain(f.home, SECURITY_PREFERENCES, f.plutil);
    expect(read()).toEqual({ kind: "none" });
    for (const content of ["", "DLDBSearchList=only\n", "not a property list\n", "DICT\nDbName=~/Library/Keychains/gone.keychain-db\n"]) {
      writeFileSync(f.file, content);
      expect(read()).toEqual({ kind: "none" });
      expect(linkAccountKeychain(f.home, { ...darwinWith(f.account), plutil: f.plutil })).toMatch(/linked|resolves/);
    }
  });

  test("a recorded path with a parent segment is not judged: folding it could name a file macOS cannot reach (review round 22)", () => {
    for (const content of ["DbName0=~/missing/../Library/Keychains/login.keychain-db\n", "DbName0=/missing/../etc/x.keychain-db\n"]) {
      const f = fixture();
      writeFileSync(f.file, content);
      expect(recordedDefaultKeychain(f.home, SECURITY_PREFERENCES, f.plutil)).toEqual({ kind: "unusable", file: f.file });
    }
  });

  test("an array without a usable first element records no default keychain: refused, with no fallback to the login keychain", () => {
    for (const content of ["ARRAY_EMPTY\n", "ARRAY_STRING\n", "ARRAY_NO_NAME\n", "DbName0=\n"]) {
      const f = fixture();
      writeFileSync(f.file, content);
      expect(recordedDefaultKeychain(f.home, SECURITY_PREFERENCES, f.plutil)).toEqual({ kind: "unusable", file: f.file });
      const options = { ...darwinWith(f.account), plutil: f.plutil };
      expect(defaultKeychainResolves(f.home, options)).toBe(false);
      const message = refusal(() => linkAccountKeychain(f.home, options)).message;
      expect(message).toContain(`the preference file records no default keychain: ${f.file}`);
      // The login keychain is linked and present, and still does not count.
      expect(existsSync(join(f.home, KEYCHAIN_DIRECTORY, LOGIN_KEYCHAIN))).toBe(true);
    }
  });

  test("a recorded name that is relative, or has a control character, is unusable although the file it resembles exists", () => {
    // A relative name resolves against another directory in the child, and
    // a trailing tab or newline names a different, missing file.
    for (const recorded of ["Library/Keychains/login.keychain-db", "login.keychain-db", "~/Library/Keychains/login.keychain-db\t"]) {
      const f = fixture();
      writeFileSync(f.file, `DbName0=${recorded}\n`);
      expect(recordedDefaultKeychain(f.home, SECURITY_PREFERENCES, f.plutil)).toEqual({ kind: "unusable", file: f.file });
      const options = { ...darwinWith(f.account), plutil: f.plutil };
      expect(refusal(() => linkAccountKeychain(f.home, options)).message).toContain("records no default keychain");
    }
    // The reader keeps a trailing newline the tool printed inside the value.
    const f = fixture();
    const newline = join(f.root, "plutil-newline");
    const printsNewline = FAKE_PLUTIL.replace(/\/\/p" "\$last";;/, '//p" "$last"; echo;;');
    expect(printsNewline).not.toBe(FAKE_PLUTIL);
    writeFileSync(newline, printsNewline);
    chmodSync(newline, 0o755);
    writeFileSync(f.file, "DbName0=~/Library/Keychains/login.keychain-db\n");
    expect(recordedDefaultKeychain(f.home, SECURITY_PREFERENCES, newline)).toEqual({ kind: "unusable", file: f.file });
  });

  test("a home with its own keychain directory and a broken record is refused for the record, not for the directory (review round 7)", () => {
    const f = fixture();
    mkdirSync(join(f.home, KEYCHAIN_DIRECTORY), { recursive: true });
    writeFileSync(join(f.home, KEYCHAIN_DIRECTORY, LOGIN_KEYCHAIN), "");
    writeFileSync(f.file, "DbName0=~/Library/Keychains/gone.keychain-db\n");
    const message = refusal(() => linkAccountKeychain(f.home, { ...darwinWith(f.account), plutil: f.plutil })).message;
    expect(message).toContain("the recorded default keychain does not exist");
    expect(message).not.toContain("is a directory with its own content");
  });

  test("a recorded login keychain is held to the same rule; a valid default record does not excuse it", () => {
    const cases: Array<[string, string]> = [
      ["LoginDbName0=~/Library/Keychains/gone.keychain-db\n", "the recorded login keychain does not exist"],
      ["LoginARRAY_EMPTY\n", "the preference file records no login keychain"],
      ["DbName0=~/Library/Keychains/login.keychain-db\nLoginDbName0=~/Library/Keychains/gone.keychain-db\n", "the recorded login keychain does not exist"],
    ];
    for (const [content, reason] of cases) {
      const f = fixture();
      writeFileSync(f.file, content);
      const options = { ...darwinWith(f.account), plutil: f.plutil };
      expect(defaultKeychainResolves(f.home, options)).toBe(false);
      expect(refusal(() => linkAccountKeychain(f.home, options)).message).toContain(reason);
    }
    const f = fixture();
    writeFileSync(f.file, "LoginDbName0=~/Library/Keychains/login.keychain-db\n");
    expect(linkAccountKeychain(f.home, { ...darwinWith(f.account), plutil: f.plutil })).toMatch(/linked|resolves/);
    expect(recordedKeychain(f.home, SECURITY_PREFERENCES, "LoginKeychain", f.plutil)).toMatchObject({ kind: "recorded", exists: true });
  });

  test("a plutil that does not run to an exit status leaves the record unread: refused (review round 11)", () => {
    // Killed by a signal: no answer about the file, so not "nothing recorded".
    const f = fixture();
    const killed = join(f.root, "plutil-killed");
    writeFileSync(killed, "#!/bin/sh\nkill -KILL $$\n");
    chmodSync(killed, 0o755);
    writeFileSync(f.file, "DbName0=~/Library/Keychains/gone.keychain-db\n");
    expect(recordedDefaultKeychain(f.home, SECURITY_PREFERENCES, killed)).toEqual({ kind: "unreadable", file: f.file });
    expect(defaultKeychainResolves(f.home, { ...darwinWith(f.account), plutil: killed })).toBe(false);
  });

  test("a preference file that cannot be read, or a plutil without -type, cannot be checked: refused", () => {
    if (process.getuid?.() !== 0) {
      for (const content of ["", "DbName0=~/Library/Keychains/login.keychain-db\n"]) {
        const f = fixture();
        writeFileSync(f.file, content);
        chmodSync(f.file, 0o000);
        const options = { ...darwinWith(f.account), plutil: f.plutil };
        try {
          expect(recordedDefaultKeychain(f.home, SECURITY_PREFERENCES, f.plutil)).toEqual({ kind: "unreadable", file: f.file });
          expect(refusal(() => linkAccountKeychain(f.home, options)).message).toContain(`the preference file cannot be checked: ${f.file}`);
        } finally { chmodSync(f.file, 0o600); }
      }
    }
    // A plutil whose help mentions "-type value" but that has no -type query.
    const f = fixture();
    const old = join(f.root, "plutil-old");
    writeFileSync(old, '#!/bin/sh\n[ "$1" = "-lint" ] && exit 0\n[ "$1" = "-help" ] && { echo "-insert keypath -type value"; exit 0; }\nexit 1\n');
    chmodSync(old, 0o755);
    writeFileSync(f.file, "DLDBSearchList=only\n");
    expect(recordedDefaultKeychain(f.home, SECURITY_PREFERENCES, old)).toEqual({ kind: "unreadable", file: f.file });
    expect(defaultKeychainResolves(f.home, { ...darwinWith(f.account), plutil: old })).toBe(false);
  });

  test("an account whose own file is broken refuses a private home instead of leaving it unlinked (review round 3)", () => {
    // An empty array, a stale login record beside a valid default one, and
    // an unreadable file: the account may still work under the real HOME,
    // but a private home left without the link would show the dialog.
    const contents = ["ARRAY_EMPTY\n", "DbName0=~/Library/Keychains/login.keychain-db\nLoginDbName0=~/Library/Keychains/gone.keychain-db\n"];
    for (const content of contents) {
      const f = fixture();
      rmSync(join(f.home, "Library"), { recursive: true });
      mkdirSync(join(f.account, "Library", "Preferences"));
      writeFileSync(join(f.account, SECURITY_PREFERENCES), content);
      const options = { ...darwinWith(f.account), plutil: f.plutil };
      expect(defaultKeychainResolves(f.account, options)).toBe(false);
      expect(refusal(() => linkAccountKeychain(f.home, options)).message).toContain("the account's own keychain preference file cannot be shared");
      expect(existsSync(join(f.home, "Library"))).toBe(false);
      // The account home itself is never refused (review round 4): macOS
      // decides what resolves there, and every ordinary launch runs with it.
      expect(linkAccountKeychain(f.account, options)).toBe("account-home");
      expect(() => guardChildKeychainHomes(["harness"], { HOME: f.account }, f.root, options)).not.toThrow();
    }
    // An account with nothing recorded and no login keychain has nothing to link.
    const root = scratchRoot("keychain-preferences");
    roots.push(root);
    const bare = fakeAccountHome(root, false), home = join(root, "private");
    mkdirSync(home);
    expect(linkAccountKeychain(home, darwinWith(bare))).toBe("no-account-keychain");
  });

  test("a recorded default keychain that exists is accepted: ~/, absolute outside Library/Keychains", () => {
    const f = fixture();
    writeFileSync(join(f.account, KEYCHAIN_DIRECTORY, "custom.keychain-db"), "");
    const outside = join(f.root, "elsewhere.keychain-db");
    writeFileSync(outside, "");
    for (const recorded of ["~/Library/Keychains/custom.keychain-db", outside]) {
      writeFileSync(f.file, `DbName0=${recorded}\n`);
      expect(linkAccountKeychain(f.home, { ...darwinWith(f.account), plutil: f.plutil })).toMatch(/linked|resolves/);
      expect(recordedDefaultKeychain(f.home, SECURITY_PREFERENCES, f.plutil)).toMatchObject({ kind: "recorded", exists: true });
    }
  });

  test("a recorded default keychain that does not exist, or is a directory, refuses and names both paths", () => {
    const f = fixture();
    mkdirSync(join(f.account, KEYCHAIN_DIRECTORY, "folder.keychain-db"));
    for (const [recorded, path] of [
      ["~/Library/Keychains/gone.keychain-db", join(f.home, KEYCHAIN_DIRECTORY, "gone.keychain-db")],
      ["/nonexistent/x.keychain-db", "/nonexistent/x.keychain-db"],
      ["~/Library/Keychains/folder.keychain-db", join(f.home, KEYCHAIN_DIRECTORY, "folder.keychain-db")],
    ] as const) {
      writeFileSync(f.file, `DbName0=${recorded}\n`);
      const message = refusal(() => linkAccountKeychain(f.home, { ...darwinWith(f.account), plutil: f.plutil })).message;
      expect(message).toContain(`the recorded default keychain does not exist: ${path}`);
      expect(message).toContain(`recorded in the keychain preference file ${f.file}`);
      expect(message).toContain("A keychain cannot be found to store");
    }
    // The spawn check refuses the same home.
    expect(() => guardChildKeychainHomes(["scode", "--", "env", `HOME=${f.home}`, "harness"], {}, f.root, { ...darwinWith(f.account), plutil: f.plutil }))
      .toThrow(/the recorded default keychain does not exist/);
  });

  test("the old name ending in .keychain stands for its -db file", () => {
    const f = fixture();
    writeFileSync(f.file, "DbName0=~/Library/Keychains/login.keychain\n");
    expect(linkAccountKeychain(f.home, { ...darwinWith(f.account), plutil: f.plutil })).toBe("linked");
    expect(recordedDefaultKeychain(f.home, SECURITY_PREFERENCES, f.plutil))
      .toEqual({ kind: "recorded", file: f.file, path: join(f.home, KEYCHAIN_DIRECTORY, LOGIN_KEYCHAIN), exists: true });
    // A file that really has the old name is used as it is; a missing one without a -db sibling refuses.
    writeFileSync(join(f.account, KEYCHAIN_DIRECTORY, "old.keychain"), "");
    writeFileSync(f.file, "DbName0=~/Library/Keychains/old.keychain\n");
    expect(recordedDefaultKeychain(f.home, SECURITY_PREFERENCES, f.plutil)).toMatchObject({ path: join(f.home, KEYCHAIN_DIRECTORY, "old.keychain"), exists: true });
    writeFileSync(f.file, "DbName0=~/Library/Keychains/gone.keychain\n");
    expect(refusal(() => linkAccountKeychain(f.home, { ...darwinWith(f.account), plutil: f.plutil })).message)
      .toContain(`the recorded default keychain does not exist: ${join(f.home, KEYCHAIN_DIRECTORY, "gone.keychain-db")}`);
  });

  test("a directory or a dangling link at the path records none; a link to a file is read like the file", () => {
    const f = fixture();
    mkdirSync(f.file);
    expect(recordedDefaultKeychain(f.home, SECURITY_PREFERENCES, f.plutil)).toEqual({ kind: "none" });
    expect(linkAccountKeychain(f.home, { ...darwinWith(f.account), plutil: f.plutil })).toBe("linked");
    const dangling = fixture();
    symlinkSync(join(dangling.root, "missing.plist"), dangling.file);
    expect(recordedDefaultKeychain(dangling.home, SECURITY_PREFERENCES, dangling.plutil)).toEqual({ kind: "none" });
    expect(linkAccountKeychain(dangling.home, { ...darwinWith(dangling.account), plutil: dangling.plutil })).toBe("linked");
    const linked = fixture();
    const target = join(linked.root, "elsewhere.plist");
    writeFileSync(target, "DbName0=/nonexistent/x.keychain-db\n");
    symlinkSync(target, linked.file);
    expect(recordedDefaultKeychain(linked.home, SECURITY_PREFERENCES, linked.plutil)).toMatchObject({ kind: "recorded", exists: false });
    expect(() => linkAccountKeychain(linked.home, { ...darwinWith(linked.account), plutil: linked.plutil })).toThrow(/does not exist: \/nonexistent/);
  });

  test("the account's file, linked into the home, is read: an existing keychain outside Library/Keychains is fine", () => {
    const f = fixture();
    rmSync(join(f.home, "Library"), { recursive: true });
    mkdirSync(join(f.account, "Library", "Preferences"));
    const outside = join(f.root, "account-choice.keychain-db");
    writeFileSync(outside, "");
    writeFileSync(join(f.account, SECURITY_PREFERENCES), `DbName0=${outside}\n`);
    expect(linkAccountKeychain(f.home, { ...darwinWith(f.account), plutil: f.plutil })).toBe("linked");
    expect(readlinkSync(f.file)).toBe(join(f.account, SECURITY_PREFERENCES));
    // ~/ is the child's HOME: the private home, whose Keychains directory is the account's.
    writeFileSync(join(f.account, SECURITY_PREFERENCES), "DbName0=~/Library/Keychains/login.keychain-db\n");
    expect(linkAccountKeychain(f.home, { ...darwinWith(f.account), plutil: f.plutil })).toBe("resolves");
    expect(linkAccountKeychain(f.account, { ...darwinWith(f.account), plutil: f.plutil })).toBe("account-home");
    // An account whose own record names a missing keychain: a private
    // home is refused, with the reason, and nothing is created.
    rmSync(outside);
    writeFileSync(join(f.account, SECURITY_PREFERENCES), `DbName0=${outside}\n`);
    const other = join(f.root, "second-private");
    expect(refusal(() => linkAccountKeychain(other, { ...darwinWith(f.account), plutil: f.plutil })).message)
      .toContain("the recorded default keychain does not exist");
    expect(existsSync(other)).toBe(false);
  });

  test("an account with no login keychain but a recorded custom default: the private home gets both links", () => {
    const f = fixture();
    rmSync(join(f.home, "Library"), { recursive: true });
    rmSync(join(f.account, KEYCHAIN_DIRECTORY, LOGIN_KEYCHAIN));
    writeFileSync(join(f.account, KEYCHAIN_DIRECTORY, "custom.keychain-db"), "");
    mkdirSync(join(f.account, "Library", "Preferences"));
    writeFileSync(join(f.account, SECURITY_PREFERENCES), "DbName0=~/Library/Keychains/custom.keychain-db\n");
    const options = { ...darwinWith(f.account), plutil: f.plutil };
    expect(defaultKeychainResolves(f.account, options)).toBe(true);
    expect(linkAccountKeychain(f.home, options)).toBe("linked");
    expect(readlinkSync(join(f.home, KEYCHAIN_DIRECTORY))).toBe(join(f.account, KEYCHAIN_DIRECTORY));
    expect(readlinkSync(f.file)).toBe(join(f.account, SECURITY_PREFERENCES));
    expect(defaultKeychainResolves(f.home, options)).toBe(true);
    expect(linkAccountKeychain(f.home, options)).toBe("resolves");
  });

  test("an account whose recorded default is outside its Keychains directory and it has none: the preference link alone resolves", () => {
    const f = fixture();
    rmSync(join(f.home, "Library"), { recursive: true });
    rmSync(join(f.account, "Library"), { recursive: true });
    const outside = join(f.root, "elsewhere.keychain-db");
    writeFileSync(outside, "");
    mkdirSync(join(f.account, "Library", "Preferences"), { recursive: true });
    writeFileSync(join(f.account, SECURITY_PREFERENCES), `DbName0=${outside}\n`);
    const options = { ...darwinWith(f.account), plutil: f.plutil };
    expect(linkAccountKeychain(f.home, options)).toBe("linked");
    expect(existsSync(join(f.home, KEYCHAIN_DIRECTORY))).toBe(false);
    expect(defaultKeychainResolves(f.home, options)).toBe(true);
  });

  test("an account record that is relative to the account home cannot be shared: the private home refuses", () => {
    const f = fixture();
    rmSync(join(f.home, "Library"), { recursive: true });
    rmSync(join(f.account, KEYCHAIN_DIRECTORY, LOGIN_KEYCHAIN));
    mkdirSync(join(f.account, "Other"));
    writeFileSync(join(f.account, "Other", "custom.keychain-db"), "");
    mkdirSync(join(f.account, "Library", "Preferences"));
    writeFileSync(join(f.account, SECURITY_PREFERENCES), "DbName0=~/Other/custom.keychain-db\n");
    const options = { ...darwinWith(f.account), plutil: f.plutil };
    expect(() => linkAccountKeychain(f.home, options)).toThrow(UsageRefusalError);
    // The file that would record a missing keychain for this home is not linked.
    expect(existsSync(f.file)).toBe(false);
  });

  test("the same record refuses also when the account has a login keychain: the child must not get another default (review round 16)", () => {
    const f = fixture();
    rmSync(join(f.home, "Library"), { recursive: true });
    mkdirSync(join(f.account, "Other"));
    writeFileSync(join(f.account, "Other", "custom.keychain-db"), "");
    mkdirSync(join(f.account, "Library", "Preferences"));
    writeFileSync(join(f.account, SECURITY_PREFERENCES), "DbName0=~/Other/custom.keychain-db\n");
    const options = { ...darwinWith(f.account), plutil: f.plutil };
    expect(defaultKeychainResolves(f.account, options)).toBe(true);
    expect(refusal(() => linkAccountKeychain(f.home, options)).message)
      .toContain("the account's keychain preference file cannot be shared with this home");
    expect(existsSync(f.file)).toBe(false);
    // The refusal left the directory link in place; a retry refuses again
    // instead of settling for the login keychain (review round 17).
    expect(existsSync(join(f.home, KEYCHAIN_DIRECTORY, LOGIN_KEYCHAIN))).toBe(true);
    expect(refusal(() => linkAccountKeychain(f.home, options)).message)
      .toContain("the account's keychain preference file cannot be shared with this home");
  });

  test("a home with its own keychain is not refused for the account's stale record (review round 20)", () => {
    const f = fixture();
    mkdirSync(join(f.home, KEYCHAIN_DIRECTORY), { recursive: true });
    writeFileSync(join(f.home, KEYCHAIN_DIRECTORY, LOGIN_KEYCHAIN), "");
    mkdirSync(join(f.account, "Library", "Preferences"));
    writeFileSync(join(f.account, SECURITY_PREFERENCES), "DbName0=~/Library/Keychains/gone.keychain-db\n");
    const options = { ...darwinWith(f.account), plutil: f.plutil };
    expect(defaultKeychainResolves(f.account, options)).toBe(false);
    expect(linkAccountKeychain(f.home, options)).toBe("resolves");
    // A home without one still refuses: it would need the account's.
    const other = join(f.root, "needs-account");
    mkdirSync(other);
    expect(refusal(() => linkAccountKeychain(other, options)).message).toContain("the account's own keychain preference file cannot be shared");
  });

  test("with an unknown account home, a HOME that resolves is still checked", () => {
    const f = fixture();
    mkdirSync(join(f.home, KEYCHAIN_DIRECTORY), { recursive: true });
    writeFileSync(join(f.home, KEYCHAIN_DIRECTORY, LOGIN_KEYCHAIN), "");
    expect(linkAccountKeychain(f.home, { ...darwinWith(null), plutil: f.plutil })).toBe("resolves");
    writeFileSync(f.file, "DbName0=~/Library/Keychains/gone.keychain-db\n");
    expect(() => linkAccountKeychain(f.home, { ...darwinWith(null), plutil: f.plutil })).toThrow(/the recorded default keychain does not exist/);
  });

  test("without the tool nothing is read (a host that only simulates macOS), and off macOS nothing is checked", () => {
    const f = fixture();
    writeFileSync(f.file, "DbName0=/nonexistent/x.keychain-db\n");
    expect(recordedDefaultKeychain(f.home, SECURITY_PREFERENCES, join(f.root, "no-plutil"))).toEqual({ kind: "none" });
    expect(linkAccountKeychain(f.home, { platform: "linux", accountHome: f.account, plutil: f.plutil })).toBe("not-darwin");
  });
});

// The same cases against the real tool and real property lists. Where the
// file records nothing, the test also asks Security.framework which
// keychain a child with that HOME is given (a query; it shows no window
// and opens no keychain): the login keychain. The array cases carry no
// such assertion: on the machine this was written on, the query reported
// the login keychain for them too, so it does not show which keychain a
// store would use.
describe.skipIf(process.platform !== "darwin")("a home's keychain preference file (/usr/bin/plutil and Security.framework)", () => {
  const HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>`;
  const entry = (name: string): string => `<dict><key>DbName</key><string>${name}</string></dict>`;
  const asArray = (name: string): string => `${HEAD}<key>DefaultKeychain</key><array>${entry(name)}</array></dict></plist>\n`;
  const asDictionary = (name: string): string => `${HEAD}<key>DefaultKeychain</key>${entry(name)}</dict></plist>\n`;
  const prepared = () => {
    const f = fixture();
    const login = join(f.home, KEYCHAIN_DIRECTORY, LOGIN_KEYCHAIN);
    const read = () => recordedDefaultKeychain(f.home, SECURITY_PREFERENCES, PLUTIL);
    const link = () => linkAccountKeychain(f.home, darwinWith(f.account));
    return { ...f, login, read, link };
  };

  test("element zero of the array is the record: an existing file is accepted", () => {
    const f = prepared();
    writeFileSync(join(f.account, KEYCHAIN_DIRECTORY, "custom.keychain-db"), "");
    writeFileSync(f.file, asArray("~/Library/Keychains/custom.keychain-db"));
    expect(f.link()).toBe("linked");
    expect(f.read()).toEqual({ kind: "recorded", file: f.file, path: join(f.home, KEYCHAIN_DIRECTORY, "custom.keychain-db"), exists: true });
    expect(defaultKeychain(f.home).status).toBe(0);
  });

  test("a recorded keychain that does not exist refuses", () => {
    const f = prepared();
    const gone = join(f.home, KEYCHAIN_DIRECTORY, "gone.keychain-db");
    writeFileSync(f.file, asArray("~/Library/Keychains/gone.keychain-db"));
    expect(f.read()).toEqual({ kind: "recorded", file: f.file, path: gone, exists: false });
    expect(f.link).toThrow(`the recorded default keychain does not exist: ${gone} (recorded in the keychain preference file ${f.file})`);
    expect(existsSync(gone)).toBe(false);
  });

  test("the old login.keychain name is the login keychain", () => {
    const f = prepared();
    writeFileSync(f.file, asArray("~/Library/Keychains/login.keychain"));
    expect(f.link()).toBe("linked");
    expect(f.read()).toMatchObject({ path: f.login, exists: true });
    expect(defaultKeychain(f.home)).toEqual({ status: 0, path: realpathSync(f.login) });
  });

  test("an array without a usable first element is unusable and refuses; for an empty array macOS reports no default keychain", () => {
    const wrap = (value: string): string => `${HEAD}<key>DefaultKeychain</key>${value}</dict></plist>\n`;
    for (const value of ["<array/>", "<array><string>x</string></array>", "<array><dict><key>Other</key><string>x</string></dict></array>",
      "<array><dict><key>DbName</key><integer>1</integer></dict></array>", "<array><dict><key>DbName</key><string></string></dict></array>"]) {
      const f = prepared();
      writeFileSync(f.file, wrap(value));
      expect(f.read()).toEqual({ kind: "unusable", file: f.file });
      expect(f.link).toThrow(`the preference file records no default keychain: ${f.file}`);
      // Measured for the empty array: status -25307, although the login keychain is linked and present.
      if (value === "<array/>") expect(defaultKeychain(f.home).status).toBe(NO_DEFAULT_KEYCHAIN);
    }
  });

  test("a dictionary-shaped value and a file that is no property list record none; macOS uses the login keychain", () => {
    for (const content of [asDictionary("~/Library/Keychains/gone.keychain-db"), "this is not a property list <<<\n",
      "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>DefaultKeychain</key>"]) {
      const f = prepared();
      writeFileSync(f.file, content);
      expect(f.read()).toEqual({ kind: "none" });
      expect(f.link()).toBe("linked");
      expect(defaultKeychain(f.home)).toEqual({ status: 0, path: realpathSync(f.login) });
    }
  });
});
