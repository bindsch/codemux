// The experiment-run arms of the shared launcher (src/launch.ts), one
// helper per lifecycle seam: the retained failure read, the interruption
// record, the prepare chain, the capture-bound assertion, the completion
// chain, and the catch-path folding. Extracted from launch.ts (file-size
// round) without behavior change; new harness arms join the helpers, not
// the launcher.

import type { BaseAdapter, RunContext } from "../adapters/base.js";
import type { CopilotRunContext } from "../copilot-usage.js";
import { assertHarnessSupported } from "../cli-runtime.js";
import { foldedSinkUsage } from "../plain-unwrap.js";
import { ExperimentFailure, ExperimentFailureCode, experimentFailure } from "../experiment-records.js";
import { emptyAnswerFinish } from "../result-empty.js";
import { CapturedRunFailure } from "../process-runner.js";
import { featureFloor } from "../harness-contracts.js";
import { opencodeExperimentFailureResult } from "../opencode-experiment-run.js";
import type { LaunchOptions } from "../launch.js";
import type { RunRequest, RunResult } from "../types.js";

/** The verification error a completed-or-failed run retained, whichever
 * host owns it; null when none did. */
export function retainedExperimentFailure(context: RunContext | undefined): ExperimentFailure | null {
  return context?.experimentBridge?.failureError ?? context?.experimentCodex?.failureError ??
    relayHosts(context).map((relay) => relay.failureError).find((failure) => failure != null) ?? null;
}

/** Every relay-owning host's relay, in one list, so the retained-failure
 * read and the failure-owner chain cannot drift apart (review M4: gemini
 * was missing from both). Codex is not here: its relay owns the failure
 * only once its recording started, and its own failureError is the read. */
function relayHosts(context: RunContext | undefined): Array<{
  failureError: ExperimentFailure | null; fail(error: unknown): void;
  /** Present on every ExperimentHttpRelay; narrowed relay types may omit it. */
  noteRunOutcome?(error: ExperimentFailure): void;
}> {
  return [
    context?.experimentKimi?.relay, context?.experimentOpencode?.relay, context?.experimentGemini?.relay,
    (context as CopilotRunContext | undefined)?.experimentCopilot?.relay, context?.experimentPi?.relay,
    context?.experimentGoose?.relay, context?.experimentQwen?.relay, context?.experimentCline?.relay,
  ].filter((relay): relay is NonNullable<typeof relay> => relay !== undefined);
}

/** A host whose relay is the only failure channel: an interrupted run
 * fails closed on the evidence it did or did not capture. */
function failInterrupted(host: { relay: { fail(error: unknown): void }; hasOutput: boolean }): void {
  host.relay.fail(new Error(host.hasOutput ? "interrupted before verification" : "interrupted before harness evidence"));
}

/** Every host's answer to an aborted or interrupted capture, before the
 * launcher's cleanup runs. */
export function recordExperimentInterruption(context: RunContext | undefined): void {
  context?.experimentCodex?.interruptBeforeEvidence();
  (context as CopilotRunContext | undefined)?.experimentCopilot?.terminateProtocol();
  context?.experimentOpencode?.interruptBeforeEvidence();
  context?.experimentCline?.interruptBeforeEvidence();
  const kimi = context?.experimentKimi;
  if (kimi) failInterrupted(kimi);
  const pi = context?.experimentPi;
  if (pi) failInterrupted(pi);
  const gemini = context?.experimentGemini;
  if (gemini) failInterrupted(gemini);
  const goose = context?.experimentGoose;
  if (goose) failInterrupted(goose);
  const qwen = context?.experimentQwen;
  if (qwen) failInterrupted(qwen);
}

/** The pre-spawn chain: the feature floor, then every host's prepare. */
export async function prepareExperimentRuns(
  adapter: BaseAdapter,
  request: RunRequest,
  options: LaunchOptions,
  context: RunContext,
  envArg: Record<string, string>
): Promise<void> {
  if (!request.experimentMcp) return;
  // The shared feature-floor accessor refuses an experiment harness without a recorded floor.
  context.harnessVersion = await assertHarnessSupported(adapter.id, adapter.binaryName, options.cwd, envArg,
    request.autonomy, true, request.passthroughEnv, featureFloor(adapter.id, "experiment-mcp"));
  try { await context.experimentCodex?.prepare(context.harnessVersion); }
  finally {
    context.experimentRecording ??= context.experimentCodex?.startedRecordingPath;
  }
  await context.experimentKimi?.prepare(); await context.experimentOpencode?.prepare();
  await context.experimentGemini?.prepare(context.harnessVersion);
  await (context as CopilotRunContext).experimentCopilot?.prepare(); await context.experimentPi?.prepare(); await context.experimentGoose?.prepare();
  await context.experimentQwen?.prepare();
  await context.experimentCline?.prepare();
}

/** An experiment's capture must stay inside the bound the capture layer kept. */
export function assertExperimentCaptureBound(request: RunRequest, raw: RunResult): void {
  if (request.experimentMcp && raw.captureLimitExceeded) {
    throw experimentFailure(new Error("experiment output exceeded the capture limit"));
  }
}

