import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getAdapter } from "../../src/adapters/index.js";
import { loadConfig } from "../../src/config.js";
import { sessionRegistryPath } from "../../src/session/registry.js";
import { sessionCanaryLaunchCount } from "../../src/hermetic-session-canary-home.js";
import type { AgentId, CodemuxConfig } from "../../src/types.js";
import { MARKER as EXPERIMENT_MARKER } from "../../tests/fixtures/experiment-mcp.js";
import { isDefaultCodemux, runPool, type ProbeResult, type ProbeRunner } from "./runner.js";
import { providerOverridePreflight, type GateOptions } from "./options.js";
import {
  liveSessionLeak,
  modelAliasFor,
  verifyAliasEnvelope,
} from "./aliases.js";
import {
  PROVIDER_OVERRIDE_OPT_IN,
  prepareExperimentProbe,
  prepareMediumProbe,
  verifyMediumAnswer,
  prepareSessionProbe,
  probeApplies,
  sessionStartedId,
  unsupportedNote,
  verifyExperimentEcho,
  verifyResultEnvelope,
  verifySessionTurn,
  type HarnessFacts,
  type ProbeLetter,
} from "./probes.js";
import { verifyPrintedSandbox } from "./print-probe.js";
import {
  prepareNoNetProbe,
  providerOverrideEnv,
  sandboxPrefixFromPrint,
  startFakeProvider,
  startReachableListener,
  verifyOverrideLog,
  verifyProviderOverrideEnvelope,
  type LoopbackServer,
} from "./loopback.js";
import { quotaRefusalIn, type GateQuotaDecision } from "./quota.js";
import type { GateRow } from "./report.js";

const OUTER_TIMEOUT_GRACE_SECONDS = 30;
// Probe H2's proof is the fake provider's request log, complete within
// seconds of the launch; a harness that retries the fake's minimal answer
// until its own timeout adds nothing (opencode ran the full 600 s on
// 2026-11-06), so the H2 launch is bounded apart from --timeout.
export const LOOPBACK_TIMEOUT_SECONDS = 120;
const ROOT = resolve(import.meta.dir, "../..");
const FIXTURE_SERVER = join(ROOT, "tests/fixtures/experiment-mcp.ts");

