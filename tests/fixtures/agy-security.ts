// Synthetic credentials only: record raw argv and stdin to prove the boundary.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const stdin = args[0] === "-i" ? readFileSync(0, "utf8") : "";
// The builder quotes every argument. Decode the same backslash quoting as security.
const input = stdin ? [...stdin.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) =>
  match[1]!.replace(/\\(.)/g, "$1")) : args;
const command = input[0];
const probe = input[2] === "codemux-usability-probe" && input[4] === "probe";
type Keychain = { password: string; unlocked: boolean; item: string; probe?: boolean };
const keychainPath = input.at(-1)!;
const readKeychain = (): Keychain => JSON.parse(readFileSync(keychainPath, "utf8"));
const saveKeychain = (keychain: Keychain) => writeFileSync(keychainPath, JSON.stringify(keychain));
const secret = process.env.AGY_TEST_SECRET!;
const calls = process.env.AGY_TEST_CALLS!;
const listFile = `${calls}.list`;
const list: string[] = existsSync(listFile) ? JSON.parse(readFileSync(listFile, "utf8")) : [];
appendFileSync(calls, JSON.stringify({ args, stdin, input, home: process.env.HOME }) + "\n");
const step = command === "list-keychains" ? (args.includes("-s") ? "restore-list" : "read-list")
  : probe && command === "add-generic-password" ? "probe-add" : command;
if (command === "create-keychain") {
  if (args.length !== 1 || args[0] !== "-i") throw new Error("creation password on argv");
  if (!existsSync(`${input.at(-1)!}.lock`)) throw new Error("creation outside template lock");
  list.push(input.at(-1)!);
  writeFileSync(listFile, JSON.stringify(list));
  if (process.env.AGY_TEST_CREATE_DELAY) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.AGY_TEST_CREATE_DELAY));
  }
}
const failOnce = process.env.AGY_TEST_FAIL === "add-once" && command === "add-generic-password" && !probe && !existsSync(`${calls}.failed`);
if (failOnce) writeFileSync(`${calls}.failed`, "failed");
if (process.env.AGY_TEST_FAIL === step || failOnce) {
  // The parent must discard even secret-bearing errors from security.
  process.stdout.write(secret);
  process.stderr.write(secret);
  process.exit(1);
}
if (command === "find-generic-password") process.stdout.write(secret + "\n");
else if (command === "default-keychain") {
  const defaultFile = join(process.env.HOME!, ".agy-test-default");
  if (args.includes("-s")) writeFileSync(defaultFile, args.at(-1)!);
  else process.stdout.write(`    "${existsSync(defaultFile) ? readFileSync(defaultFile, "utf8") : join(process.env.HOME!, "Library/Keychains/login.keychain-db")}"\n`);
}
else if (command === "list-keychains") {
  if (args.includes("-s")) {
    if (process.env.AGY_TEST_FAIL !== "restore-noop") writeFileSync(listFile, JSON.stringify(args.slice(4)));
  } else process.stdout.write(list.map((path) => `    "${path}"\n`).join(""));
}
else if (command === "create-keychain") {
  if (!/^[a-f0-9]{32}$/.test(input[2]!)) process.exit(2);
  writeFileSync(keychainPath, JSON.stringify({ password: input[2], unlocked: false, item: "empty" }), { flag: "wx", mode: 0o644 });
} else if (command === "add-generic-password") {
  if (args.length !== 1 || args[0] !== "-i") process.exit(3);
  const keychain = readKeychain();
  if (!keychain.unlocked) process.exit(1);
  if (keychain.item !== "empty") throw new Error("mirror was not copied from empty template");
  if (probe) {
    if (keychain.probe || !/^[a-f0-9]{32}$/.test(input[input.indexOf("-w") + 1]!)) process.exit(3);
    keychain.probe = true;
  } else {
    if (input[input.indexOf("-w") + 1] !== secret || keychain.probe) process.exit(3);
    keychain.item = "one synthetic Antigravity item";
  }
  saveKeychain(keychain);
} else if (command === "delete-generic-password") {
  const keychain = readKeychain();
  if (!keychain.unlocked || !probe || !keychain.probe) process.exit(1);
  delete keychain.probe;
  saveKeychain(keychain);
} else if (command === "unlock-keychain") {
  const keychain = readKeychain();
  keychain.unlocked = input[2] === keychain.password;
  saveKeychain(keychain);
  process.stderr.write("passphrase not correct (-25293)");
  process.exit(1);
} else if (command === "show-keychain-info") {
  if (!existsSync(input.at(-1)!)) process.exit(1);
} else if (command === "set-keychain-settings") {
  if (!readKeychain().unlocked) process.exit(1);
} else process.exit(4);