/** Codex's fallback file is read before verification can trigger private-home cleanup. */
export function earlyExperimentResult(
  adapter: BaseAdapter,
  context: RunContext,
  request: RunRequest,
  raw: RunResult
): RunResult | undefined {
  if (context.experimentCodex) return adapter.processRunResult(raw, request, context);
  return undefined;
}

/** The post-capture chain: every host verifies its evidence. Stdout EOF
 * can precede the runner's timeout, so the final timer outcome rides in. */
export async function completeExperimentRuns(context: RunContext, raw: RunResult): Promise<void> {
  await context.experimentCodex?.verify({ timedOut: raw.timedOut === true });
  await context.experimentKimi?.complete({ timedOut: raw.timedOut === true }); await context.experimentOpencode?.complete({ timedOut: raw.timedOut === true });
  await context.experimentGemini?.complete({ timedOut: raw.timedOut === true }); await (context as CopilotRunContext).experimentCopilot?.complete({ timedOut: raw.timedOut === true });
  await context.experimentPi?.complete({ timedOut: raw.timedOut === true }); await context.experimentGoose?.complete({ timedOut: raw.timedOut === true });
  await context.experimentQwen?.complete({ timedOut: raw.timedOut === true });
  await context.experimentCline?.complete({ timedOut: raw.timedOut === true });
}

/** The empty-answer rule (result-empty.ts) fails a run its relay verified.
 * Every recording owner carries that verdict into run_end (review R420 m1). */
export function recordExperimentEmptyAnswer(context: RunContext, request: RunRequest, result: RunResult): void {
  if (!request.experimentMcp || emptyAnswerFinish(result) === null) return;
  const verdict = new ExperimentFailure(ExperimentFailureCode.EmptyAnswer, `${request.agent} exited 0 with an empty answer`);
  const codex = context.experimentCodex?.startedRecordingPath === undefined ? undefined : context.experimentCodex.relay;
  for (const owner of [context.experimentBridge, codex, ...relayHosts(context)]) owner?.noteRunOutcome?.(verdict);
}

export interface ExperimentFailureArms {
  capturedResult?: RunResult;
  processed?: RunResult;
}

/** The catch path for a launch that may own an experiment run: retain
 * each host's captured bytes, hand the failure to the recording owner,
 * and fold the per-harness failure results. Mutates and returns the
 * captured/processed pair the launcher's envelope path consumes. */
export function armExperimentFailure(
  adapter: BaseAdapter,
  request: RunRequest,
  receiptRequest: RunRequest,
  context: RunContext | undefined,
  error: unknown,
  arms: ExperimentFailureArms
): ExperimentFailureArms {
  const retain = (stdout: string): void => {
    if (!arms.capturedResult && !arms.processed) {
      arms.capturedResult = { stdout, stderr: "", exitCode: 1, success: false };
    }
  };
  if (context?.experimentCodex) retain(context.experimentCodex.capturedOutput);
  if (context?.experimentGemini) retain(context.experimentGemini.capturedOutput);
  if (context?.experimentGoose) retain(context.experimentGoose.capturedOutput);
  if (context?.experimentQwen) retain(context.experimentQwen.capturedOutput);
  if (context?.experimentCline) retain(context.experimentCline.capturedOutput);
  const owner = context?.experimentBridge ?? (context?.experimentCodex?.startedRecordingPath
    ? context.experimentCodex.relay : relayHosts(context)[0]);
  owner?.fail(experimentFailure(error instanceof CapturedRunFailure ? error.cause : error));
  if (request.experimentMcp && request.agent === "kimi") {
    const source = arms.capturedResult ?? arms.processed ?? { stdout: context?.experimentKimi?.capturedOutput ?? "", stderr: "", exitCode: 1, success: false };
    arms.processed = adapter.processRunResult({ ...source,
      usage: arms.processed?.usage ?? foldedSinkUsage(context?.stdoutSink) ?? source.usage }, receiptRequest, context,
      retainedExperimentFailure(context) ?? experimentFailure(error instanceof CapturedRunFailure ? error.cause : error));
  }
  if (request.experimentMcp && context?.experimentPi) {
    const source = arms.capturedResult ?? arms.processed ?? { stdout: context.experimentPi.capturedOutput, stderr: "", exitCode: 1, success: false };
    arms.processed = adapter.processRunResult(source, receiptRequest, context);
  }
  if (request.experimentMcp && context?.experimentGoose) {
    const source = arms.capturedResult ?? arms.processed ?? { stdout: context.experimentGoose.capturedOutput, stderr: "", exitCode: 1, success: false };
    arms.processed = adapter.processRunResult(source, receiptRequest, context);
  }
  if (request.experimentMcp && context?.experimentQwen) {
    const source = arms.capturedResult ?? arms.processed ?? { stdout: context.experimentQwen.capturedOutput, stderr: "", exitCode: 1, success: false };
    arms.processed = adapter.processRunResult(source, receiptRequest, context);
  }
  arms.processed = opencodeExperimentFailureResult(adapter, receiptRequest, context, arms.capturedResult, arms.processed);
  if (request.experimentMcp && context?.experimentCline) {
    const source = arms.capturedResult ?? arms.processed ?? { stdout: context.experimentCline.capturedOutput, stderr: "", exitCode: 1, success: false };
    arms.processed = adapter.processRunResult(source, receiptRequest, context);
  }
  return arms;
}
