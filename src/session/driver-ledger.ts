/**
 * The claude-family driver's session-record ledger: the registry state
 * (recorded, pre-spawn, claimed) and the start-record writes.
 * src/session/driver.ts owns the lifecycle.
 */

import { recordSessionStart, type UpdateOutcome } from "./registry.js";
import { ClaudeDriverIo } from "./driver-io.js";
import { isCallerHarnessHome } from "./harness-home.js";

export abstract class ClaudeDriverLedger extends ClaudeDriverIo {

  protected registryRecorded = false;
  /** The CLI claimed this session's record for a resume before the spawn
   * (`adoptResumeClaim`). The claim makes this process the record's
   * owner before the init frame, which arrives only after the caller's
   * first input, so every end path must release it and report the
   * session resumable even when no turn ever ran (review live20). */
  protected resumeClaimed = false;
  /** The session's record was written before the spawn
   * (`recordBeforeSpawn`), fresh and resumed alike. The init frame
   * arrives only after the caller's first input reached the harness, so
   * recording there let a turn run in a session the registry could not
   * track (review live22). The init frame then only confirms the
   * session; it writes nothing. */
  protected recordedBeforeSpawn = false;
  /** Whether a failed turn-path registry stamp already warned: the touch
   * is best-effort and never waits (review live13), so sustained
   * contention would otherwise repeat the same stderr line every turn. */
  protected touchWarned = false;

  protected recordStart(): void {
    if (this.recordedBeforeSpawn) {
      // The record exists and this process owns it; the init frame is
      // the harness's confirmation, and no write waits on the lock here.
      this.registryRecorded = true;
      return;
    }
    const outcome = this.writeStartRecord();
    if (outcome === null) return;
    if (!outcome.ok) {
      // An untracked live session must not run (§4.8): the registry is
      // what makes resume's guards answerable, so failing to record it
      // fails the session closed.
      this.emitError(
        true,
        "codemux",
        `cannot record the session in the registry: ${outcome.error}`
      );
      void this.finish("crash", 1);
      return;
    }
    this.registryRecorded = true;
  }

  /** The start record's one write; null when no registry is configured. */
  protected writeStartRecord(): UpdateOutcome | null {
    if (this.options.registryPath === null) return null;
    return recordSessionStart(this.options.registryPath, {
      id: this.options.sessionId,
      agent: this.options.agent,
      cwd: this.options.cwd,
      hermetic: this.options.hermetic ?? false,
      harness_home: this.options.harnessHome,
      ...(isCallerHarnessHome(this.options.privateHome) ? { caller_owned_home: true } : {}),
      model: this.options.model ?? null,
      model_alias: this.options.modelAlias ?? null,
      autonomy: this.options.autonomy,
      sandboxed: this.options.sandboxed,
      sandbox_trust: this.options.sandboxTrust,
      sandbox_no_net: this.options.sandboxNoNet,
      sandbox_scrub_env: this.options.sandboxScrubEnv,
      sandbox_block: [...(this.options.sandboxBlock ?? [])],
      pass_env: [...this.options.passEnv],
      playwright_mcp: this.options.playwrightMcp,
      provider_base_url: this.options.providerBaseUrl,
      project_settings: this.options.projectSettings ?? false,
    });
  }
}
