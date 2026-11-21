/** Offline PATH shims. No branch resolves or invokes an installed harness. */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [name, log, ...args] = process.argv.slice(2) as [string, string, ...string[]];
const record = (value: unknown) => appendFileSync(log, `${JSON.stringify(value)}\n`);
if (name === "security" || name === "codexbar") {
  record({ name });
  process.exit(97);
}
if (args.includes("--version")) {
  console.log(({ claude: "2.1.325", agy: "1.5.9", kimi: "2.5.2", scode: "scode 0.6.7",
    usagemux: "usagemux 1.0.1" } as Record<string, string>)[name]);
  process.exit(0);
}
if (name === "usagemux") {
  record({ name });
  const requested = args.flatMap((arg, index) => arg === "--client" ? [args[index + 1]!] : []);
  console.log(JSON.stringify({ schemaVersion: "1", generatedAt: new Date().toISOString(),
    results: (requested.length ? requested : ["claude", "agy", "kimi"]).map((client) => ({ client, provider: null, status: "ok", source: "fake",
      plan: null, account: null, windows: [{ kind: "weekly", remainingPercent: 99, usedPercent: 1,
        windowMinutes: 10080, resetsAt: null }], credits: null, subscriptionRenewsAt: null,
      subscriptionExpiresAt: null, message: null })) }));
  process.exit(0);
}
if (name === "scode") {
  if (args.includes("--help")) {
    console.log("--keep-env --allow-ro --no-credential-sync --scrub-env");
    process.exit(0);
  }
  record({ name, args });
  const keep = args.includes("--keep-env") ? args[args.indexOf("--keep-env") + 1]!.split(",") : [];
  let env = process.env;
  if (args.includes("--scrub-env")) {
    env = Object.fromEntries(Object.entries(env).filter(([key]) =>
      ["HOME", "PATH", "TMPDIR", ...keep].includes(key)));
  }
  const child = Bun.spawn(args.slice(args.indexOf("--") + 1), { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exit(await child.exited);
}
record({ name, config: process.env.CLAUDE_CONFIG_DIR, secure: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
  privateCredential: process.env.CLAUDE_CONFIG_DIR !== undefined && existsSync(join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json")),
  home: process.env.HOME, args });
const live = join(import.meta.dir, "live");
if (name === "agy") console.log('{"event":"init","init":{"tools":[]}}');
const session = args.includes("--input-format") || args.some((arg) => arg === "--streaming" || arg === "--input-format=stream-json");
if (name === "kimi" || session) {
  if (name === "kimi") {
    const wire = join(process.env.KIMI_CODE_HOME || join(process.env.HOME!, ".kimi-code"), "sessions", "workspace",
      "session_11111111-2222-3333-4444-555555555555", "agents", "main", "wire.jsonl");
    mkdirSync(dirname(wire), { recursive: true });
    writeFileSync(wire, JSON.stringify({ type: "usage.record", usageScope: "turn",
      usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 } }) + "\n");
  }
  const fixture = name === "claude" ? "fake-claude-session.ts" : name === "agy" ? "fake-agy-session.ts" : "fake-kimi-run.ts";
  const child = Bun.spawn([process.execPath, join(live, fixture), ...args], {
    env: { ...process.env, FAKE_STATE_DIR: `${log}.state` }, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exit(await child.exited);
}
await Bun.stdin.text();
console.log(JSON.stringify(name === "claude"
  ? { type: "result", subtype: "success", is_error: false, result: "OK" }
  : { event: "result", result: { status: "SUCCESS", response: "OK", usage: { input_tokens: 1, output_tokens: 1 } } }));
