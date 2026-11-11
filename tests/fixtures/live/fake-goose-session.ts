/**
 * A scenario-driven fake of headless goose (the per-turn process behind
 * a goose session driver), built from the wire the session module pins
 * (src/session/goose-session.ts and src/result-envelope/goose.ts, goose
 * 1.50.1): the turn is `goose run [--resume --session-id <id>]
 * --output-format json -t <prompt>` with the autonomy carried by the
 * environment (GOOSE_MODE and friends — this fake reads argv only), and
 * stdout is a startup banner followed by pretty `{messages, metadata}`
 * JSON. The identity is in the banner, not in an assistant message.
 * Source: goose-cli v1.50.1 session/output.rs and session/mod.rs.
 * This fixture renders the wire itself and
 * imports nothing from src/ — the fixture models the harness, so the
 * codemux parser and this file are two independent renderings of the
 * same pinned source.
 *
 * The session identity is deferred: goose mints a UTC date and counter
 * (SessionStorage::create_session), a fresh turn's argv carries no session
 * flag and the banner names the minted id, and a resumed turn's argv
 * carries BOTH --resume and --session-id (the binary's own rule) and
 * the banner must name that same id back.
 *
 * The scenario is the prompt's `scenario:<name>` prefix. Everything
 * received (argv, stdin bytes) is recorded as JSONL under
 * $FAKE_STATE_DIR. An argv that breaks the launch contract (no run
 * subcommand, no json output format, or no -t) prints nothing and
 * exits 2 — the fake fails closed rather than imitating a wire it was
 * not given.
 *
 *   basic (default) — progress chatter, the final object naming the
 *                     resumed id (or the minted id on a fresh turn),
 *                     exit 0
 *   errorturn       — the final object with an error text and exit 1
 *   nowire          — progress lines only, no JSON object, exit 1: the
 *                     driver's tier-3 fatal
 *   newid           — the final object naming an id OTHER than the
 *                     resumed one (the wrong-session rule; on a fresh
 *                     turn it just names the other id), exit 0
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.env.FAKE_STATE_DIR ?? "/tmp/fake-goose-session";
mkdirSync(stateDir, { recursive: true });
const record = (name: string, value: unknown): void => {
  appendFileSync(join(stateDir, name), `${JSON.stringify(value)}\n`);
};

const args = process.argv.slice(2);
record("argv.jsonl", { args, pid: process.pid });

/** The --session-id value in the spellings commander accepts. */
const flagValue = (
  args: readonly string[],
  names: readonly string[]
): string | undefined => {
  for (const name of names) {
    const i = args.indexOf(name);
    if (i !== -1 && i + 1 < args.length) return args[i + 1];
    const eq = `${name}=`;
    const hit = args.find((arg) => arg.startsWith(eq));
    if (hit !== undefined) return hit.slice(eq.length);
  }
  return undefined;
};

// The prompt rides argv (-t), so no stdin is read.
const prompt = flagValue(args, ["-t", "--text"]) ?? "";
record("stdin.jsonl", { prompt, bytes: Buffer.byteLength(prompt, "utf8"), eof: true });

// Native date-counter IDs, deliberately shorter than the legacy help example.
const MINTED_ID = "20261109_1";
const OTHER_ID = "20261109_2";

const resultObject = (sessionId: string, text: string): string =>
  `\n    __( O)>  ● new session · fixture model\n   \\____)     ${sessionId} · /workspace\n     L L     goose is ready\n${JSON.stringify({
    messages: [{ role: "assistant", id: "reply", content: [{ type: "text", text }] }],
    metadata: { status: "completed", total_tokens: 135, input_tokens: 110, output_tokens: 20,
      cache_read_input_tokens: 10, cache_write_input_tokens: 5 },
  }, null, 2)}\n`;

const contractHolds =
  args.includes("run") && args.includes("json") && (args.includes("-t") || args.includes("--text"));
const scenario = /^scenario:([a-z0-9-]+)/.exec(prompt)?.[1] ?? "basic";
const resumedId = flagValue(args, ["--session-id"]);
const sessionId = () => {
  if (scenario === "newid") return OTHER_ID;
  return resumedId ?? MINTED_ID;
};

if (!contractHolds) {
  // The launch broke the wire contract this fake exists to check: no
  // output that could be mistaken for the final object.
  process.stderr.write("fake goose: no run subcommand, no json output format, or no -t\n");
  process.exit(2);
}

// Progress chatter the binary prints around the object in every mode.
process.stdout.write("fake goose: warming up\n");

switch (scenario) {
  case "errorturn":
    process.stdout.write(resultObject(sessionId(), "the model refused the turn"));
    process.exit(1);
  case "nowire":
    process.stdout.write("fake goose: dying before the object was built\n");
    process.exit(1);
  case "newid":
  case "basic":
  default:
    process.stdout.write(resultObject(sessionId(), `Done: ${prompt}`));
    process.exit(0);
}
