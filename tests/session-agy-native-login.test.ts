import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function fixture(scodeVersion = "0.6.11") {
  const home = mkdtempSync(resolve("scratch/fix/agy-session-login-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const cwd = join(home, "work");
  mkdirSync(cwd);
  mkdirSync(join(home, "Library/Keychains"), { recursive: true });
  writeFileSync(join(home, "Library/Keychains/synthetic-login"), "not a keychain");
  // An empty file with the login keychain's name: the launch check requires
  // a HOME through which a default keychain resolves (src/darwin-keychain-home.ts).
  writeFileSync(join(home, "Library/Keychains/login.keychain-db"), "");
  const fake = createFakeBinaryEnv({
    scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
    agy: `if [ "$1" = "--version" ]; then printf '1.5.9\n'; exit 0; fi
if [ "$(uname)" = Darwin ]; then test -L "$HOME/Library/Keychains" || exit 91; fi
test -L "$HOME/.gemini/antigravity-cli/conversations" || exit 92
printf '%s' "$HOME" > "$HOME/.gemini/antigravity-cli/conversations/home.txt"
read -r frame
printf '%s\\n' '{"event":"result","result":{"conversation_id":"conv-keychain","status":"SUCCESS","response":"OK"}}'
cat >/dev/null`,
  }, scodeVersion);
  cleanup.push(fake.cleanup);
  // The synthetic filesystem models a native login without any native access.
  return { home, cwd, env: { ...fake.env, HOME: home, GEMINI_API_KEY: "", GOOGLE_API_KEY: "" } };
}

test("plain sandboxed agy sessions prepare the run login, preserve transcripts, and clean the temporary home", async () => {
  const f = fixture();
  const result = await runCli(["session", "-a", "agy", "--cwd", f.cwd, "--auto", "high", "--shutdown-grace", "2"],
    f.env, { stdin: '{"type":"user","text":"OK"}\n' });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain('"type":"turn_completed"');
  const transcript = join(f.home, ".gemini/antigravity-cli/conversations/home.txt");
  expect(existsSync(transcript)).toBe(true);
  const privateHome = readFileSync(transcript, "utf8");
  expect(privateHome).not.toBe(f.home);
  expect(existsSync(privateHome)).toBe(false);
  expect(readdirSync(join(f.home, ".gemini/.codemux-isolation-probes"))).toEqual([]);
  const resumed = await runCli(["session", "-a", "agy", "--resume", "conv-keychain", "--cwd", f.cwd,
    "--auto", "high", "--shutdown-grace", "2"], f.env, { stdin: '{"type":"user","text":"again"}\n' });
  expect(resumed.exitCode, resumed.stderr).toBe(0);
  expect(resumed.stdout).toContain('"type":"turn_completed"');
  expect(readFileSync(transcript, "utf8")).not.toBe(privateHome);
  expect(readdirSync(join(f.home, ".gemini/.codemux-isolation-probes"))).toEqual([]);
});

test.each([false, true])("plain agy session preview creates no login or conversation directory; strict=%s", async (strict) => {
  const f = fixture();
  const result = await runCli(["session", "-a", "agy", "--cwd", f.cwd, "--print-sandbox",
    ...(strict ? ["--sandbox-strict"] : [])], f.env);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain(".codemux-isolation-probes/preview");
  if (strict) expect(result.stdout).toContain("--allow-ro");
  expect(existsSync(join(f.home, ".gemini"))).toBe(false);
});
