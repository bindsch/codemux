import { mkdtempSync } from "node:fs";
import { runDirectoryPrefix } from "../run-directory-owner.js";
import { join } from "node:path";
import { SCRATCH_PARENT_DIR_NAME } from "../adapters/codex-flags.js";
import {
  assertCodexNoToolsCatalogVersion, CODEX_NO_TOOLS_CATALOG_BASENAME,
  codexNoToolsCatalogBody, needsCodexNoToolsCatalog,
} from "../codex-no-tools.js";
import {
  assertExecutablesUnchanged, resolveTrustedCommand, trustCheckedCommandChecks,
  type ExecutableCheck,
} from "../executable-security.js";
import { readUtf8FileBounded } from "../file-io.js";
import { writeOwnedSync } from "../fs-durable.js";
import { prepareRunDirParent } from "../hermetic-home.js";
import { assertTrustedParentUnchanged, recordTrustedParent, removeUnderTrustedParentOrThrow } from "../safe-remove.js";
import { assertNoCallerBlockOverStateDirs, type SandboxOptions } from "../sandbox.js";
import type { RunRequest } from "../types.js";
import { UsageRefusalError } from "../validation.js";

export interface CodexSessionCatalogBinary {
  readonly binary: string;
  readonly check: ExecutableCheck;
}

export interface CodexSessionCatalog extends CodexSessionCatalogBinary {
  readonly path: string;
  readonly dir: string;
  readonly sandboxOptions: SandboxOptions | undefined;
  /** The CLI calls this after asynchronous spawn preflights, and the driver
   * calls it before constructing a fresh or resumed thread. */
  assertPrepared(): void;
  /** Only after the app-server has settled; also on any pre-spawn exit. */
  remove(): boolean;
}

/** Resolve before the version probe. Probe this absolute binary, use it in
 * app-server argv, and carry this exact check to the eventual spawn. */
export function pinCodexSessionCatalogBinary(
  request: RunRequest, binaryName: string, cwd: string, pathEnv: string
): CodexSessionCatalogBinary | null {
  if (!needsCodexNoToolsCatalog(request)) return null;
  const command = resolveTrustedCommand([binaryName], "codex session catalog", cwd, pathEnv);
  return { binary: command[0]!, check: trustCheckedCommandChecks(command)[0]! };
}

function catalogSandboxOptions(options: SandboxOptions | undefined, dir: string): SandboxOptions | undefined {
  return options === undefined ? undefined : {
    ...options, harnessStateDirs: [...(options.harnessStateDirs ?? []), dir],
  };
}

/** One native file per app-server lifetime, including each resume. It is
 * separate from transcript homes, whose end-path rename cannot invalidate
 * its cleanup path. No provider, auth, or model selection is rewritten. */
export function prepareCodexSessionCatalog(options: {
  request: RunRequest;
  realCodexHome: string;
  binary: CodexSessionCatalogBinary | null;
  harnessVersion: string | null;
  sandboxOptions?: SandboxOptions;
  callerBlockPaths?: readonly string[];
  printOnly?: boolean;
}): CodexSessionCatalog | null {
  const { request, realCodexHome, binary, harnessVersion, sandboxOptions } = options;
  if (!needsCodexNoToolsCatalog(request)) return null;
  assertCodexNoToolsCatalogVersion(harnessVersion);
  if (binary === null) throw new UsageRefusalError("codex session tool-free catalog requires its version-probed executable pin");
  assertExecutablesUnchanged([binary.binary], "codex session catalog", [binary.binary], [binary.check]);
  if (sandboxOptions?.trust === "untrusted") {
    throw new UsageRefusalError("codex session --tools none at writable autonomy requires a sandbox-readable catalog file; untrusted sandbox mode denies harness state");
  }
  const body = codexNoToolsCatalogBody(request.model, realCodexHome);
  const previewDir = join(realCodexHome, SCRATCH_PARENT_DIR_NAME, "unprepared");
  assertNoCallerBlockOverStateDirs(options.callerBlockPaths ?? [], [previewDir]);
  if (options.printOnly) {
    return { ...binary, dir: previewDir, path: join(previewDir, CODEX_NO_TOOLS_CATALOG_BASENAME),
      sandboxOptions: catalogSandboxOptions(sandboxOptions, previewDir),
      assertPrepared() { throw new UsageRefusalError("codex session catalog preview cannot launch a thread"); },
      remove() { return true; },
    };
  }
  const parent = prepareRunDirParent(realCodexHome, SCRATCH_PARENT_DIR_NAME);
  const parentRecord = recordTrustedParent(parent);
  const dir = mkdtempSync(join(parent, runDirectoryPrefix()));
  let removed = false;
  const remove = (): boolean => {
    if (removed) return true;
    removeUnderTrustedParentOrThrow(dir, parentRecord, "Codex session model catalog");
    removed = true;
    return true;
  };
  try {
    assertNoCallerBlockOverStateDirs(options.callerBlockPaths ?? [], [dir]);
    const dirRecord = recordTrustedParent(dir);
    const path = join(dir, CODEX_NO_TOOLS_CATALOG_BASENAME);
    writeOwnedSync(path, body, 0o600);
    return { ...binary, dir, path,
      sandboxOptions: catalogSandboxOptions(sandboxOptions, dir),
      assertPrepared() {
        if (removed) throw new UsageRefusalError("codex session model catalog has already been removed");
        assertTrustedParentUnchanged(parentRecord, "Codex catalog parent");
        assertTrustedParentUnchanged(dirRecord, "Codex catalog directory");
        assertExecutablesUnchanged([binary.binary], "codex session catalog", [binary.binary], [binary.check]);
        if (readUtf8FileBounded(path, { maxBytes: Buffer.byteLength(body), label: "Codex session catalog" }) !== body) {
          throw new UsageRefusalError("codex session model catalog changed before launch");
        }
      },
      remove,
    };
  } catch (error) {
    remove();
    throw error;
  }
}
