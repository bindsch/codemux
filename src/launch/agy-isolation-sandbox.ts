// The sandbox wiring every isolated agy launch shares (a hermetic or
// tools-none run, a hermetic session): scode's standard profile leaves
// the operator's real ~/.gemini inside default-allowed harness state
// (scratch/fix/report-h3.md, item 2), so the launch itself blocks that
// tree and re-allows only its private home.

import { assertNoCallerBlockOverStateDirs, type SandboxOptions } from "../sandbox.js";

export interface AgyIsolationSandbox {
  /** The operator's real agy state tree (`~/.gemini`) scode must block. */
  realStateRoot: string;
  /** The launch's private home, the only tree re-allowed after the block. */
  privateHome: string;
}

/**
 * Block the operator's real agy state and re-allow only the private home
 * — the claude project-settings pattern. A caller's own `--sandbox-block`
 * over the private home (or an ancestor, or a path inside it) is refused
 * first, while `blockPaths` still holds only the caller's values: scode
 * emits the block first and the child allow after it, so emitting both
 * would re-open exactly the tree the caller asked to close (review round
 * 9, edges finding 1). Mutates `sandboxOptions` in place, the object the
 * spawn and `--print-sandbox` share.
 */
export function applyAgyIsolationSandboxBlocks(
  sandboxOptions: SandboxOptions,
  isolation: AgyIsolationSandbox
): void {
  assertNoCallerBlockOverStateDirs(
    sandboxOptions.blockPaths ?? [],
    [...(sandboxOptions.harnessStateDirs ?? []), isolation.privateHome]
  );
  sandboxOptions.callerBlockPaths ??= sandboxOptions.blockPaths ?? [];
  sandboxOptions.blockPaths = [
    ...(sandboxOptions.blockPaths ?? []),
    isolation.realStateRoot,
  ];
  sandboxOptions.harnessStateDirs = [
    ...(sandboxOptions.harnessStateDirs ?? []),
    isolation.privateHome,
  ];
}
