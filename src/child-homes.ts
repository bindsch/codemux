// Which HOME a child process runs under, read from the argv and the
// environment it is spawned with. Pure: nothing here touches the disk.
//
// Only real wrapper positions are read: argv[0], and the command that
// follows scode's own `--` when argv[0] is scode. At such a position an
// `env` invocation is parsed the way env(1) reads it (options, then
// NAME=value assignments, then the command, which may be `env` again).
// Words after the first real program are that program's arguments and are
// never read, so text in a prompt or a path cannot name a HOME. A form
// this parser cannot read with certainty is refused: an error is
// acceptable, a child with an unchecked HOME is not.
import { basename, isAbsolute, resolve } from "node:path";
import { UsageRefusalError } from "./validation.js";

// env(1) takes every word with an `=` as an assignment, whatever the name
// is made of (`A-B=x` is one).
const ASSIGNMENT = /^([^=]*)=(.*)$/s;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "csh", "tcsh", "fish"]);
// env(1) separates the words of an `-S` string at ASCII white space only.
// JavaScript's \s also matches U+00A0 and other Unicode spaces, which
// env keeps inside a word: splitting there would check a different HOME.
const ENV_SEPARATOR = /[ \t\n\v\f\r]/;
// A shell script that may change HOME: the bare name (HOME=, HOME+=,
// `export HOME`, `read HOME`, `printf -v HOME`, `unset HOME`) or an
// assigning expansion (\${HOME:=x}, \${HOME=x}). Reading it as $HOME or
// \${HOME} does not count.
const SHELL_SETS_HOME = /(?:^|[^$\w{])HOME\b|\$\{HOME:?=/;

function refuseUnparsed(reason: string): never {
  throw new UsageRefusalError(
    `cannot determine the HOME this command gives its child: ${reason}. ` +
    "codemux checks every child's HOME on macOS, because a child without a default keychain there can show a keychain dialog; " +
    "use plain `env NAME=value ... command` without -S quoting, escapes or variables");
}

/** Whether argv[0] is scode. The name is matched, also with a version
 * suffix (`scode-0.6.11`), as installed copies and test doubles carry one. */
export function isScodeCommand(command: readonly string[]): boolean {
  return /^scode(?:[-.][\w.+-]*)?$/.test(basename(command[0] ?? ""));
}

/**
 * Split an `env -S` operand into words. env(1) also expands `${NAME}`,
 * honors backslash escapes and `#` comments; an operand that uses any of
 * those, or an unbalanced quote, is refused instead of guessed.
 */
export function splitEnvString(operand: string): string[] {
  if (/[\\$#]/.test(operand)) refuseUnparsed("an `env -S` string with a backslash, `$` or `#`");
  const words: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (const char of operand) {
    if (quote !== null) {
      if (char === quote) quote = null; else word = (word ?? "") + char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (ENV_SEPARATOR.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else word = (word ?? "") + char;
  }
  if (quote !== null) refuseUnparsed("an `env -S` string with an unbalanced quote");
  if (word !== null) words.push(word);
  return words;
}

interface ChildState { home: string | undefined; cwd: string; changed: string[] }

/** Read one `env` invocation whose arguments are `words`; return the
 * command it runs (empty when it runs none). */
function readEnv(words: string[], state: ChildState, base = state.cwd, slot = -1): string[] {
  let index = 0;
  for (; index < words.length; index++) {
    const word = words[index]!;
    if (word === "--") { index++; break; }
    if (word === "-") { state.home = undefined; continue; } // the old spelling of -i
    if (!word.startsWith("-") || word.length < 2) break;
    if (word.startsWith("--")) refuseUnparsed(`the env option ${word}`);
    for (let at = 1; at < word.length; at++) {
      const flag = word[at]!;
      if (flag === "i") { state.home = undefined; continue; }
      if (flag === "v" || flag === "0") continue;
      if (!"uPCS".includes(flag)) refuseUnparsed(`the env option -${flag}`);
      const attached = word.slice(at + 1);
      const operand = attached !== "" ? attached : words[++index];
      if (operand === undefined) refuseUnparsed(`the env option -${flag} without its operand`);
      if (flag === "u" && operand === "HOME") state.home = undefined;
      // A repeated -C replaces the earlier one: each is read against the
      // directory this env started in, not against the previous -C.
      // Only the last -C of one env is used, so only that one is recorded.
      if (flag === "C") {
        // `..` is resolved by the file system after links are followed
        // (`/var/..` is `/private`), not by spelling.
        if (operand.split("/").includes("..")) refuseUnparsed("an `env -C` directory spelled through `..`");
        state.cwd = resolve(base, operand);
        if (slot === -1) slot = state.changed.push(state.cwd) - 1; else state.changed[slot] = state.cwd;
      }
      // The split words take the place of the option: more options, assignments, the command.
      if (flag === "S") return readEnv([...splitEnvString(operand), ...words.slice(index + 1)], state, base, slot);
      break;
    }
  }
  for (; index < words.length; index++) {
    const assignment = ASSIGNMENT.exec(words[index]!);
    if (assignment === null) break;
    // env(1) fails on an empty name; nothing after it runs.
    if (assignment[1] === "") refuseUnparsed("an env assignment with an empty name");
    if (assignment[1] === "HOME") state.home = assignment[2];
  }
  return words.slice(index);
}

/** Follow wrappers from a wrapper position to the first real program. */
function readWrappers(command: readonly string[], state: ChildState): void {
  let rest = [...command];
  while (rest.length > 0) {
    const program = basename(rest[0]!);
    if (program === "env") { rest = readEnv(rest.slice(1), state); continue; }
    // codemux builds no shell wrapper for a harness (the scan test asserts
    // it). One whose script may set HOME cannot be read here. This is a
    // text check, not a shell parser: a program that changes HOME by
    // other means (eval of built text, a script file) is outside it.
    // Quotes (also $'...') and backslashes are dropped first, as the shell
    // drops them, so `H""OME=` and `$'HOME'=` are read as the name they become.
    // Every argument of a shell is read, not only a -c script: which word
    // is the script depends on the shell's options, and a name can reach
    // the script as a positional parameter. A false refusal is acceptable.
    // A script can be attached to its option (`-cHOME=/x`), so the text
    // after every `c` of an option word is read as well.
    const texts = rest.slice(1).flatMap((word) =>
      word.startsWith("-") ? [word, ...[...word.matchAll(/c/g)].map((match) => word.slice(match.index + 1))] : [word]);
    if (SHELLS.has(program) && texts.some((text) => SHELL_SETS_HOME.test(text.replace(/\$'|['"\\]/g, "")))) {
      refuseUnparsed(`a \`${program}\` command whose arguments name HOME other than to read it`);
    }
    return;
  }
}

/**
 * Every HOME a child started with this argv and environment runs under:
 * the spawn environment's HOME (argv[0] itself runs with it), and the HOME
 * the last program in the wrapper chain ends up with. Relative values are
 * resolved against the directory that program runs in: the spawn's working
 * directory, changed by scode's and env's `-C`. An unset HOME is not
 * listed: macOS then reads the account home. An empty one is listed as "".
 */
export function childHomes(
  command: readonly string[], env: Readonly<Record<string, string | undefined>> | undefined, cwd?: string
): string[] {
  return readChild(command, env, cwd).homes;
}

/** The homes, and every directory scode's or an env's `-C` in the wrapper
 * chain changes to. Both fail when such a directory does not exist, so the caller
 * must not create anything on that command's behalf. */
export function readChild(
  command: readonly string[], env: Readonly<Record<string, string | undefined>> | undefined, cwd?: string
): { homes: string[]; directories: string[] } {
  const start = cwd ?? process.cwd();
  const spawned = (env ?? process.env).HOME;
  const state: ChildState = { home: spawned, cwd: start, changed: [] };
  if (isScodeCommand(command)) {
    // scode's argv is its options, one `--`, then the command
    // (buildScodeCommand in sandbox.ts); `-C <dir>` is the directory the
    // command runs in. A later `--` belongs to the command.
    const separator = command.indexOf("--");
    const options = separator === -1 ? command.slice(1) : command.slice(1, separator);
    const directory = options.indexOf("-C");
    if (directory !== -1 && options[directory + 1] !== undefined) {
      state.cwd = resolve(start, options[directory + 1]!);
      state.changed.push(state.cwd); // scode fails in a missing directory, as env does
    }
    if (separator !== -1) readWrappers(command.slice(separator + 1), state);
  } else readWrappers(command, state);
  const homes: string[] = [];
  const add = (value: string | undefined, base: string): void => {
    if (value === undefined) return;
    // An absolute value is kept as spelled (the keychain check resolves
    // `..` through the file system); a relative one is placed under the
    // directory the program runs in.
    if (value !== "" && !isAbsolute(value) && value.split("/").includes("..")) {
      refuseUnparsed("a relative HOME spelled through `..`");
    }
    const home = value === "" ? "" : isAbsolute(value) ? value : resolve(base, value);
    if (!homes.includes(home)) homes.push(home);
  };
  add(spawned, start);
  add(state.home, state.cwd);
  return { homes, directories: state.changed };
}
