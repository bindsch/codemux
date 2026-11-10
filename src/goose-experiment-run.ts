/**
 * The experiment probe carrier for goose: a streamable HTTP extension
 * entry planted in the private configuration the hermetic run owns.
 *
 * goose's CLI extension flags cannot authenticate: `--with-extension`
 * carries a stdio command and `--with-streamable-http-extension` carries
 * "Format: 'url...' or 'url... timeout=100'" only (goose 1.50.1 run
 * --help, embedded strings offset 126922337, read 2026-11-09), while the
 * codemux relay is an authenticated loopback endpoint ("Authorization:
 * Bearer", src/experiment-relay.ts tokenMatches). The configuration
 * surface can: ExtensionConfig's variants are stdio, builtin, platform,
 * streamable_http with fields uri, headers, timeout, … (offset 135763563;
 * RecipeExtensionDto repeats "streamable_http uri headers" at 124219227),
 * and the configuration file loads unless --no-profile is passed
 * ("Don't load your default extensions, only use CLI-specified
 * extensions"). A hermetic run's GOOSE_PATH_ROOT is a freshly minted
 * private root (src/goose-hermetic.ts), so the planted config.yaml is the
 * ONLY extension source the run sees: isolation holds without the flag,
 * and the relay's Bearer token rides the entry's headers.
 *
 * Native telemetry is the session ledger the same private root holds
 * (src/goose-experiment-ledger.ts): the model-bound tool calls and the
 * results it saw. Call identity is resolved from the ledger the way
 * gemini resolves it from stdout — poll, match the unclaimed record with
 * the same tool name and arguments, fail closed on ambiguity — and
 * complete() re-reads the ledger to verify every probe result against the
 * bytes the model received. The ledger's write ordering relative to
 * tool dispatch is not spelled in the binary: if goose writes a call only
 * after its result, resolution fails closed with CallIdUnresolved and the
 * run never silently misrecords. No live gate has confirmed this ordering
 * yet: 2.0.0 had no credentialed goose machine (docs/harnesses.md).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import yaml from "js-yaml";
import { ExperimentHttpRelay } from "./experiment-relay.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";
import { experimentToolTimeoutSeconds, type ExperimentSpec } from "./experiment-mcp.js";
import { MAX_CAPTURE_BYTES, type StdoutSink } from "./process-runner.js";
import { capturePrefix } from "./experiment-capture.js";
import { readUtf8FileBounded } from "./file-io.js";
import { parseGooseResultEnvelope } from "./result-envelope/goose.js";
import type { GooseHermeticHome } from "./goose-hermetic.js";
import {
  findGooseSessionLedger,
  gooseLedgerBytes,
  readGooseSessionLedger,
  verifyGooseExperimentLedger,
} from "./goose-experiment-ledger.js";

export type GooseExperimentRelay = Pick<ExperimentHttpRelay, "token" | "url" | "spec" | "recordingPath" | "calls" | "record" |
  "failureError" | "resolveCallId" | "onFailure" | "start" | "finish" | "fail" | "terminateProtocol" | "close" | "closeSync">;

const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
/** One poll round waits this long before re-reading the ledger. */
const LEDGER_POLL_MS = 25;
/** A request whose native identity never appears fails after this window,
 * never blocks the tool call indefinitely. */
const LEDGER_RESOLVE_WINDOW_MS = 10_000;

/** The extension entry goose's configuration loader reads: one
 * streamable_http extension pointing at the authenticated relay. */
export function gooseExperimentConfig(relay: Pick<GooseExperimentRelay, "url" | "token" | "spec">): Record<string, unknown> {
  return {
    extensions: {
      [relay.spec.name]: {
        type: "streamable_http",
        uri: relay.url,
        headers: { Authorization: `Bearer ${relay.token}` },
        timeout: experimentToolTimeoutSeconds(relay.spec),
      },
    },
  };
}

/** Owns only this launch's relay and the planted configuration. The
 * shared launcher must await prepare before spawning, complete after
 * capture, and close before the adapter removes the private root. */
export class GooseExperimentRun implements StdoutSink {
  readonly relay: GooseExperimentRelay;
  readonly configPath: string;
  private readonly home: string;
  private capture = "";
  private bytes = 0;
  private preparing?: Promise<void>;
  private completing?: Promise<void>;
  private closing?: Promise<void>;
  private finished = false;
  private interrupted = false;
  private ledgerPath: string | null = null;
  private evidenceCopied = false;
  private readonly claimed = new Set<string>();
  private removeFailureListener?: () => void;

  constructor(spec: ExperimentSpec, cwd: string, hermeticHome: GooseHermeticHome, environment: NodeJS.ProcessEnv,
    private readonly prompt: string, relay?: GooseExperimentRelay) {
    this.home = hermeticHome.home;
    this.configPath = join(this.home, "config", "goose", "config.yaml");
    this.relay = relay ?? new ExperimentHttpRelay(spec, cwd, environment);
    this.relay.resolveCallId = async (call) => this.resolveNativeCall(call);
  }

  get recordingPath(): string { return this.relay.recordingPath; }
  get capturedOutput(): string { return this.capture; }
  get hasOutput(): boolean { return this.bytes > 0; }

