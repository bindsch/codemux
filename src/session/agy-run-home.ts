import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AGY_CONVERSATIONS, agySharedStateEntries } from "../adapters/agy-shared-state.js";
import type { BaseAdapter, RunContext } from "../adapters/base.js";
import { applyAgyIsolationSandboxBlocks } from "../launch/agy-isolation-sandbox.js";
import { assertNoCallerBlockOverStateDirs, type SandboxOptions } from "../sandbox.js";
import { containsPath } from "../sandbox-command.js";
import { canonicalSandboxBlockPath } from "./registry/format.js";
import type { RunRequest } from "../types.js";
import { registerRunExitCleanup } from "../run-exit-cleanup.js";

/** Plain sandboxed sessions need the same private login as plain runs.
 * Native conversations stay in the operator's state tree for --resume;
 * only the temporary login home belongs to this invocation's cleanup. */
export function prepareAgySessionRunHome(adapter: BaseAdapter, request: RunRequest,
  sandboxOptions: SandboxOptions | undefined, printOnly: boolean, hasSessionHome: boolean): {
    context?: RunContext; cleanup: () => Promise<void>;
  } {
  if (request.agent !== "agy" || !request.sandboxed || hasSessionHome) {
    return { cleanup: async () => {} };
  }
  if (!printOnly) {
    // The adapter's HOME, the one prepareRun links and grants from. It is
    // absolute: the adapter refuses a relative HOME when it is constructed.
    const operatorHome = adapter.operatorHome();
    // prepareRun shares existing entries. Create the conversation directory
    // before that pass so a first session's transcript survives cleanup too.
    mkdirSync(join(operatorHome, AGY_CONVERSATIONS), { recursive: true, mode: 0o700 });
  }
  const context = adapter.prepareRun(request, sandboxOptions?.trust, sandboxOptions, { printOnly });
  const release = registerRunExitCleanup(adapter, context);
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    try {
      await adapter.cleanupRun(context);
      cleaned = true;
    } catch (error) {
      // Cleanup must not bypass the caller's resume-claim release on failure.
      console.error(`codemux: could not clean up agy session login: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = Math.max(Number(process.exitCode ?? 0), 1);
    } finally {
      if (cleaned || !adapter.cleanupRetryPending(context)) release();
    }
  };
  try {
    if (sandboxOptions !== undefined) {
      // scode's standard agy profile leaves the operator's real ~/.gemini
      // inside default-allowed harness state, so the launch blocks that
      // tree and re-allows its private home. The private home reaches the
      // shared entries through links whose targets sit inside the blocked
      // tree, and the sandbox decides on the resolved path: each shared
      // entry is therefore granted by its real path, exactly the list the
      // link pass shares. Everything else under the real tree, other
      // launches' private homes included, stays blocked.
      const { home, operatorHome } = context.agyProbe ?? {};
      if (home === undefined || operatorHome === undefined) {
        throw new Error("agy isolation launch requires its private home before the sandbox boundary");
      }
      applyAgyIsolationSandboxBlocks(sandboxOptions,
        { realStateRoot: join(operatorHome, ".gemini"), privateHome: home });
      const shared = sharedStateGrants(operatorHome, request.autonomy === "medium",
        sandboxOptions.callerBlockPaths ?? []);
      assertNoCallerBlockOverStateDirs(sandboxOptions.callerBlockPaths ?? [], shared);
      sandboxOptions.harnessStateDirs = [...(sandboxOptions.harnessStateDirs ?? []), ...shared];
    }
  } catch (error) {
    // The probe home exists; a refusal before the spawn must not leak it.
    // The sync form (the adapter's own failure path) because this helper
    // stays synchronous for its callers.
    try {
      adapter.cleanupRunSync(context, true);
    } catch (cleanupError) {
      console.error(`codemux: could not clean up agy session login: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      process.exitCode = Math.max(Number(process.exitCode ?? 0), 1);
    } finally {
      release();
    }
    throw error;
  }
  return { context, cleanup };
}

/** The real paths of the shared entries a plain session grants: the link
 * pass's own list, plus the conversation directory, which a real launch
 * has created by now and a print-only preview names without creating. An
 * entry a caller's own block equals or contains is not granted, so the
 * caller's block stays in force; a caller block inside a shared directory
 * cannot be honored beneath its allow and is refused by the caller. */
function sharedStateGrants(operatorHome: string, privateSettings: boolean,
  callerBlockPaths: readonly string[]): string[] {
  const conversations = join(operatorHome, AGY_CONVERSATIONS);
  const sources = agySharedStateEntries(operatorHome, privateSettings).map((entry) => entry.source);
  if (!sources.includes(conversations)) sources.push(conversations);
  const blocks = callerBlockPaths.map(canonicalSandboxBlockPath);
  return sources.filter((source) => {
    const canonical = canonicalSandboxBlockPath(source);
    return !blocks.some((block) => containsPath(block, canonical));
  });
}
