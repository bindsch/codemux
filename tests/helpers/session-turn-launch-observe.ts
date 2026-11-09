// Loaded only by the synthetic harness wrappers in session-turn-launch.ts.
// Records the environment a session turn's process really ran under: the
// redirect variable each turn-per-process hermetic mode rides (HOME for
// droid and aider, PI_CODING_AGENT_DIR, GEMINI_CLI_HOME, COPILOT_HOME,
// GOOSE_PATH_ROOT) plus a state marker under the redirected home, so a
// test can prove the fresh, resume, and final turns of one session all
// ran inside the same private home. The marker names the home's
// persistence state: a surviving home shows the previous run's state, a
// recreated one starts it over.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME ?? "";
const piDir = process.env.PI_CODING_AGENT_DIR ?? null;
const geminiHome = process.env.GEMINI_CLI_HOME ?? null;
const copilotHome = process.env.COPILOT_HOME ?? null;
const gooseRoot = process.env.GOOSE_PATH_ROOT ?? null;
// The redirected home is the first redirect variable set, falling back
// to HOME itself — droid and aider carry their redirect there. An
// unredirected process (qwen and cursor keep no session home) falls back
// to the shared fixture home; the marker there is harmless, and those
// agents' tests assert on no marker.
const redirected = piDir ?? geminiHome ?? copilotHome ?? gooseRoot ?? home;
let mode: number | null = null;
let previous: string | null = null;
let state: string | null = null;
if (redirected !== null) {
  mkdirSync(redirected, { recursive: true });
  const marker = join(redirected, "synthetic-session-state");
  previous = existsSync(marker) ? readFileSync(marker, "utf8") : null;
  state = previous ?? crypto.randomUUID();
  if (previous === null) writeFileSync(marker, state, { mode: 0o600 });
  mode = statSync(redirected).mode & 0o777;
}
appendFileSync(
  join(process.env.FAKE_STATE_DIR!, "homes.jsonl"),
  `${JSON.stringify({
    home,
    piDir,
    geminiHome,
    copilotHome,
    gooseRoot,
    redirected,
    mode,
    previous,
    state,
  })}\n`
);
