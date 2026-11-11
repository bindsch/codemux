/**
 * `codemux complete serve|once`: brokered raw chat completions for
 * measurement harnesses that run their own agent loop (docs/complete.md).
 * `serve` prints one JSON line on stdout — the OpenAI base URL and the
 * per-run bearer token — then serves until SIGTERM, SIGINT, SIGHUP, or a
 * cap. A cap exits 0; a signal exits 143, codemux's exit for a handled
 * termination signal (docs/cli.md exit-code table), so a supervisor can
 * tell a stop it asked for from a cap. `once -f req.json` forwards one
 * request and prints the answer. Usage mistakes exit 64; nothing else is
 * written to stdout.
 */

import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { collectLabel, LABELS_ENV, parseLabels } from "../labels.js";
import { SIGNAL_EXIT_CODE } from "../process-runner-exit.js";
import { UsageRefusalError, USAGE_REFUSAL_EXIT_CODE } from "../validation.js";
import { CompleteError } from "./errors.js";
import { forwardCompletion } from "./forward.js";
import { CompleteGovernor } from "./governor.js";
import { PRICES_AS_OF, type ModelPrice } from "./prices.js";
import { clearProxyEnvironment, parseProvider, resolveUpstream, type UpstreamConfig } from "./provider.js";
import { CompleteServer, type ServerSummary } from "./server.js";

export interface CompleteDeps {
  environment: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  fetchImpl?: typeof fetch;
  cwd: string;
  /** Registers the stop signals; returns the deregistration. */
  onSignal: (handler: () => void) => () => void;
}

/** The signals that stop `serve` and `once`; each exits SIGNAL_EXIT_CODE. */
export const STOP_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

export function defaultDeps(): CompleteDeps {
  return {
    environment: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    cwd: process.cwd(),
    onSignal: (handler) => {
      for (const signal of STOP_SIGNALS) process.on(signal, handler);
      return () => {
        for (const signal of STOP_SIGNALS) process.off(signal, handler);
      };
    },
  };
}

interface SharedOptions {
  provider: string;
  baseUrl?: string;
  keyEnv?: string;
  proxy?: string;
  label: string[];
  inputUsdPerMtok?: string;
  outputUsdPerMtok?: string;
  timeout: string;
}

function positiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageRefusalError(`${name} must be a positive number`);
  }
  return parsed;
}

