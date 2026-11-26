import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  KEYCHAIN_DIRECTORY, LOGIN_KEYCHAIN, SECURITY_PREFERENCES, guardChildKeychainHomes,
  keychainResolves, linkAccountKeychain, precheckChildKeychainHomes,
} from "../src/darwin-keychain-home.js";
import { UsageRefusalError } from "../src/validation.js";
import { darwinWith, fakeAccountHome, scratchRoot } from "./helpers/keychain-home.js";

// Every test passes the platform and a stand-in account home, so the file
// runs the same on macOS and Linux and never touches the real account.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(withKeychain = true): { root: string; account: string; home: string } {
  const root = scratchRoot("keychain-home");
  roots.push(root);
  const home = join(root, "private");
  mkdirSync(home);
  return { root, account: fakeAccountHome(root, withKeychain), home };
}

describe("linkAccountKeychain", () => {
  test("a home without Library gets a link to the account's keychain directory", () => {
    const { account, home } = fixture();
    expect(linkAccountKeychain(home, darwinWith(account))).toBe("linked");
    const link = join(home, KEYCHAIN_DIRECTORY);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(account, KEYCHAIN_DIRECTORY));
    expect(keychainResolves(home)).toBe(true);
    expect(lstatSync(join(home, "Library")).mode & 0o777).toBe(0o700);
  });

  test("a directory named login.keychain-db is not a keychain: the home refuses instead of counting as resolved (review round 2)", () => {
    const { account, home } = fixture();
    mkdirSync(join(home, KEYCHAIN_DIRECTORY, LOGIN_KEYCHAIN), { recursive: true });
    expect(keychainResolves(home)).toBe(false);
    expect(() => linkAccountKeychain(home, darwinWith(account))).toThrow(UsageRefusalError);
  });

  test("`env -C` into a directory that does not exist is refused and nothing is created (review round 5)", () => {
    const { root, account } = fixture();
    expect(() => guardChildKeychainHomes(["env", "-C", join(root, "no-such-dir"), "HOME=home", "harness"], {}, root, darwinWith(account)))
      .toThrow(UsageRefusalError);
    expect(existsSync(join(root, "no-such-dir"))).toBe(false);
    // So is the spawn's own working directory (review round 12).
    expect(() => guardChildKeychainHomes(["harness"], { HOME: "relative" }, join(root, "no-cwd"), darwinWith(account)))
      .toThrow(/working directory does not exist/);
    expect(existsSync(join(root, "no-cwd"))).toBe(false);
    // scode's own -C is held to the same rule (review round 6).
    expect(() => guardChildKeychainHomes(["scode", "-C", join(root, "missing"), "--", "env", "HOME=relative", "harness"], {}, root, darwinWith(account)))
      .toThrow(/names a directory that does not exist/);
    expect(existsSync(join(root, "missing"))).toBe(false);
  });

  test("a HOME spelled through a missing directory is not the account home (review round 8)", () => {
    const { account } = fixture();
    // The spelling collapses to the account home, but no process can walk it.
    const spelled = `${account}/no-such-dir/..`;
    expect(() => linkAccountKeychain(spelled, darwinWith(account))).toThrow(/spelled through/);
    expect(() => guardChildKeychainHomes(["env", `HOME=${spelled}`, "harness"], {}, account, darwinWith(account))).toThrow(/spelled through/);
    // An existing directory reached through `..` is judged as what it is.
    expect(linkAccountKeychain(`${account}/Library/..`, darwinWith(account))).toBe("account-home");
    // A trailing separator and an alias link are still the account home.
    expect(linkAccountKeychain(`${account}/`, darwinWith(account))).toBe("account-home");
  });

  test("a launch's own spawn skips the check once after its precheck; every other spawn is checked in full (review rounds 14, 15)", () => {
    const { root, account, home } = fixture();
    const options = darwinWith(account);
    precheckChildKeychainHomes(["harness", "--a"], { HOME: home }, root, options);
    expect(keychainResolves(home)).toBe(true);
    // The link is removed, as a child could do. Another command with the
    // same HOME is checked in full and gets the link back.
    rmSync(join(home, KEYCHAIN_DIRECTORY));
    guardChildKeychainHomes(["harness", "--b"], { HOME: home }, root, options, true);
    expect(keychainResolves(home)).toBe(true);
    // A check that is not the spawn's own never uses the entry.
    rmSync(join(home, KEYCHAIN_DIRECTORY));
    guardChildKeychainHomes(["harness", "--a"], { HOME: home }, root, options);
    expect(keychainResolves(home)).toBe(true);
    // The prechecked launch's own spawn does no file work, once.
    rmSync(join(home, KEYCHAIN_DIRECTORY));
    guardChildKeychainHomes(["harness", "--a"], { HOME: home }, root, options, true);
    expect(existsSync(join(home, KEYCHAIN_DIRECTORY))).toBe(false);
    // The entry is used up: the same argv again is checked in full.
    guardChildKeychainHomes(["harness", "--a"], { HOME: home }, root, options, true);
    expect(keychainResolves(home)).toBe(true);
  });

  test("with an unknown account home a Library that is a link is still refused (review round 15)", () => {
    const { root, home } = fixture();
    const outside = join(root, "outside-library-2");
    mkdirSync(join(outside, "Keychains"), { recursive: true });
    writeFileSync(join(outside, "Keychains", LOGIN_KEYCHAIN), "");
    symlinkSync(outside, join(home, "Library"));
    expect(() => linkAccountKeychain(home, darwinWith(null))).toThrow(/Library is a symbolic link/);
  });

  test("a Library that is a link is refused even when a login keychain resolves through it (review round 6)", () => {
    const { root, account, home } = fixture();
    const outside = join(root, "outside-library");
    mkdirSync(join(outside, "Keychains"), { recursive: true });
    writeFileSync(join(outside, "Keychains", LOGIN_KEYCHAIN), "");
    symlinkSync(outside, join(home, "Library"));
    expect(keychainResolves(home)).toBe(true);
    expect(() => linkAccountKeychain(home, darwinWith(account))).toThrow(/Library is a symbolic link/);
  });

  test("a home that already resolves its own keychain gets neither link (review round 6)", () => {
    const { account, home } = fixture();
    mkdirSync(join(home, KEYCHAIN_DIRECTORY), { recursive: true });
    writeFileSync(join(home, KEYCHAIN_DIRECTORY, LOGIN_KEYCHAIN), "");
    mkdirSync(join(account, "Library", "Preferences"), { recursive: true });
    writeFileSync(join(account, SECURITY_PREFERENCES), "");
    expect(linkAccountKeychain(home, darwinWith(account))).toBe("resolves");
    expect(lstatSync(join(home, KEYCHAIN_DIRECTORY)).isDirectory()).toBe(true);
    expect(existsSync(join(home, SECURITY_PREFERENCES))).toBe(false);
  });

  test("a HOME that does not exist yet is created level by level under such a umask too (review round 18)", () => {
    const { root, account } = fixture();
    const deep = join(root, "new", "nested", "home");
    const previous = process.umask(0o277);
    try { expect(linkAccountKeychain(deep, darwinWith(account))).toBe("linked"); }
    finally { process.umask(previous); }
    expect(keychainResolves(deep)).toBe(true);
    for (const path of [join(root, "new"), join(root, "new", "nested"), deep, join(deep, "Library")]) {
      expect(lstatSync(path).mode & 0o777).toBe(0o700);
    }
  });

  test("two launches preparing the same new HOME both succeed (review round 19)", () => {
    // The second caller finds what the first one made: a directory that
    // appeared meanwhile is not an error.
    const { root, account } = fixture();
    const shared = join(root, "shared-home");
    expect(linkAccountKeychain(shared, darwinWith(account))).toBe("linked");
    expect(linkAccountKeychain(shared, darwinWith(account))).toBe("resolves");
    // A Library that exists without the link, as another launch leaves it
    // between its two steps, is completed instead of refused.
    const half = join(root, "half-home");
    mkdirSync(join(half, "Library", "Preferences"), { recursive: true });
    expect(linkAccountKeychain(half, darwinWith(account))).toBe("linked");
    expect(keychainResolves(half)).toBe(true);
  });

  test("the link is made under a umask that strips the owner's write bit", () => {
    const { account, home } = fixture();
    const previous = process.umask(0o277);
    try { expect(linkAccountKeychain(home, darwinWith(account))).toBe("linked"); }
    finally { process.umask(previous); }
    expect(lstatSync(join(home, "Library")).mode & 0o777).toBe(0o700);
    expect(keychainResolves(home)).toBe(true);
  });

  test("a second call keeps the existing link", () => {
    const { account, home } = fixture();
    linkAccountKeychain(home, darwinWith(account));
    const before = lstatSync(join(home, KEYCHAIN_DIRECTORY)).ino;
    expect(linkAccountKeychain(home, darwinWith(account))).toBe("resolves");
    expect(lstatSync(join(home, KEYCHAIN_DIRECTORY)).ino).toBe(before);
  });

  test("an entry through which a login keychain already resolves is kept", () => {
    const { account, home } = fixture();
    mkdirSync(join(home, KEYCHAIN_DIRECTORY), { recursive: true });
    writeFileSync(join(home, KEYCHAIN_DIRECTORY, LOGIN_KEYCHAIN), "");
    expect(linkAccountKeychain(home, darwinWith(account))).toBe("resolves");
    expect(lstatSync(join(home, KEYCHAIN_DIRECTORY)).isDirectory()).toBe(true);
  });

  test("a link through another home that resolves is kept", () => {
    const { root, account, home } = fixture();
    const middle = join(root, "middle");
    mkdirSync(join(middle, "Library"), { recursive: true });
    symlinkSync(join(account, KEYCHAIN_DIRECTORY), join(middle, KEYCHAIN_DIRECTORY));
    mkdirSync(join(home, "Library"));
    symlinkSync(join(middle, KEYCHAIN_DIRECTORY), join(home, KEYCHAIN_DIRECTORY));
    expect(linkAccountKeychain(home, darwinWith(account))).toBe("resolves");
    expect(readlinkSync(join(home, KEYCHAIN_DIRECTORY))).toBe(join(middle, KEYCHAIN_DIRECTORY));
  });

  test("an empty directory is replaced by the link", () => {
    const { account, home } = fixture();
    mkdirSync(join(home, KEYCHAIN_DIRECTORY), { recursive: true });
    expect(linkAccountKeychain(home, darwinWith(account))).toBe("linked");
    expect(lstatSync(join(home, KEYCHAIN_DIRECTORY)).isSymbolicLink()).toBe(true);
  });

  test("a directory with its own content and no login keychain refuses and is left alone", () => {
    const { account, home } = fixture();
    mkdirSync(join(home, KEYCHAIN_DIRECTORY), { recursive: true });
    writeFileSync(join(home, KEYCHAIN_DIRECTORY, "other.keychain-db"), "kept");
    expect(() => linkAccountKeychain(home, darwinWith(account))).toThrow(UsageRefusalError);
    expect(() => linkAccountKeychain(home, darwinWith(account))).toThrow(/A keychain cannot be found to store/);
    expect(readdirSync(join(home, KEYCHAIN_DIRECTORY))).toEqual(["other.keychain-db"]);
  });

  test("a file, a dangling link, and a link to a directory without a login keychain refuse", () => {
    for (const plant of [
      (target: string) => writeFileSync(target, "file"),
      (target: string) => symlinkSync(join(target, "..", "missing"), target),
      (target: string, root: string) => { mkdirSync(join(root, "elsewhere")); symlinkSync(join(root, "elsewhere"), target); },
    ]) {
      const { root, account, home } = fixture();
      mkdirSync(join(home, "Library"));
      plant(join(home, KEYCHAIN_DIRECTORY), root);
      expect(() => linkAccountKeychain(home, darwinWith(account))).toThrow(UsageRefusalError);
      expect(keychainResolves(home)).toBe(false);
    }
  });

  test("a Library that is a link or a file refuses; nothing is created through it", () => {
    const { root, account, home } = fixture();
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(home, "Library"));
    expect(() => linkAccountKeychain(home, darwinWith(account))).toThrow(/symbolic link/);
    expect(readdirSync(outside)).toEqual([]);
    const other = fixture();
    writeFileSync(join(other.home, "Library"), "file");
    expect(() => linkAccountKeychain(other.home, darwinWith(other.account))).toThrow(UsageRefusalError);
  });

  test("a home that does not exist yet is created with the link", () => {
    const { root, account } = fixture();
    const home = join(root, "later", "home");
    expect(linkAccountKeychain(home, darwinWith(account))).toBe("linked");
    expect(keychainResolves(home)).toBe(true);
  });

  test("an empty HOME refuses", () => {
    const { account } = fixture();
    expect(() => linkAccountKeychain("", darwinWith(account))).toThrow(/HOME is empty/);
  });

  test("the account home itself is left alone, under any spelling", () => {
    const { root, account } = fixture();
    const before = readdirSync(join(account, "Library"));
    expect(linkAccountKeychain(account, darwinWith(account))).toBe("account-home");
    expect(linkAccountKeychain(`${account}/`, darwinWith(account))).toBe("account-home");
    symlinkSync(account, join(root, "alias"));
    expect(linkAccountKeychain(join(root, "alias"), darwinWith(account))).toBe("account-home");
    expect(readdirSync(join(account, "Library"))).toEqual(before);
  });

  test("off macOS nothing is created", () => {
    const { account, home } = fixture();
    expect(linkAccountKeychain(home, { platform: "linux", accountHome: account })).toBe("not-darwin");
    expect(readdirSync(home)).toEqual([]);
  });

  test("an account without a login keychain changes nothing", () => {
    const { account, home } = fixture(false);
    expect(linkAccountKeychain(home, darwinWith(account))).toBe("no-account-keychain");
    // The refusals do not apply either: the private home is no worse than the real one.
    expect(linkAccountKeychain("", darwinWith(account))).toBe("no-account-keychain");
    expect(readdirSync(home)).toEqual([]);
  });

  test("an unknown account home refuses, unless the HOME resolves a login keychain by itself", () => {
    const { home } = fixture();
    expect(() => linkAccountKeychain(home, darwinWith(null))).toThrow(UsageRefusalError);
    expect(() => linkAccountKeychain(home, darwinWith(null))).toThrow(/account home cannot be read from the directory service/);
    expect(() => linkAccountKeychain("", darwinWith(null))).toThrow(UsageRefusalError);
    expect(readdirSync(home)).toEqual([]);
    mkdirSync(join(home, KEYCHAIN_DIRECTORY), { recursive: true });
    writeFileSync(join(home, KEYCHAIN_DIRECTORY, LOGIN_KEYCHAIN), "");
    expect(linkAccountKeychain(home, darwinWith(null))).toBe("resolves");
    // Off macOS the question does not arise.
    expect(linkAccountKeychain(join(home, "other"), { platform: "linux", accountHome: null })).toBe("not-darwin");
  });

  test("the security preference file is linked when the account has one and the home does not", () => {
    const { account, home } = fixture();
    mkdirSync(join(account, "Library", "Preferences"));
    writeFileSync(join(account, SECURITY_PREFERENCES), "plist");
    linkAccountKeychain(home, darwinWith(account));
    expect(readlinkSync(join(home, SECURITY_PREFERENCES))).toBe(join(account, SECURITY_PREFERENCES));
    // The home's own file wins, and a home that already resolved still gets the link.
    const own = fixture();
    mkdirSync(join(own.account, "Library", "Preferences"));
    writeFileSync(join(own.account, SECURITY_PREFERENCES), "plist");
    mkdirSync(join(own.home, "Library", "Preferences"), { recursive: true });
    writeFileSync(join(own.home, SECURITY_PREFERENCES), "own");
    linkAccountKeychain(own.home, darwinWith(own.account));
    expect(lstatSync(join(own.home, SECURITY_PREFERENCES)).isFile()).toBe(true);
  });

  test("no preference link is made when the account has no preference file", () => {
    const { account, home } = fixture();
    linkAccountKeychain(home, darwinWith(account));
    expect(existsSync(join(home, "Library", "Preferences"))).toBe(false);
  });

  test("concurrent calls from several processes all succeed and leave one link", async () => {
    const { account, home } = fixture();
    mkdirSync(join(home, KEYCHAIN_DIRECTORY), { recursive: true }); // the empty-directory arm races too
    const script = `import { linkAccountKeychain } from ${JSON.stringify(join(import.meta.dir, "../src/darwin-keychain-home.ts"))};
      linkAccountKeychain(${JSON.stringify(home)}, { platform: "darwin", accountHome: ${JSON.stringify(account)} });`;
    const children = Array.from({ length: 16 }, () => Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "pipe" }));
    const results = await Promise.all(children.map(async (child) => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })));
    expect(results.filter((result) => result.code !== 0)).toEqual([]);
    expect(readlinkSync(join(home, KEYCHAIN_DIRECTORY))).toBe(join(account, KEYCHAIN_DIRECTORY));
  });
});

