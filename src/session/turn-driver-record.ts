/**
 * The shared turn engine's registry-record layer (turn-driver-core.ts
 * holds the state and end path, turn-driver-turns.ts the turn
 * machinery, turn-driver.ts the caller-facing edges): the
 * session_started announcement, the off-stream start record with its
 * busy-lock retry, the fresh-session writable-registry probe, and the
 * activity stamp. Split from the turn machinery so each module stays
 * small (tests/file-size.test.ts); the bodies are turn-driver-turns's,
 * verbatim.
 */

import { buildEvent } from "./protocol.js";
import {
  busyRecordExhaustedNotice,
  probeRegistryForStart,
  recordSessionStartOffStream,
} from "./registry.js";
import { TurnDriverCore } from "./turn-driver-core.js";
import { isCallerHarnessHome } from "./harness-home.js";

export abstract class TurnDriverRecord extends TurnDriverCore {

  /** The fresh-session writable-registry probe (the cli-record.ts rule
   * for the first-turn-id agents, run here because this driver owns its
   * record): the registry is proven writable before any turn can run
   * untracked. Fresh sessions only — a resume's claim just wrote the
   * same file. */
  protected probeRegistry(): void {
    if (this.options.resumeSessionId !== null || this.options.registryPath === null) {
      return;
    }
    const probe = probeRegistryForStart(this.options.registryPath);
    if (!probe.ok) {
      this.emitError(
        true,
        "codemux",
        `cannot record the session in the registry: ${probe.error} ` +
          `(registry: ${this.options.registryPath})`
      );
      void this.finish("crash", 1);
    }
  }

  /** The session_started announcement — at run() start for the minted
   * identity and the resume, at the adopt for the deferred identity.
   * Codemux-originated, so raw is null. The record runs off the output
   * stream (review round 341). */
  protected announceSessionStarted(): void {
    this.recordStart(() => {
      if (this.settled) return;
      this.emit(
        buildEvent(++this.seq, this.sessionIdOrEmpty(), "session_started", null, {
          agent: this.options.profile.agent,
          model: this.options.model ?? null,
          autonomy: this.options.autonomy,
          cwd: this.options.cwd,
          sandboxed: this.options.sandboxed,
          sandbox_trust: this.options.sandboxTrust,
          capabilities: this.capabilities,
          protocol: "codemux-live-session/1",
          // The hermetic session's private home, in its settled
          // spelling; null for a plain session and for the agents whose
          // hermetic mode keeps no session-keyed home (qwen).
          private_home:
            this.options.privateHome === null
              ? null
              : this.recordedHarnessHome(),
        })
      );
    });
  }

  /** The start record, one lock attempt at a time (the opencode rule,
   * review rounds 341, 345, 361): a busy lock retries on a timer off
   * the output stream; a fresh session whose record fails fails
   * closed; a resumed session that exhausts the busy budget is tracked
   * by its pre-spawn claim and keeps running. */
  private recordStart(onRecorded: () => void): void {
    if (this.options.registryPath === null) {
      onRecorded();
      return;
    }
    if (this.sessionId === null) return;
    this.recordPending = true;
    recordSessionStartOffStream(
      this.options.registryPath,
      {
        id: this.sessionId,
        agent: this.options.profile.agent,
        cwd: this.options.cwd,
        hermetic: this.options.hermetic,
        harness_home: this.recordedHarnessHome(),
        ...(isCallerHarnessHome(this.options.privateHome) ? { caller_owned_home: true } : {}),
        model: this.options.model ?? null,
        model_alias: this.options.modelAlias ?? null,
        autonomy: this.options.autonomy,
        sandboxed: this.options.sandboxed,
        sandbox_trust: this.options.sandboxTrust,
        sandbox_no_net: this.options.sandboxNoNet,
        sandbox_scrub_env: this.options.sandboxScrubEnv,
        sandbox_block: [...(this.options.sandboxBlock ?? [])],
        sandbox_strict: this.options.sandboxStrict === true,
        pass_env: [...(this.options.passEnv)],
        playwright_mcp: this.options.playwrightMcp === true,
        provider_base_url: this.options.providerBaseUrl,
        project_settings: this.options.projectSettings === true,
      },
      () => this.settled,
      (outcome) => {
        this.recordPending = false;
        if (!outcome.ok) {
          if (outcome.kind === "busy" && this.resumeClaimed) {
            console.error(
              busyRecordExhaustedNotice(this.sessionId ?? "unknown", outcome.error)
            );
            onRecorded();
            return;
          }
          this.emitError(
            true,
            "codemux",
            `cannot record the session in the registry: ${outcome.error}`
          );
          void this.finish("crash", 1);
          return;
        }
        this.registryRecorded = true;
        onRecorded();
      },
      (error) =>
        console.error(
          `codemux: the registry lock is busy recording session ${this.sessionId} ` +
            `(${error}); retrying in the background`
        ),
      this.options.registryStartBudget
    );
  }
}
