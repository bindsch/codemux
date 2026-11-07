import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getAdapter, getAvailableAdapters } from "../../src/adapters/index.js";
import { loadConfig } from "../../src/config.js";
import { SESSION_AGENTS } from "../../src/session/cli.js";
import { sessionRegistryPath } from "../../src/session/registry.js";
import type { AgentId, CodemuxConfig } from "../../src/types.js";
import { MARKER as EXPERIMENT_MARKER } from "../../tests/fixtures/experiment-mcp.js";
import { isDefaultCodemux, runPool, type ProbeResult, type ProbeRunner } from "./runner.js";
import { providerOverridePreflight, type GateOptions } from "./options.js";
import {
  PROVIDER_OVERRIDE_OPT_IN,
  harnessFacts,
  prepareExperimentProbe,
  prepareMediumProbe,
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
import type { GateRow } from "./report.js";

const OUTER_TIMEOUT_GRACE_SECONDS = 30;
// Probe H2's proof is the fake provider's request log, complete within
// seconds of the launch; a harness that retries the fake's minimal answer
// until its own timeout adds nothing (opencode ran the full 600 s on
// 2026-11-06), so the H2 launch is bounded apart from --timeout.
export const LOOPBACK_TIMEOUT_SECONDS = 120;
const ROOT = resolve(import.meta.dir, "../..");
const FIXTURE_SERVER = join(ROOT, "tests/fixtures/experiment-mcp.ts");

export function sessionHarnessFacts(): HarnessFacts[] {
  return getAvailableAdapters().map((adapter) =>
    harnessFacts(adapter.id, adapter.capabilities(), SESSION_AGENTS[adapter.id] !== undefined));
}

/** A live session entry left behind after the probe session exited means the
 * registry leaked a live record; the probe's shutdown did not complete.
 * The probe's own record is identified by its session id (parsed from the
 * capture's `session_started` line) or its working directory — the probe's
 * own fresh directory, so a live entry there is its leak whatever id it
 * carries. With both known, either one names a leak: a candidate that
 * printed a wrong session id must not hide a live entry in the probe's
 * directory (review round 199). With only one of them, that one's rule
 * applies; without either it falls back to the old rule — any live entry
 * of the same agent since the probe started — which fails the probe on an
 * operator's parallel session of the same agent (review round 10,
 * contracts 8). */
export function liveSessionLeak(
  agent: AgentId,
  sinceMs: number,
  registryPath = sessionRegistryPath(),
  sessionId?: string,
  cwd?: string
): string | null {
  try {
    const file = JSON.parse(readFileSync(registryPath, "utf8")) as {
      sessions?: { id?: string; agent?: string; cwd?: string; ended?: string | null; created_at?: string }[];
    };
    const leaked = (file.sessions ?? []).filter((entry) => {
      if (entry.ended != null) return false;
      if (sessionId !== undefined && cwd !== undefined) {
        return entry.id === sessionId || entry.cwd === cwd;
      }
      if (sessionId !== undefined) return entry.id === sessionId;
      if (cwd !== undefined) return entry.cwd === cwd;
      return entry.agent === agent && Date.parse(entry.created_at ?? "") >= sinceMs;
    });
    return leaked.length > 0 ? `${leaked.length} live registry entr${leaked.length === 1 ? "y" : "ies"} left for ${agent}` : null;
  } catch (error) {
    // Only an absent registry file is nothing to check: this machine ran
    // the probe's session against no registry codemux can see. A registry
    // that exists but cannot be read or parsed fails the probe — reading
    // it as "no leak" would certify the end state the RELEASE-GATE
    // contract names (probe F: the entry must be removed or marked ended)
    // without ever looking at it (review round 16, contracts-2 1).
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    const reason = error instanceof Error ? error.message : String(error);
    return `could not read the live-session registry at ${registryPath}: ${reason}`;
  }
}

/** The alias probe I carries (audit D7): `worker` when the effective
 * config maps it for this harness, else the first alias that does. The
 * launched run resolves the alias through that same config, so the target
 * here is the target there. Null when no alias maps the harness — the cell
 * skips rather than run `-m` on a name nobody resolves. */
export function modelAliasFor(agent: AgentId, config: CodemuxConfig): { alias: string; model: string } | null {
  for (const alias of ["worker", "clerk", "judge"]) {
    const model = config.models[alias]?.[agent];
    if (model !== undefined) return { alias, model };
  }
  for (const [alias, mapping] of Object.entries(config.models)) {
    const model = mapping[agent];
    if (model !== undefined) return { alias, model };
  }
  return null;
}

/** Whether a reported model id names the alias's target. The envelope's
 * `codemux.model` is the served model when the provider names one, so
 * three shapes name the target: the same string; the target followed by
 * an eight-digit release date (`claude-sonnet-5-5-20261001`); and, for a
 * target that is one word of letters — a harness's own family name — an
 * id made of a vendor word, that family word, and numbers only (`sonnet`
 * is served as `claude-sonnet-5-5`; live gate, 2026-11-06). Nothing
 * looser: a target with a version in it must match exactly, so
 * `claude-sonnet-5` does not accept `claude-sonnet-5-high`;
 * `claude-opus-5-5` does not name `sonnet`; and a word that is not the
 * id's family, such as `high` in `claude-sonnet-5-high`, names nothing
 * (review rounds 180 and 184). */
export function modelNamesTarget(model: string, target: string): boolean {
  if (model === target) return true;
  if (target === "") return false;
  if (model.startsWith(`${target}-`) && /^\d{8}$/.test(model.slice(target.length + 1))) return true;
  if (!/^[A-Za-z]+$/.test(target)) return false;
  const [vendor, ...rest] = model.split("-");
  return /^[A-Za-z]+$/.test(vendor ?? "") && rest.includes(target) &&
    rest.every((word) => word === target || /^\d+$/.test(word));
}

/** Probe I's verification where the harness reports result JSON (audit
 * D7): probe C's envelope checks, plus `codemux.model` naming the alias's
 * target — an alias that quietly selects another model fails here. */
export function verifyAliasEnvelope(stdout: string, agent: AgentId, expectedModel: string): string | null {
  const base = verifyResultEnvelope(stdout, agent);
  if (base !== null) return base;
  const envelope = JSON.parse(stdout) as { codemux?: { model?: unknown } };
  const model = envelope.codemux?.model;
  if (typeof model !== "string" || !modelNamesTarget(model, expectedModel)) {
    return `result JSON's codemux.model is ${JSON.stringify(model) ?? "absent"}, not the alias's target ${JSON.stringify(expectedModel)}`;
  }
  return null;
}

export async function runProbes(
  facts: readonly HarnessFacts[],
  options: GateOptions,
  runner: Pick<ProbeRunner, "run" | "capture">,
  reportDirectory: string,
  env: Record<string, string | undefined> = process.env,
  // Undefined means "the effective config, read when probe I first needs
  // it": a run without I (and every test) never touches the config file.
  config?: CodemuxConfig,
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
        row.results[letter] = { status: "UNSUPPORTED", seconds: 0, stderr: "", note: unsupportedNote(letter) };
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
          if (letter === "A") {
            row.results.A = await runner.run(base("read-only", "Reply with exactly: OK"), "OK", outer, prefix);
          } else if (letter === "B") {
            const medium = prepareMediumProbe(directory);
            row.results.B = await runner.run(base("medium", medium.prompt), medium.expected, outer, prefix);
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
            row.results.E = await runner.run(base("read-only", "Reply with exactly: OK", ["--hermetic", "--tools", "none"]), "OK", outer, prefix);
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
            // Audit D7: the alias + effort wiring. The alias resolves from
            // the same effective config the launched run reads, so the
            // target verified here is the target the run selected. Where
            // the harness reports result JSON (probe C's set), the
            // envelope's codemux.model must name that target.
            const alias = modelAliasFor(fact.id, config ?? loadConfig());
            if (alias === null) {
              row.results.I = skip(`no model alias is configured for ${fact.id}`);
            } else if (fact.resultJson) {
              row.results.I = await runner.capture(
                base("read-only", "Reply with exactly: OK", ["-m", alias.alias, "--effort", "low", "--result-json"]),
                (captured) => verifyAliasEnvelope(captured.stdout, fact.id, alias.model), outer, prefix);
            } else {
              row.results.I = await runner.run(
                base("read-only", "Reply with exactly: OK", ["-m", alias.alias, "--effort", "low"]),
                "OK", outer, prefix);
            }
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