describe("guardChildKeychainHomes", () => {
  test("links every HOME of the child: the environment's and the argv's, also after scode's `--`", () => {
    const { root, account } = fixture();
    const [first, second, third] = ["one", "two", "three"].map((name) => join(root, name));
    guardChildKeychainHomes(["scode", "--rw", "--", "env", `HOME=${second}`, "harness"], { HOME: first }, root, darwinWith(account));
    guardChildKeychainHomes(["env", "HOME=ignored", "env", `HOME=${third}`, "harness"], {}, root, darwinWith(account));
    for (const home of [first, second, third]) expect(keychainResolves(home!)).toBe(true);
    // Only the HOME the program ends up with is linked, not one a later env replaces.
    expect(existsSync(join(root, "ignored"))).toBe(false);
  });

  test("words after the program are its arguments: nothing is created or refused for them", () => {
    const { root, account } = fixture();
    const named = join(root, "named-in-arguments");
    guardChildKeychainHomes(["/bin/echo", "env", `HOME=${named}`], {}, root, darwinWith(account));
    guardChildKeychainHomes(["/bin/echo", "env", "HOME="], {}, root, darwinWith(account));
    guardChildKeychainHomes(["scode", "--", "harness", "--", "env", `HOME=${named}`], {}, root, darwinWith(account));
    expect(existsSync(named)).toBe(false);
  });

  test("a wrapper form that cannot be read refuses on macOS and is not looked at elsewhere", () => {
    const { root, account, home } = fixture();
    const unreadable = ["env", "-S", `HOME=${home}\\ x harness`];
    expect(() => guardChildKeychainHomes(unreadable, {}, root, darwinWith(account))).toThrow(UsageRefusalError);
    guardChildKeychainHomes(unreadable, {}, root, { platform: "linux", accountHome: account });
    guardChildKeychainHomes(["env", "-S", `HOME=${home} harness`], {}, root, darwinWith(account));
    expect(keychainResolves(home)).toBe(true);
  });

  test("a home that cannot be linked stops the launch", () => {
    const { account, home } = fixture();
    mkdirSync(join(home, KEYCHAIN_DIRECTORY), { recursive: true });
    writeFileSync(join(home, KEYCHAIN_DIRECTORY, "other"), "");
    expect(() => guardChildKeychainHomes(["scode", "--", "env", `HOME=${home}`, "harness"], { HOME: account }, home, darwinWith(account)))
      .toThrow(UsageRefusalError);
    expect(() => guardChildKeychainHomes(["harness"], { HOME: "" }, home, darwinWith(account))).toThrow(/HOME is empty/);
  });

  test("does nothing off macOS and for a child without HOME", () => {
    const { account, home } = fixture();
    guardChildKeychainHomes(["env", `HOME=${home}`, "harness"], { HOME: home }, home, { platform: "linux", accountHome: account });
    guardChildKeychainHomes(["harness"], {}, home, darwinWith(account));
    expect(readdirSync(home)).toEqual([]);
  });
});
