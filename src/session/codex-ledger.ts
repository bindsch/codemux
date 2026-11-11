/**
 * The codex driver's registry record and call-ledger identity: the start
 * record, the session ids events and ledger records carry, and the resume
 * claim. src/session/codex-driver.ts owns the lifecycle.
 */

import { randomUUID } from "node:crypto";
import { recordSessionStart } from "./registry.js";
import { CodexDriverIo } from "./codex-driver-io.js";
import { isCallerHarnessHome, recordedHarnessHome } from "./harness-home.js";

export abstract class CodexDriverLedger extends CodexDriverIo {
  /** Codemux's own id for this session, minted at construction: what the
   * call ledger records while the harness has not named a thread (and
   * ever after, if it never does), so id-less sessions never share a key
   * (review ul6). */
  protected readonly codemuxSessionId = randomUUID();

  /** The session's own start, for the closing ledger record's duration. */
  protected readonly sessionStartedAt = Date.now();

  protected registryRecorded = false;

  /** The CLI claimed the record for a resume before the spawn
   * (`adoptResumeClaim`): every end path releases the claim and reports
   * the session resumable, even one that ended before the session start
   * (review live20). */
  protected resumeClaimed = false;
  /** Whether a failed turn-path registry stamp already warned: the touch
   * is best-effort and never waits (review live13), so sustained
   * contention would otherwise repeat the same stderr line every turn. */
  protected touchWarned = false;

  /** The CLI's resume claim succeeded: this process owns the record from
   * now on, whether or not the session start is ever reached. */
  adoptResumeClaim(): void {
    this.resumeClaimed = true;
  }

  protected recordStart(): void {
    if (this.options.registryPath === null || this.threadId === null) return;
    const outcome = recordSessionStart(this.options.registryPath, {
      id: this.threadId,
      agent: "codex",
      cwd: this.options.cwd,
      // The real value: either flag says hermetic (the driver-io rule).
      hermetic: this.options.hermetic === true || (this.options.privateHome != null && !isCallerHarnessHome(this.options.privateHome)),
      ...(isCallerHarnessHome(this.options.privateHome) ? { caller_owned_home: true } : {}),
      harness_home:
        this.options.privateHome != null
          ? recordedHarnessHome(this.options.privateHome, this.threadId)
          : this.options.harnessHomeFor !== undefined
            ? this.options.harnessHomeFor(this.threadId)
            : this.options.harnessHome,
      model: this.options.model ?? null,
      model_alias: this.options.modelAlias ?? null,
      autonomy: this.options.autonomy,
      sandboxed: this.options.sandboxed,
      sandbox_trust: this.options.sandboxTrust,
      sandbox_no_net: this.options.sandboxNoNet,
      sandbox_scrub_env: this.options.sandboxScrubEnv,
      sandbox_block: [...(this.options.sandboxBlock ?? [])],
      sandbox_strict: this.options.sandboxStrict === true,
      pass_env: [...this.options.passEnv],
      playwright_mcp: this.options.playwrightMcp === true,
      provider_base_url: this.options.providerBaseUrl,
      project_settings: this.options.projectSettings === true,
    });
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

  /** Events before the thread exists carry an empty session id — an
   * honest window, not an impossible one: the starting-state shutdown
   * ack, the end path's `shutting_down` rejections of pre-session lines
   * the replay never reached (review live10), and the fatal error
   * events on the handshake-failure paths (an initialize or thread
   * request rejected, a thread response with no id), all fire while
   * `threadId` is still null. Everything else waits for the thread:
   * pre-session caller lines buffer, and harness translation does not
   * begin. (agy-driver.ts documents the same window for the same
   * reason.) */
  protected override sessionIdOrEmpty(): string {
    return this.threadId ?? "";
  }

  /** The id the call ledger keys this session's records by: the harness's
   * own thread id once it has named one (the registry key, stable across a
   * resume), else the codemux-minted id every session owns from
   * construction — never "", which merged every id-less session under one
   * key in `calls --sum` (review ul6). */
  protected ledgerSessionId(): string {
    return this.threadId || this.codemuxSessionId;
  }
}