export async function runProbes(
  facts: readonly HarnessFacts[],
  options: GateOptions,
  runner: Pick<ProbeRunner, "run" | "capture">,
  reportDirectory: string,
  env: Record<string, string | undefined> = process.env,
  // Undefined means "the effective config, read when probe I first needs
  // it": a run without I (and every test) never touches the config file.
  config?: CodemuxConfig,
  // Per-harness quota refusals decided from the gate's ONE usage snapshot
  // before any probe spawns (parity pass, 2.0.0): a harness the launch
  // path would refuse gets SKIP cells naming the refusal instead of
  // burning a spawn that cannot succeed. Undefined runs without the
  // decisions (every test that does not build them).
  quota?: ReadonlyMap<AgentId, GateQuotaDecision>,
): Promise<GateRow[]> {
  const rows: GateRow[] = [];
  const tasks: (() => Promise<void>)[] = [];
  // Fail closed before any probe spawns: an opt-in provider-override run
  // with a missing variable would probe the operator's default account.
  providerOverridePreflight(facts, options, env);
  // Probe J's listener outlives the pool: every J cell curls the same
  // provably-reachable loopback port (audit D7).
  const listener: LoopbackServer | null = options.probes.includes("J") ? await startReachableListener() : null;
  const skip = (note: string): ProbeResult => ({ status: "SKIP", seconds: 0, stderr: "", note });
  // An UNSUPPORTED cell is the documented-harness-limitation verdict; a
  // cell with no reason documents nothing, and a missing reason on a
  // capability the adapter declares is codemux's gap, not the harness's.
  // It fails closed rather than pass as structural (parity pass, 2.0.0).
  const unsupported = (letter: ProbeLetter, fact: HarnessFacts): ProbeResult => {
    const note = unsupportedNote(letter, fact);
    return note === ""
      ? { status: "FAIL", seconds: 0, stderr: `probe ${letter} reported UNSUPPORTED with no documented reason` }
      : { status: "UNSUPPORTED", seconds: 0, stderr: "", note };
  };
  // Everything from here runs under one finally that closes the listener:
  // a throwing adapter constructor or loginState() in the pre-check loop
  // used to leave the socket open and the process alive (review round 45).
  try {
  for (const fact of facts.filter((fact) => !options.only || options.only.has(fact.id))) {
    const row: GateRow = { agent: fact.id, results: {} };
    rows.push(row);
    // The gate itself checks the login state before the matrix (audit D8):
    // a harness whose credential store is absent would burn its probe on a
    // login refusal, so the row says SKIP naming the store instead. H2 is
    // exempt — its credentials come from the loopback override, not the
    // operator's — and so are J and P, which start no harness; and
    // --probe-anyway forces the run when the operator says
    // the store is there. A harness the operator skipped is never looked
    // at: the gate constructs no adapter for it (the main test pins this).
    // In candidate mode the credential locations are the candidate's, not
    // this checkout's adapter's, so no pre-check skip: the probe judges
    // (review round 52).
    const login = options.skip.has(fact.id) || !isDefaultCodemux(options.codemux) ? undefined : getAdapter(fact.id, env).loginState();
    const noCredential = login?.state === "no-credential" && !options.probeAnyway.has(fact.id);
    for (const letter of options.probes) {
      if (!probeApplies(letter, fact)) {
        row.results[letter] = unsupported(letter, fact);
        continue;
      }
      if (options.skip.has(fact.id)) {
        row.results[letter] = skip("no credentials; operator requested");
        continue;
      }
      if (letter === "H" && env[PROVIDER_OVERRIDE_OPT_IN] !== "1") {
        row.results[letter] = skip(`opt-in probe: --probe provider-override with ${PROVIDER_OVERRIDE_OPT_IN}=1 and the CODEMUX_${fact.id.toUpperCase()}_PROVIDER_* environment exported`);
        continue;
      }
      if (noCredential && letter !== "H2" && letter !== "J" && letter !== "P") {
        row.results[letter] = skip(`no credentials detected: ${login?.store ?? "no credential store"}`);
        continue;
      }
      // The quota decisions name the native account. H spends nothing from
      // it (its credentials are the provider override) and H2, J, and P
      // start no native run at all, so none of the four is blocked by a
      // native-account refusal; every other letter on a refused harness
      // skips naming the refusal the launch path would print.
      const quotaRefused = quota?.get(fact.id)?.refused === true
        && letter !== "H" && letter !== "H2" && letter !== "J" && letter !== "P";
      if (quotaRefused) {
        row.results[letter] = skip(`quota gate refused this harness before the probes: ${quota!.get(fact.id)!.reason}`);
        continue;
      }
      tasks.push(async () => {
        let directory: string | undefined;
        try {
          directory = mkdtempSync(join(tmpdir(), "codemux-live-gate-"));
          const prefix = join(reportDirectory, `${fact.id}-${letter}`);
          const base = (level: string, prompt: string, extra: string[] = [], passEnv = options.passEnv,
            timeout = options.timeout): string[] => [
            options.codemux, "run", "-a", fact.id,
            ...(passEnv === undefined ? [] : ["--pass-env", passEnv]),
            ...extra, "--auto", level, "--timeout", String(timeout), "-p", prompt, "--cwd", directory!,
          ];
          const outer = options.timeout + OUTER_TIMEOUT_GRACE_SECONDS;
          // A hermetic check is two sequential launches — the probe child,
          // then the control child — each with the full --timeout
          // (src/check-command.ts), so its outer allowance must cover both
          // plus one grace (round 18, edges 3). The single-launch probes
          // keep the one-timeout allowance.
          const checkOuter = 2 * options.timeout + OUTER_TIMEOUT_GRACE_SECONDS;
          // The hermetic canary uses three sessions; supported harnesses
          // also start and resume a caller-owned home. Each has --timeout.
          const sessionOuter = sessionCanaryLaunchCount(fact.id) * options.timeout + OUTER_TIMEOUT_GRACE_SECONDS;
          if (letter === "A") {
            row.results.A = await runner.run(base("read-only", "Reply with exactly: OK"), "OK", outer, prefix);
          } else if (letter === "B") {
            const medium = prepareMediumProbe(directory);
            row.results.B = await runner.capture(base("medium", medium.prompt),
              (captured) => verifyMediumAnswer(captured.stdout, medium.expected), outer, prefix);
          } else if (letter === "C") {
            row.results.C = await runner.capture(base("read-only", "Reply with exactly: OK", ["--result-json"]),
              (captured) => verifyResultEnvelope(captured.stdout, fact.id), outer, prefix);
          } else if (letter === "D") {
            row.results.D = await runner.capture([
              options.codemux, "check", "-a", fact.id,
              ...(options.passEnv === undefined ? [] : ["--pass-env", options.passEnv]),
              "--hermetic", "--timeout", String(options.timeout),
            ], () => null, checkOuter, prefix);
          } else if (letter === "E") {
            // The plain `--tools none` control at read-only (parity pass,
            // 2.0.0): every adapter that declares the capability runs it,
            // and exactly the ones whose `--tools none` works only inside a
            // hermetic run (opencode, toolsNoneRequiresHermetic) carry
            // --hermetic. The old form ran the hermetic spelling alone and
            // left every other tools-capable harness UNSUPPORTED.
            row.results.E = await runner.run(base("read-only", "Reply with exactly: OK",
              fact.toolsNoneRequiresHermetic ? ["--hermetic", "--tools", "none"] : ["--tools", "none"]),
              "OK", outer, prefix);
          } else if (letter === "F") {
            const startedMs = Date.now();
            const session = prepareSessionProbe();
            // The registry records the canonicalized cwd (validation.ts
            // realpathSync), while mkdtemp answers the raw spelling — a
            // symlink (/var/folders) on macOS — so the leak check must
            // compare like with like (review round 14, contracts 6).
            let canonicalCwd: string | undefined;
            try {
              canonicalCwd = realpathSync(directory);
            } catch {
              canonicalCwd = undefined;
            }
            row.results.F = await runner.capture([
              options.codemux, "session", "-a", fact.id,
              ...(options.passEnv === undefined ? [] : ["--pass-env", options.passEnv]),
              "--auto", "read-only", "--cwd", directory, "--timeout", String(options.timeout),
            ], (captured) => verifySessionTurn(captured.stdout, session.nonce) ??
                // Only the probe's own record can fail it: an unrelated
                // live session of the same agent is not this probe's leak.
                liveSessionLeak(fact.id, startedMs, sessionRegistryPath(), sessionStartedId(captured.stdout), canonicalCwd),
              outer, prefix, session.exchange);
          } else if (letter === "K") {
            // Lane H4: the session-shaped hermetic canary. `check
            // --hermetic --session` drives hermetic and caller-home
            // sessions of the build under test; the outer allowance
            // covers every supported arm, including both resumes.
            // The verdict is the check's own OK line: the canary already
            // refuses, leaks, and cleans up inside itself.
            row.results.K = await runner.capture([
              options.codemux, "check", "-a", fact.id,
              ...(options.passEnv === undefined ? [] : ["--pass-env", options.passEnv]),
              "--hermetic", "--session", "--timeout", String(options.timeout),
            ], (captured) => captured.stdout.includes(`HERMETIC SESSION ${fact.id}: OK`)
              ? null
              : `the check reported no HERMETIC SESSION ${fact.id}: OK line`,
            sessionOuter, prefix);
          } else if (letter === "G") {
            // The spec carries the prefixes of the build under test: the
            // candidate's own listing when one is probed (harnessFacts folded
            // it into fact.experimentPrefixes), this checkout's table
            // otherwise. Reading the static table here made a candidate with
            // a different prefix fail G for a reason that is not the
            // candidate's (lane C30, item 1).
            const experiment = prepareExperimentProbe(fact.id, directory, FIXTURE_SERVER, fact.experimentPrefixes);
            // A codex experiment refuses a request without an explicit
            // model (model_required, src/experiment-codex-model.ts), so the
            // codex G probe carries one (--codex-model, `worker` by default), which resolves through the
            // operator's model-alias config. The other experiment harnesses
            // default and carry no model. The reply is verified to carry
            // the fixture's marker — bare, or under the harness's own
            // wall-time header for codex and kimi — and the DELIVERY is
            // verified from the recording the spec wrote into this probe
            // directory (finding 2): the model_tool_result record holds the
            // result as delivered to the model, header first, and models
            // drop the header when they echo, so the reply alone proved
            // nothing about the header (review round 14, edges 1; round 15,
            // blocker).
            const model = fact.id === "codex" ? ["-m", options.codexModel] : [];
            row.results.G = await runner.capture(base("read-only", experiment.prompt,
              ["--hermetic", "--tools", "none", "--experiment-mcp", experiment.path, ...model]),
              (captured) => verifyExperimentEcho(captured.stdout, EXPERIMENT_MARKER, fact.id, directory!), outer, prefix);
          } else if (letter === "H2") {
            // Audit D9: the loopback twin of probe H. The gate serves a
            // fake provider on 127.0.0.1 and points the run's provider
            // override at it — no provider quota, no real credential
            // reachable. The proof is the fake's request log (no request
            // carried another credential; one carrying the override key
            // named the override model), never the envelope or the exit
            // code, so the run may fail on the fake's minimal answer and
            // the probe still pass.
            const apiKey = `loopback-${randomBytes(16).toString("hex")}`;
            const overrideModel = `loopback-probe-${randomBytes(6).toString("hex")}`;
            const provider = await startFakeProvider({ apiKey });
            try {
              const upper = fact.id.toUpperCase();
              const names = [options.passEnv, providerOverrideEnv(fact.id)].filter((name) => name !== undefined).join(",");
              // --sandbox-scrub-env strips the operator's real credentials
              // from the child's environment, so a candidate that ignored
              // the override cannot spend them from env (review round 45);
              // credential files in the harness state dirs remain its
              // documented residual (docs/RELEASE-GATE.md, row H2).
              const bounded = Math.min(options.timeout, LOOPBACK_TIMEOUT_SECONDS);
              row.results.H2 = await runner.capture(
                base("read-only", "Reply with exactly: OK", ["--sandbox-scrub-env"], names === "" ? undefined : names, bounded),
                () => verifyOverrideLog(provider.requests(), overrideModel),
                bounded + OUTER_TIMEOUT_GRACE_SECONDS, prefix, undefined,
                {
                  env: {
                    [`CODEMUX_${upper}_PROVIDER_BASE_URL`]: `http://127.0.0.1:${provider.port}`,
                    [`CODEMUX_${upper}_PROVIDER_API_KEY`]: apiKey,
                    [`CODEMUX_${upper}_PROVIDER_MODEL`]: overrideModel,
                  },
                  allowAnyExit: true,
                });
            } finally {
              await provider.close();
            }
          } else if (letter === "I") {
            // Audit D7, split in the 2.0.0 parity pass: the model-alias
            // wiring alone. The alias resolves from the same effective
            // config the launched run reads, so the target verified here is
            // the target the run selected. Where the harness reports result
            // JSON (probe C's set), the envelope's codemux.model must name
            // that target. (--effort moved to I2, so a harness that
            // declares model without effort gets its alias probed too.)
            const alias = modelAliasFor(fact.id, config ?? loadConfig());
            if (alias === null) {
              row.results.I = skip(`no model alias is configured for ${fact.id}`);
            } else if (fact.resultJson) {
              row.results.I = await runner.capture(
                base("read-only", "Reply with exactly: OK", ["-m", alias.alias, "--result-json"]),
                (captured) => verifyAliasEnvelope(captured.stdout, fact.id, alias.model), outer, prefix);
            } else {
              row.results.I = await runner.run(
                base("read-only", "Reply with exactly: OK", ["-m", alias.alias]),
                "OK", outer, prefix);
            }
          } else if (letter === "I2") {
            // The effort half of the old alias+effort probe: `--effort low`
            // on a plain read-only run. Every adapter that declares effort
            // accepts "low" (its effortLevels list carries it), and the
            // level is not observable in the reply or the envelope, so the
            // exact OK output is the verdict, like probe A with the flag.
            row.results.I2 = await runner.run(
              base("read-only", "Reply with exactly: OK", ["--effort", "low"]),
              "OK", outer, prefix);
          } else if (letter === "J") {
            // Audit D7: the sandbox policy flags as the release contract
            // runs them — together. Two steps, no model turn: the launch
            // prints the sandbox it would build for this harness, and the
            // gate runs its own script behind that scode prefix. The script
            // curls a port the gate itself serves on loopback, so BLOCKED
            // proves the printed policy blocks a reachable address. A model
            // turn cannot carry this proof: under --sandbox-no-net the
            // harness cannot reach its provider (live gate, 2026-11-06).
            if (listener === null) throw new Error("the probe J listener never started");
            const noNet = prepareNoNetProbe(directory, listener.port);
            let sandbox: string[] = [];
            const printed = await runner.capture(
              base("medium", "Reply with exactly: OK",
                ["--sandbox-no-net", "--sandbox-scrub-env", "--sandbox-trust", "standard", "--print-sandbox"]),
              (captured) => {
                const parsed = sandboxPrefixFromPrint(captured.stdout);
                if ("problem" in parsed) return parsed.problem;
                sandbox = parsed.argv;
                return null;
              }, outer, `${prefix}-print`);
            if (printed.status !== "PASS") {
              row.results.J = printed;
            } else {
              // A real launch scrubs ambient SCODE_* names before it starts
              // scode (src/sandbox.ts), so the script runs without them too:
              // an exported SCODE_ACCOUNT_FILE would otherwise test another
              // sandbox and write accounting lines (review round 188).
              const unset = Object.keys(env).filter((name) => name.toUpperCase().startsWith("SCODE_"))
                .flatMap((name) => ["-u", name]);
              const ran = await runner.run(
                [...(unset.length === 0 ? [] : ["env", ...unset]), ...sandbox, "/bin/sh", noNet.script],
                noNet.expected, outer, prefix);
              // Both steps' warnings reach the row: a print that passed with
              // a stale-contract warning must not lose it to the second step.
              const notes = [printed.note, ran.note].filter((note) => note !== undefined && note !== "");
              row.results.J = {
                ...ran, seconds: printed.seconds + ran.seconds,
                ...(notes.length === 0 ? {} : { note: notes.join("; ") }),
              };
            }
          } else if (letter === "P") {
            // Zero quota: the launch prints the scode argv and exits 0
            // without a child, a credential read, or a Keychain write. The
            // argv must name scode and the harness; a refusal or an empty
            // print fails the row.
            row.results.P = await runner.capture(
              base("read-only", "Reply with exactly: OK", ["--print-sandbox"]),
              (captured) => verifyPrintedSandbox(captured.stdout, fact.id, fact.binaryName), outer, prefix);
          } else if (letter === "H") {
            const names = [options.passEnv, providerOverrideEnv(fact.id)].filter((name) => name !== undefined).join(",");
            const overrideModel = env[`CODEMUX_${fact.id.toUpperCase()}_PROVIDER_MODEL`];
            if (overrideModel === undefined || overrideModel === "") {
              // Unreachable after providerOverridePreflight; this row still
              // fails closed rather than verify an envelope without a model
              // to compare against.
              throw new Error(`CODEMUX_${fact.id.toUpperCase()}_PROVIDER_MODEL is missing or empty`);
            }
            row.results.H = await runner.capture(base("read-only", "Reply with exactly: OK", ["--result-json"],
              names === "" ? undefined : names),
              (captured) => verifyProviderOverrideEnvelope(captured.stdout, overrideModel, fact.id), outer, prefix);
          } else {
            row.results[letter as ProbeLetter] = { status: "FAIL", seconds: 0, stderr: `unknown probe ${letter}` };
          }
          // A FAIL whose stderr is a quota refusal is an account state, not
          // a behavior failure (parity pass, 2.0.0): the live gate of
          // 2026-11-08 printed codex, agy, and kimi rows as FAILs that
          // were exhausted quotas. The row becomes a SKIP naming the
          // refusal, the same verdict the pre-spawn decisions above hand
          // out; reclassifying here (not in the runner) keeps the runner's
          // FAIL contract — probe semantics, not output forensics.
          const probed = row.results[letter];
          if (probed?.status === "FAIL") {
            const refusal = quotaRefusalIn(probed);
            if (refusal !== null) {
              row.results[letter] = { status: "SKIP", seconds: probed.seconds, stderr: "", note: [refusal, probed.stderr, probed.note].filter(Boolean).join("; ") };
            }
          }
        } catch {
          row.results[letter] = { status: "FAIL", seconds: 0, stderr: "could not prepare or run probe" };
        } finally {
          if (directory) {
            try {
              const result = row.results[letter];
              if (result?.status === "FAIL") {
                // A failed probe keeps its working directory beside the
                // report: the experiment recording and any probe files are
                // the evidence a failure needs (the 2026-11-02 codex G
                // timeout left none). The copy lives under the report
                // directory, so a tmpdir on another volume is no obstacle.
                // A failed copy is noted and never skips the removal
                // (review round 56).
                const kept = join(reportDirectory, `${fact.id}-${letter}-probe`);
                try {
                  cpSync(directory, kept, { recursive: true });
                  row.results[letter] = { ...result, note: [result.note, `probe directory kept at ${kept}`].filter(Boolean).join("; ") };
                } catch (error) {
                  row.results[letter] = { ...result, note: [result.note, `probe directory could not be kept: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join("; ") };
                }
              }
              rmSync(directory, { recursive: true, force: true });
            } catch {
              row.results[letter] = { status: "FAIL", seconds: row.results[letter]?.seconds ?? 0, stderr: "could not clean probe directory" };
            }
          }
        }
      });
    }
  }
  await runPool(tasks, options.jobs);
  } finally {
    await listener?.close();
  }
  return rows;
}

export function createReportDirectory(scratch: string): string {
  const base = existsSync(scratch) ? join(scratch, "live-gate") : tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "codemux-live-gate-report-"));
}
