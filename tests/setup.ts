/**
 * The preload replaces inherited ledger and state roots before tests run.
 * Neither an operator's CALL_LOG nor an inherited TEST_LEDGER may redirect
 * test receipts outside this process's fresh temporary directory.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./fixtures/agy-host.js";
import { agyKeychainHost } from "../src/agy-keychain.js";
import { sessionCanary } from "../src/hermetic-session-canary-driver.js";
import { sweepLeakedFixtures, type TrackedFixture } from "./helpers/fixture-leak.js";

const dir = mkdtempSync(join(tmpdir(), "codemux-test-ledger-"));
// Test files create their fixtures with mkdtemp under the ignored
// scratch/fix directory, which a fresh checkout does not have: a file that
// ran before any other had created it failed with ENOENT (a fresh CI
// checkout, run 42681779732's environment). The preload creates it once.
mkdirSync(join(import.meta.dir, "../scratch/fix"), { recursive: true });
// No in-process test may read file-fallback credentials from the real home.
agyKeychainHost.home = () => dir;
// Nor may the claude session canary's control copy the operator's mirror.
sessionCanary.credentialSource = () => join(dir, "no-claude-credential.json");
delete process.env.CODEMUX_CALL_LOG;
process.env.CODEMUX_TEST_LEDGER = join(dir, "calls.jsonl");
process.env.HOME = dir;
process.env.USERPROFILE = dir;
for (const [name, suffix] of Object.entries({ XDG_CONFIG_HOME: ".config", XDG_DATA_HOME: ".local/share",
  XDG_STATE_HOME: ".local/state", XDG_CACHE_HOME: ".cache" })) process.env[name] = join(dir, suffix);
// In-process launch-command tests must not consult the operator's real
// usagemux through the quota gate (an expired host credential would fail
// the suite; a healthy one would pass it only by luck). The seam is a
// random nonce generated here and mirrored on globalThis: the gate
// honors the variable only when the two match (src/quota-gate.ts), so
// the variable alone — exported by an operator, or leaked into a child —
// disables nothing outside a test preload (round 20, minor 15). The CLI
// test helper strips it from spawned children so they run the real gate.
const quotaGateNonce = crypto.randomUUID();
(globalThis as { __codemuxTestNoQuotaGate?: string }).__codemuxTestNoQuotaGate = quotaGateNonce;
process.env.CODEMUX_TEST_NO_QUOTA_GATE = quotaGateNonce;

/**
 * The fixture-leak guard: detached fixture processes that must not outlive
 * the run (two base.test.ts (now the base-*.test.ts split) orphan fixtures
 * leaked onto the host on October
 * 29, parents reparented to pid 1). A test that starts one registers its
 * identity file — `pid\nstart`, written through tests/helpers/fixture-leak.ts
 * — here and unregisters in its finally; at process exit every still
 * registered fixture whose recorded identity is alive is killed by process
 * group and the run is failed loudly, so a crashed cleanup cannot pass
 * silently and a reused pid is never mistaken for the fixture (the start
 * token must match).
 */
const trackedFixtures: TrackedFixture[] = [];

export function trackFixtureProcess(fixture: TrackedFixture): () => void {
  trackedFixtures.push(fixture);
  return () => {
    const at = trackedFixtures.indexOf(fixture);
    if (at !== -1) trackedFixtures.splice(at, 1);
  };
}

process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort; a leftover temp directory is not a failure.
  }
  for (const killed of sweepLeakedFixtures(trackedFixtures)) {
    console.error(`leaked fixture still alive at exit: ${killed.label} (pid ${killed.pid}); killed now`);
    process.exitCode = 1;
  }
});
