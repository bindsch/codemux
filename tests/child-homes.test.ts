import { describe, expect, test } from "bun:test";
import { childHomes, isScodeCommand, readChild, splitEnvString } from "../src/child-homes.js";
import { UsageRefusalError } from "../src/validation.js";

// The argv parser is pure: these tests create no file and start no process.
const cwd = "/work";

describe("childHomes", () => {
  test("the spawn environment's HOME, or this process's when no environment is given", () => {
    expect(childHomes(["harness"], { HOME: "/a" }, cwd)).toEqual(["/a"]);
    expect(childHomes(["harness"], { PATH: "/bin" }, cwd)).toEqual([]);
    expect(childHomes(["harness"], undefined, cwd)).toEqual(process.env.HOME ? [process.env.HOME] : []);
  });

  test("env at argv[0]: options, assignments, then the command", () => {
    expect(childHomes(["env", "HOME=/b", "harness"], { HOME: "/a" }, cwd)).toEqual(["/a", "/b"]);
    expect(childHomes(["/usr/bin/env", "-u", "X", "A=1", "HOME=/b", "XDG_CONFIG_HOME=/b/.config", "harness", "HOME=/not-env"], {}, cwd))
      .toEqual(["/b"]);
    expect(childHomes(["env", "-i", "--", "HOME=/b", "harness"], {}, cwd)).toEqual(["/b"]);
    expect(childHomes(["env", "-v", "-P", "/usr/bin", "-uX", "HOME=/b", "harness"], {}, cwd)).toEqual(["/b"]);
    expect(childHomes(["env", "HOME=/b"], {}, cwd)).toEqual(["/b"]);
  });

  test("the command after scode's own `--`, and nested env", () => {
    expect(childHomes(["/opt/scode", "--rw", "--block", "/x", "--", "/usr/bin/env", "HOME=/private", "kimi", "-p", "hi"], { HOME: "/a" }, cwd))
      .toEqual(["/a", "/private"]);
    // The last program's HOME is the one that counts; an earlier one is replaced.
    expect(childHomes(["env", "HOME=/one", "env", "HOME=/two", "harness"], {}, cwd)).toEqual(["/two"]);
    expect(childHomes(["scode-0.6.11", "--", "env", "A=1", "env", "HOME=/two", "harness"], {}, cwd)).toEqual(["/two"]);
  });

  test("words after the program are its arguments and are never read (review finding 2a)", () => {
    expect(childHomes(["/bin/echo", "env", "HOME=/x"], {}, cwd)).toEqual([]);
    expect(childHomes(["/bin/echo", "env", "HOME="], {}, cwd)).toEqual([]);
    expect(childHomes(["harness", "/some/path/env", "HOME=/x"], { HOME: "/a" }, cwd)).toEqual(["/a"]);
    expect(childHomes(["env", "harness", "HOME=/b"], {}, cwd)).toEqual([]);
    expect(childHomes(["harness", "-p", "env HOME=/b"], {}, cwd)).toEqual([]);
    // A `--` inside the harness's arguments is not scode's.
    expect(childHomes(["scode", "--", "harness", "--", "env", "HOME=/x"], {}, cwd)).toEqual([]);
    expect(childHomes(["scode", "--", "env", "HOME=/h", "harness", "--", "env", "HOME=/x"], {}, cwd)).toEqual(["/h"]);
    // Without `--` scode runs no command; a program that is not scode has no separator to honor.
    expect(childHomes(["scode", "--version"], {}, cwd)).toEqual([]);
    expect(childHomes(["harness", "--", "env", "HOME=/x"], {}, cwd)).toEqual([]);
  });

  test("-u HOME and -i unset it; a later assignment sets it again", () => {
    expect(childHomes(["env", "-u", "HOME", "harness"], { HOME: "/a" }, cwd)).toEqual(["/a"]);
    expect(childHomes(["env", "HOME=/b", "env", "-i", "harness"], {}, cwd)).toEqual([]);
    expect(childHomes(["env", "-", "HOME=/b", "harness"], {}, cwd)).toEqual(["/b"]);
    expect(childHomes(["env", "-uHOME", "HOME=/c", "harness"], {}, cwd)).toEqual(["/c"]);
  });

  test("env -S: the string's words are options, assignments and the command (review finding 2b)", () => {
    expect(childHomes(["/usr/bin/env", "-S", "HOME=/private /path/server"], {}, cwd)).toEqual(["/private"]);
    expect(childHomes(["env", "-SHOME=/private server --flag"], {}, cwd)).toEqual(["/private"]);
    expect(childHomes(["env", "-S", "-u X 'HOME=/my home' server", "HOME=/argument"], {}, cwd)).toEqual(["/my home"]);
    expect(childHomes(["env", "-S", "A=1", "HOME=/after", "server"], {}, cwd)).toEqual(["/after"]);
    expect(childHomes(["scode", "--", "env", "-S", "env HOME=/nested server"], {}, cwd)).toEqual(["/nested"]);
  });

  test("a form that cannot be read with certainty refuses", () => {
    for (const command of [
      ["env", "-S", "HOME=${OTHER} server"], ["env", "-S", "HOME=/a\\ b server"], ["env", "-S", "HOME=/a # note"],
      ["env", "-S", "HOME='/a server"], ["env", "-x", "HOME=/a", "server"], ["env", "--chdir=/x", "server"],
      ["env", "-u"], ["scode", "--", "env", "-C"],
    ]) expect(() => childHomes(command, {}, cwd)).toThrow(UsageRefusalError);
  });

  test("a shell wrapper whose script assigns HOME refuses; other shell commands are programs (review finding 2c)", () => {
    expect(() => childHomes(["/bin/sh", "-c", "HOME=/x exec harness"], {}, cwd)).toThrow(/`sh` command whose arguments name HOME/);
    expect(() => childHomes(["scode", "--", "bash", "-lc", "export HOME=/x; harness"], {}, cwd)).toThrow(UsageRefusalError);
    expect(() => childHomes(["env", "A=1", "sh", "-c", "HOME=/x harness"], {}, cwd)).toThrow(UsageRefusalError);
    expect(childHomes(["scode", "--", "/bin/sh", "-c", "exit 0"], { HOME: "/a" }, cwd)).toEqual(["/a"]);
    // Every argument is read, so this refuses too: which word is the script
    // depends on the shell's options, and a refusal is the safe side.
    expect(() => childHomes(["/bin/sh", "script.sh", "HOME=/x"], {}, cwd)).toThrow(UsageRefusalError);
    expect(childHomes(["/bin/sh", "script.sh", "--flag"], {}, cwd)).toEqual([]);
  });

  test("a shell script that may set HOME without `HOME=` refuses; reading $HOME does not (review round 2)", () => {
    // Quote removal: the shell reads these as HOME (review round 6).
    for (const script of ['export H""OME=/private; exec harness', "H''OME=/x harness", "HO\\ME=/x harness", "export $'HOME'=/x; harness"]) {
      expect(() => childHomes(["/bin/sh", "-c", script], {}, cwd)).toThrow(UsageRefusalError);
    }
    // The -c option may be combined with other letters, upper case included (review round 9).
    expect(() => childHomes(["bash", "-Ec", "HOME=/x harness"], {}, cwd)).toThrow(UsageRefusalError);
    // `--` ends the options, and the script is the word after it (review round 13).
    expect(() => childHomes(["/bin/sh", "-c", "--", "HOME=/not-checked; exec harness"], {}, cwd)).toThrow(UsageRefusalError);
    expect(() => childHomes(["bash", "-o", "pipefail", "-c", "HOME=/x harness"], {}, cwd)).toThrow(UsageRefusalError);
    expect(() => childHomes(["bash", "--norc", "-ec", "HOME=/x harness"], {}, cwd)).toThrow(UsageRefusalError);
    // Forms a parser of shell options would get wrong (review round 14): a
    // long option with a value, a script attached to -c, another shell, and
    // a name passed as a positional parameter.
    expect(() => childHomes(["bash", "--rcfile", "f", "-c", "HOME=/x prog"], {}, cwd)).toThrow(UsageRefusalError);
    expect(() => childHomes(["bash", "-cHOME=/private; exec claude", "-p", "hi"], {}, cwd)).toThrow(UsageRefusalError);
    expect(() => childHomes(["csh", "-c", "setenv HOME /x; prog"], {}, cwd)).toThrow(UsageRefusalError);
    expect(() => childHomes(["sh", "-c", 'export "$1=/tmp/private"; exec harness', "_", "HOME"], {}, cwd)).toThrow(UsageRefusalError);
    expect(childHomes(["sh", "server.sh", "-c", "value"], { HOME: "/a" }, cwd)).toEqual(["/a"]);
    for (const script of ["HOME+=/private; exec harness", "export HOME; harness", "read HOME < f; harness", "printf -v HOME %s /x; harness",
      "unset HOME; harness", ": ${HOME:=/x}; harness", ": ${HOME=/x}; harness"]) {
      expect(() => childHomes(["bash", "-c", script], {}, cwd)).toThrow(UsageRefusalError);
    }
    for (const script of ["cd $HOME && harness", "ls \"${HOME}/x\"; harness", "echo ${HOME:-/x}", "MYHOME=/x harness", "XDG_CONFIG_HOME=/x harness"]) {
      expect(childHomes(["bash", "-c", script], { HOME: "/a" }, cwd)).toEqual(["/a"]);
    }
  });

  test("env takes any word with `=` as an assignment, and a repeated -C replaces the earlier one (review round 3)", () => {
    expect(childHomes(["env", "A-B=x", "1x=y", "HOME=/private", "harness"], { HOME: "/a" }, cwd)).toEqual(["/a", "/private"]);
    // Each -C is read against the directory env started in.
    expect(childHomes(["env", "-C", "/tmp", "-C", "src", "HOME=rel", "harness"], {}, cwd)).toEqual(["/work/src/rel"]);
    expect(childHomes(["env", "-S", "-C /tmp -C src HOME=rel harness"], {}, cwd)).toEqual(["/work/src/rel"]);
    // Only the last -C of one env counts, also for the missing-directory check (review round 7).
    expect(readChild(["env", "-C", "/missing", "-C", "/tmp", "harness"], {}, cwd).directories).toEqual(["/tmp"]);
    expect(readChild(["env", "-C", "/a", "env", "-C", "b", "harness"], {}, cwd).directories).toEqual(["/a", "/a/b"]);
    // env(1) fails on an empty name, so nothing is read past it (review round 5).
    expect(() => childHomes(["env", "=x", "HOME=/private", "harness"], {}, cwd)).toThrow(UsageRefusalError);
    // `..` is the file system's to resolve (`/var/..` is `/private` on macOS),
    // so a -C directory or a relative HOME spelled through it refuses (review round 11).
    expect(() => childHomes(["env", "-C", "/var/..", "HOME=child", "harness"], {}, cwd)).toThrow(UsageRefusalError);
    expect(() => childHomes(["env", "-C", "/work/missing/..", "HOME=private", "harness"], {}, cwd)).toThrow(UsageRefusalError);
    expect(() => childHomes(["env", "HOME=../other", "harness"], {}, cwd)).toThrow(UsageRefusalError);
    expect(() => childHomes(["harness"], { HOME: "a/../b" }, cwd)).toThrow(UsageRefusalError);
    // A nested env starts in the directory the outer one chose.
    expect(childHomes(["env", "-C", "/tmp", "env", "-C", "src", "HOME=rel", "harness"], {}, cwd)).toEqual(["/tmp/src/rel"]);
  });

  test("`env -S` splits at ASCII white space only, as env(1) does (review round 2)", () => {
    // U+00A0 stays inside the word: the HOME is the whole path.
    expect(childHomes(["env", "-S", "HOME=/example\u00a0home server"], {}, cwd)).toEqual(["/example\u00a0home"]);
    expect(splitEnvString("a\u00a0b\u2003c d\te\nf")).toEqual(["a\u00a0b\u2003c", "d", "e", "f"]);
  });

  test("relative values resolve against the directory the program runs in; an empty value is kept", () => {
    expect(childHomes(["env", "HOME=rel", "harness"], { HOME: "" }, cwd)).toEqual(["", "/work/rel"]);
    expect(childHomes(["env", "-C", "/elsewhere", "HOME=rel", "harness"], {}, cwd)).toEqual(["/elsewhere/rel"]);
    expect(childHomes(["env", "-C", "sub", "HOME=rel", "harness"], {}, cwd)).toEqual(["/work/sub/rel"]);
    expect(childHomes(["scode", "-C", "/project", "--", "env", "HOME=rel", "harness"], { HOME: "outer" }, cwd)).toEqual(["/work/outer", "/project/rel"]);
    expect(childHomes(["env", "HOME=", "harness"], {}, cwd)).toEqual([""]);
  });
});

describe("splitEnvString", () => {
  test("splits on blanks and keeps quoted text together", () => {
    expect(splitEnvString("  a  b\tc ")).toEqual(["a", "b", "c"]);
    expect(splitEnvString(`A='x y' "B=1 2" c''d ""`)).toEqual(["A=x y", "B=1 2", "cd", ""]);
    expect(splitEnvString("")).toEqual([]);
  });
});

describe("isScodeCommand", () => {
  test("matches scode by name, with or without a version suffix", () => {
    for (const name of ["scode", "/opt/homebrew/bin/scode", "/tmp/bin/scode-0.6.11", "scode.sh"]) expect(isScodeCommand([name])).toBe(true);
    for (const name of ["scoder", "/usr/bin/env", "myscode", ""]) expect(isScodeCommand([name])).toBe(false);
    expect(isScodeCommand([])).toBe(false);
  });
});
