import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
type Entry = { name: string; args?: string[]; secure?: string; config?: string; home?: string; privateCredential?: boolean };

function hashes(paths: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (path: string): void => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else result[file] = createHash("sha256").update(readFileSync(file)).digest("hex");
    }
  };
  for (const path of paths) visit(path);
  return result;
}

test("PATH shims: launch and information paths make no native credential calls or login writes", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codemux-native-login-")));
  const home = join(root, "home");
  const work = join(root, "work");
  const bin = join(root, "bin");
  const log = join(root, "calls.jsonl");
  const stores = ["Library/Keychains", "Library/Preferences", ".claude", ".gemini/antigravity-cli", ".kimi-code/credentials"];
  for (const dir of [home, work, bin, join(home, "profile"), join(home, "secure"), join(work, ".git"), ...stores.map((dir) => join(home, dir))]) mkdirSync(dir, { recursive: true });
  const seed = (relative: string, text: string) => writeFileSync(join(home, relative), text, { mode: 0o600 });
  seed("Library/Keychains/login.keychain-db", "synthetic-native-store");
  seed("Library/Preferences/com.apple.security.plist", "synthetic-preferences");
  seed(".claude/.credentials.json", JSON.stringify({ claudeAiOauth: { accessToken: "synthetic", refreshToken: "synthetic-refresh" } }));
  for (const dir of ["profile", "secure"]) seed(`${dir}/.credentials.json`, '{"claudeAiOauth":{"accessToken":"synthetic","refreshToken":"synthetic"}}');
  seed(".gemini/antigravity-cli/antigravity-oauth-token", "synthetic-agy");
  seed(".kimi-code/credentials/kimi-code.json", JSON.stringify({ access_token: "synthetic", refresh_token: "synthetic-refresh" }));
  seed(".kimi-code/device_id", "synthetic-device");
  seed(".kimi-code/region", "synthetic-region");
  writeFileSync(log, "");
  symlinkSync(process.execPath, join(bin, "bun"));
  for (const name of ["security", "codexbar", "claude", "agy", "kimi", "scode", "usagemux"]) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(import.meta.dir, "fixtures/native-login-shim.ts"))} ${quote(name)} ${quote(log)} "$@"\n`);
    chmodSync(path, 0o755);
  }
  // No ambient credentials, provider settings, or installed executables enter the fixture.
  const env = { HOME: home, USERPROFILE: home, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: root,
    XDG_CONFIG_HOME: join(home, ".config"), CODEMUX_TEST_LEDGER: join(root, "ledger.jsonl") };
  const entries = (): Entry[] => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  // codemux creates nothing in Kimi's credential directory: no lock file of its own (review round 5).
  const loginFiles = [join(home, "Library/Keychains"), join(home, "Library/Preferences"), join(home, ".kimi-code/credentials")];
  const fixedFiles = [".claude/.credentials.json", "profile/.credentials.json", "secure/.credentials.json",
    ".gemini/antigravity-cli/antigravity-oauth-token", ".kimi-code/device_id", ".kimi-code/region"];
  const snapshot = () => ({ ...hashes(loginFiles), ...Object.fromEntries(fixedFiles.map((name) => [name,
    createHash("sha256").update(readFileSync(join(home, name))).digest("hex")])) });
  const before = snapshot();
  const invoke = async (args: string[], session = false, expectedCode = 0, extraEnv: NodeJS.ProcessEnv = {}) => {
    const child = Bun.spawn([join(repo, "bin/codemux"), ...args], { cwd: work, env: { ...env, ...extraEnv }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    let stdout = "";
    let stopped = false;
    const timer = setTimeout(() => { stopped = true; child.kill(); }, 15_000);
    if (session) child.stdin.write(`${JSON.stringify({ type: "user", text: "scenario:basic" })}\n`);
    else child.stdin.end();
    const output = (async () => {
      for await (const part of child.stdout) {
        stdout += new TextDecoder().decode(part);
        if (session && stdout.includes('"type":"turn_completed"')) {
          session = false;
          child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
          child.stdin.end();
        }
      }
    })();
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited, output]);
    clearTimeout(timer);
    expect({ args, stderr, stdout, stopped, exitCode }).toMatchObject({ stopped: false, exitCode: expectedCode });
    expect(entries().filter((entry) => entry.name === "security" || entry.name === "codexbar")).toEqual([]);
    expect(snapshot()).toEqual(before);
  };
  try {
    for (const agent of ["claude", "agy", "kimi"]) {
      for (const mode of [["--no-sandbox"], ["--sandbox"], ["--sandbox", "--hermetic"]]) {
        await invoke(["run", "-a", agent, "--cwd", work, "--auto", mode.includes("--no-sandbox") ? "high" : "low", "-p", "OK", ...mode]);
      }
      await invoke(["session", "-a", agent, "--cwd", work, "--sandbox", "--hermetic", "--final", "--timeout", "5", "--shutdown-grace", "1"], true);
      // Preserve the existing unmapped-mode verdict for agy, and check its no-I/O boundary too.
      await invoke(["run", "-a", agent, "--cwd", work, "-p", "OK", "--sandbox",
        "--hermetic", "--experiment-project-settings", "--auto", "low"], false, agent === "agy" ? 64 : 0);
    }
    await invoke(["run", "-a", "claude", "--cwd", work, "-p", "OK", "--sandbox", "--hermetic", "--sandbox-scrub-env"]);
    await invoke(["session", "-a", "claude", "--cwd", work, "--sandbox", "--harness-home", join(root, "caller"), "--final"], true);
    await invoke(["tui", "-a", "claude", "--cwd", work, "--sandbox", "--sandbox-scrub-env"]);
    await invoke(["list"]);
    await invoke(["usage", "--all", "--json"]);
    // The shared fake Claude binary makes Z.AI installed, with its required key absent.
    await invoke(["doctor", "--format", "json"], false, 1);
    expect(entries().some((entry) => entry.name === "usagemux")).toBe(true); // actual quota gate, fake backend
    const launches = entries().filter((entry) => entry.name === "claude");
    expect(launches.length).toBeGreaterThanOrEqual(6);
    if (process.platform === "darwin") {
      expect(launches.every((entry) => entry.secure === "")).toBe(true);
      expect(launches.some((entry) => entry.config !== undefined)).toBe(true);
      expect(launches.every((entry) => entry.privateCredential === false)).toBe(true);
      expect(launches.every((entry) => entry.home === home)).toBe(true);
      for (const extraEnv of [
        { CLAUDE_CONFIG_DIR: join(home, "profile") },
        { CLAUDE_CONFIG_DIR: join(home, "profile"), CLAUDE_SECURESTORAGE_CONFIG_DIR: join(home, "secure") },
        { CLAUDE_CONFIG_DIR: join(home, "profile"), CLAUDE_SECURESTORAGE_CONFIG_DIR: "" },
      ]) {
        for (const mode of ["run", "session", "tui"]) {
          // The hermetic session redirects configuration to a private directory and keeps the
          // operator profile's login. The run and the tui redirect nothing: their child gets no
          // CLAUDE_CONFIG_DIR (it is not forwarded) and reads ~/.claude, so its login is the
          // default item too (review round 4, correctness 3).
          const expected = extraEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? (mode === "session" ? extraEnv.CLAUDE_CONFIG_DIR : "");
          const flags = mode === "run" ? ["--hermetic", "-p", "OK"] : mode === "session" ? ["--hermetic", "--final"] : [];
          await invoke([mode, "-a", "claude", "--cwd", work, "--sandbox", "--sandbox-scrub-env", ...flags], mode === "session", 0, extraEnv);
          expect(entries().filter((entry) => entry.name === "claude").at(-1)?.secure, mode).toBe(expected);
          const launch = entries().filter((entry) => entry.name === "claude").at(-1)!;
          // The selection and the configuration the child reads agree.
          expect(launch.config === undefined, mode).toBe(mode !== "session");
          if (mode !== "tui") expect(launch.privateCredential).toBe(false);
        }
      }
      for (const agent of ["claude", "zai"]) {
        const gateway = agent === "claude" ? { CODEMUX_CLAUDE_PROVIDER_BASE_URL: "http://127.0.0.1:9999",
          CODEMUX_CLAUDE_PROVIDER_API_KEY: "synthetic", CODEMUX_CLAUDE_PROVIDER_MODEL: "sonnet" } : { ZAI_API_KEY: "synthetic" };
        for (const mode of ["run", "session", "tui"]) {
          const flags = mode === "run" ? ["--hermetic", "-p", "OK"] : mode === "session" ? ["--hermetic", "--final"] : [];
          await invoke([mode, "-a", agent, "--cwd", work, "--sandbox", "--sandbox-scrub-env", ...flags], mode === "session", 0,
            { ...gateway, CLAUDE_SECURESTORAGE_CONFIG_DIR: join(home, "secure") });
          expect(entries().filter((entry) => entry.name === "claude").at(-1)?.secure).toBeUndefined();
          const lastSandbox = entries().filter((entry) => entry.name === "scode").at(-1)!;
          expect(lastSandbox.args).not.toContain(join(home, "Library/Keychains"));
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