  prepare(): Promise<void> {
    return this.preparing ??= (async () => {
      try {
        await this.relay.start();
        mkdirSync(dirname(this.configPath), { recursive: true });
        // wx: the private root is freshly minted, so an existing file is
        // not this run's state — refuse to overwrite it.
        writeFileSync(this.configPath, yaml.dump(gooseExperimentConfig(this.relay)), { mode: 0o600, flag: "wx" });
      } catch (error) { this.relay.fail(error); throw error; }
    })();
  }

  start(write: (text: string) => void, end: () => void, abort: () => void): void {
    this.removeFailureListener = this.relay.onFailure(abort);
    if (this.relay.failureError) { abort(); return; }
    write(this.prompt);
    end();
  }

  push(chunk: string): void {
    if (this.finished) return;
    this.capture += capturePrefix(chunk, Math.max(0, MAX_CAPTURE_BYTES - this.bytes));
    this.bytes += Buffer.byteLength(chunk);
  }

  finish(options?: { timedOut: boolean; aborted?: boolean }): string {
    this.interrupted ||= options?.timedOut === true || options?.aborted === true;
    this.finished = true;
    return this.capture;
  }
  keptBytes(): number { return this.bytes; }
  closeProtocol(): void { this.removeFailureListener?.(); this.removeFailureListener = undefined; }
  terminateProtocol(): void { this.interrupted = true; this.relay.terminateProtocol(); }

  private async resolveNativeCall(call: { name: string; input: unknown }): Promise<string> {
    const deadline = Date.now() + LEDGER_RESOLVE_WINDOW_MS;
    for (;;) {
      if (this.relay.failureError) throw this.relay.failureError;
      this.ledgerPath ??= findGooseSessionLedger(this.home);
      if (this.ledgerPath !== null) {
        const matches = readGooseSessionLedger(this.ledgerPath).calls
          .filter((entry) => entry.name === call.name && isDeepStrictEqual(entry.input, call.input));
        // Two identical unclaimed native calls are ambiguous: a duplicate
        // request cannot borrow the second call's identity.
        const unclaimed = matches.filter((entry) => !this.claimed.has(entry.id));
        if (unclaimed.length > 1) {
          throw new ExperimentFailure(Code.CallIdUnresolved, "Goose parallel calls with identical arguments are ambiguous");
        }
        const id = unclaimed[0]?.id;
        if (id !== undefined) {
          this.claimed.add(id);
          return id;
        }
        if (matches.length > 0) {
          throw new ExperimentFailure(Code.CallIdUnresolved, "Goose native call was already claimed");
        }
      }
      if (this.finished || this.interrupted) {
        throw new ExperimentFailure(Code.CallIdUnresolved, "Goose MCP request lacks a native ledger identity");
      }
      if (Date.now() >= deadline) {
        throw new ExperimentFailure(Code.CallIdUnresolved, "Goose native ledger identity did not appear in the resolve window");
      }
      await new Promise((resolve) => setTimeout(resolve, LEDGER_POLL_MS));
    }
  }

  complete(options?: { timedOut: boolean }): Promise<void> {
    this.interrupted ||= options?.timedOut === true;
    return this.completing ??= (async () => {
      try {
        this.ledgerPath ??= findGooseSessionLedger(this.home);
        const ledger = this.ledgerPath === null
          ? { calls: [], responses: [] }
          : readGooseSessionLedger(this.ledgerPath);
        if (this.interrupted || this.bytes > MAX_CAPTURE_BYTES) throw new ExperimentFailure(Code.HarnessLogMissing, "Goose experiment capture was interrupted or exceeded its bound");
        // Terminal evidence: goose's final output object on stdout.
        if (parseGooseResultEnvelope(this.capture) === null) {
          throw new ExperimentFailure(Code.HarnessLogMissing, "Goose experiment stdout carries no final output object");
        }
        verifyGooseExperimentLedger(ledger, this.relay);
        this.relay.finish();
      } catch (error) { this.relay.fail(error); }
      if (this.relay.failureError) throw this.relay.failureError;
    })();
  }

  close(): Promise<void> {
    this.closeProtocol();
    this.preserveEvidence();
    return this.closing ??= this.relay.close();
  }
  closeSync(): void { this.closeProtocol(); this.preserveEvidence(); this.relay.closeSync(); }

  /** Capture failures can skip complete(); cleanup must still retain the
   * bounded native bytes before the private root is removed. */
  private preserveEvidence(): void {
    if (this.evidenceCopied || !this.preparing) return;
    this.evidenceCopied = true;
    try {
      this.relay.record("goose_ledger_copy", { bytes_base64: gooseLedgerBytes(this.ledgerPath ?? findGooseSessionLedger(this.home), MAX_EVIDENCE_BYTES) });
      this.relay.record("harness_stdout", { bytes_base64: Buffer.from(this.capture).toString("base64") });
    } catch (error) { this.relay.fail(error); }
  }
}

/** Reads the planted configuration back, for the launch receipt. */
export function readGooseExperimentConfig(path: string): Record<string, unknown> | null {
  try {
    const parsed = yaml.load(readUtf8FileBounded(path, { maxBytes: 1024 * 1024, label: "Goose experiment config", noFollow: true }));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