function integerIn(value: string, name: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value.trim()) || parsed < min || parsed > max) {
    throw new UsageRefusalError(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function priceOverride(options: SharedOptions): ModelPrice | null {
  const { inputUsdPerMtok: input, outputUsdPerMtok: output } = options;
  if (input === undefined && output === undefined) return null;
  if (input === undefined || output === undefined) {
    throw new UsageRefusalError("--input-usd-per-mtok and --output-usd-per-mtok go together");
  }
  const price = (value: string, name: string) => {
    const parsed = Number(value);
    if (value.trim() === "" || !Number.isFinite(parsed) || parsed < 0) {
      throw new UsageRefusalError(`${name} must be a number of at least 0`);
    }
    return parsed;
  };
  return { input: price(input, "--input-usd-per-mtok"), output: price(output, "--output-usd-per-mtok") };
}

interface Prepared {
  upstream: UpstreamConfig;
  governor: CompleteGovernor;
  timeoutMs: number;
}

function prepare(options: SharedOptions, budgetUsd: number, maxRequests: number, deps: CompleteDeps): Prepared {
  clearProxyEnvironment();
  const provider = parseProvider(options.provider);
  const labels = parseLabels(options.label, deps.environment[LABELS_ENV]);
  const override = priceOverride(options);
  const timeoutMs = integerIn(options.timeout, "--timeout", 1, 86_400) * 1000;
  const upstream = resolveUpstream(provider, options.baseUrl, options.keyEnv, deps.environment, options.proxy);
  const governor = new CompleteGovernor({
    budgetUsd,
    maxRequests,
    priceOverride: override,
    providerReportsCost: provider === "openrouter",
    host: upstream.host,
    labels,
    cwd: deps.cwd,
    environment: deps.environment,
  });
  return { upstream, governor, timeoutMs };
}

/** `serve`: resolves with the exit code once the server has stopped: 0
 * after a cap, SIGNAL_EXIT_CODE (143) after a stop signal. */
export async function runServe(
  options: SharedOptions & { budgetUsd: string; maxRequests: string; port: string },
  deps: CompleteDeps
): Promise<number> {
  const budgetUsd = positiveNumber(options.budgetUsd, "--budget-usd");
  const maxRequests = integerIn(options.maxRequests, "--max-requests", 1, 1_000_000_000);
  const port = integerIn(options.port, "--port", 0, 65_535);
  const { upstream, governor, timeoutMs } = prepare(options, budgetUsd, maxRequests, deps);
  const server = new CompleteServer({ upstream, governor, timeoutMs, port, fetchImpl: deps.fetchImpl });
  const url = await server.start();
  const unregister = deps.onSignal(() => server.stop("signal"));
  deps.stdout(JSON.stringify({
    base_url: `${url}/v1`,
    token: server.token,
    pid: process.pid,
    provider: upstream.provider,
    upstream_host: upstream.host,
    budget_usd: budgetUsd,
    max_requests: maxRequests,
    prices_as_of: PRICES_AS_OF,
  }));
  const summary = await server.done;
  unregister();
  deps.stderr(describeStop(summary));
  return summary.reason === "signal" ? SIGNAL_EXIT_CODE : 0;
}

export function describeStop(summary: ServerSummary): string {
  const why = summary.reason === "signal" ? "on a signal" : `at a cap (${summary.capReason ?? "reached"})`;
  return `codemux complete: stopped ${why} after ${summary.requests} request(s), ` +
    `$${summary.spentUsd.toFixed(4)} spent by estimate`;
}

/** `once`: one request from a file, the answer on stdout. */
export async function runOnce(
  options: SharedOptions & { file: string },
  deps: CompleteDeps
): Promise<number> {
  let request: unknown;
  try {
    request = JSON.parse(readFileSync(options.file, "utf8"));
  } catch (error) {
    throw new UsageRefusalError(`-f ${options.file} must be a readable JSON file: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof request === "object" && request !== null && (request as Record<string, unknown>)["stream"] === true) {
    throw new UsageRefusalError("once prints one whole answer; remove \"stream\": true or use serve");
  }
  // One request is the cap; a dollar budget cannot stop a call before it
  // is answered, so `once` carries none.
  const { upstream, governor, timeoutMs } = prepare(options, Number.MAX_VALUE, 1, deps);
  let status = 0;
  let body = "";
  const shutdown = new AbortController();
  const unregister = deps.onSignal(() => shutdown.abort());
  try {
    await forwardCompletion(request, { upstream, governor, timeoutMs, shutdown: shutdown.signal, fetchImpl: deps.fetchImpl }, {
      closed: new AbortController().signal,
      send: (sent, _type, text) => {
        status = sent;
        body = text;
      },
      begin: () => undefined,
      write: () => undefined,
      end: () => undefined,
    });
  } catch (error) {
    if (shutdown.signal.aborted) return SIGNAL_EXIT_CODE;
    if (!(error instanceof CompleteError)) throw error;
    deps.stderr(`Error: ${error.message}`);
    return 1;
  } finally {
    unregister();
  }
  if (shutdown.signal.aborted) return SIGNAL_EXIT_CODE;
  if (status >= 200 && status < 300) {
    deps.stdout(body);
    return 0;
  }
  deps.stderr(`Error: the upstream answered HTTP ${status}: ${body}`);
  return 1;
}

function sharedOptions(command: Command): Command {
  return command
    .requiredOption("--provider <name>", "anthropic, openai, openrouter, or openai-compatible")
    .option("--base-url <url>", "Upstream base URL ending in /v1 (required for openai-compatible); plain http only to loopback")
    .option("--key-env <name>", "Environment variable holding the API key (default per provider)")
    .option("--proxy <url>", "Explicit HTTP(S) proxy for an HTTPS upstream; ambient proxy variables are ignored")
    .option("--label <KEY=VALUE>", "Ledger label; repeatable", collectLabel, [])
    .option("--input-usd-per-mtok <usd>", "Input price override, USD per million tokens")
    .option("--output-usd-per-mtok <usd>", "Output price override, USD per million tokens")
    .option("--timeout <seconds>", "Upstream timeout per request", "600");
}

export function registerCompleteCommand(
  program: Command,
  deps: () => CompleteDeps = defaultDeps,
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  }
): void {
  const complete = program
    .command("complete")
    .description("Brokered raw chat completions with a spend cap and the call ledger (paid API keys only)");
  const run = (action: () => Promise<number>, stderr: (line: string) => void) => action().then(setExitCode, (error) => {
    stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
    setExitCode(error instanceof UsageRefusalError ? USAGE_REFUSAL_EXIT_CODE : 1);
  });
  sharedOptions(complete.command("serve").description("Serve OpenAI chat completions on 127.0.0.1 until a stop signal (exit 143) or a cap (exit 0)"))
    .requiredOption("--budget-usd <usd>", "Stop once the estimated spend reaches this many dollars")
    .requiredOption("--max-requests <count>", "Stop after this many forwarded requests")
    .option("--port <port>", "Loopback port; 0 picks a free one", "0")
    .action((options) => {
      const resolved = deps();
      return run(() => runServe(options, resolved), resolved.stderr);
    });
  sharedOptions(complete.command("once").description("Forward one chat-completions request from a JSON file"))
    .requiredOption("-f, --file <path>", "The OpenAI chat-completions request body")
    .action((options) => {
      const resolved = deps();
      return run(() => runOnce(options, resolved), resolved.stderr);
    });
}
