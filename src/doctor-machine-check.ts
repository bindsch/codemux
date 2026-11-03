/**
 * The machine health check behind `codemux doctor` (audit report D,
 * section 3): does this setup work, per harness, without spending. Stages
 * 1-2 (codemux, config, model aliases, scode, usagemux, Keychain) and 3
 * (one row per installed harness) live in their own modules and are free;
 * stage 4 (`--spend`) makes at most one real `codemux check` request per
 * eligible harness, labeled so `codemux calls --sum` reports the cost.
 * The live gate stays the release instrument; this answers "does this
 * setup work" and never certifies a release.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAllAdapters } from "./adapters/index.js";
import { VERSION_VERDICT_PROBE_TIMEOUT_MS } from "./harness-health.js";
import {
  aliasRow,
  codexbarRow,
  keychainRowFrom,
  quotaDetail,
  readKeychainStatus,
  readScodeFacts,
  scodeEnvironmentRow,
  usagemuxRowFrom,
} from "./doctor-environment.js";
import { checkHarness } from "./doctor-harness-row.js";
import { applySpendStage } from "./doctor-spend.js";
import {
  validateAgentFilter,
  type MachineCheckFlags,
  type MachineCheckReport,
} from "./doctor-model.js";
import { resolveQuotaGate } from "./quota-gate.js";
import { readUsagemuxVersion } from "./usage.js";
import type { CodemuxConfig } from "./types.js";
import { UsageRefusalError } from "./validation.js";

const readPackageFacts = (): { version: string; packageManager: string | null } => {
  const raw = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")
  ) as { version?: unknown; packageManager?: unknown };
  return {
    version: typeof raw.version === "string" ? raw.version : "unknown",
    packageManager: typeof raw.packageManager === "string" ? raw.packageManager : null,
  };
};

export async function runMachineCheck(
  config: CodemuxConfig,
  configError: Error | undefined,
  flags: MachineCheckFlags = {}
): Promise<MachineCheckReport> {
  if (flags.spendCap !== undefined && (!Number.isInteger(flags.spendCap) || flags.spendCap < 0)) {
    throw new UsageRefusalError("--spend-cap must be a whole number of harnesses, 0 or more");
  }
  if (
    flags.timeoutSeconds !== undefined &&
    (!Number.isFinite(flags.timeoutSeconds) || flags.timeoutSeconds <= 0 || flags.timeoutSeconds > 60)
  ) {
    throw new UsageRefusalError("--timeout must be a number of seconds from 0 (exclusive) to 60");
  }
  const pkg = readPackageFacts();
  const selected = validateAgentFilter(flags.only, flags.skip);
  const timeoutMs =
    (flags.timeoutSeconds ?? VERSION_VERDICT_PROBE_TIMEOUT_MS / 1_000) * 1_000;

  const environment: Record<string, MachineCheckReport["environment"][string]> = {};
  environment.config =
    configError !== undefined
      ? {
          state: "invalid",
          severity: "broken",
          detail: `${configError.message.split("\n")[0] ?? ""}; ${quotaDetail(config)}`,
          remedy: "fix ~/.config/codemux/config.yaml; codemux doctor prints the parser's message",
        }
      : { state: "ok", severity: "ok", detail: `loads; ${quotaDetail(config)}`, remedy: null };

  const bunPin = pkg.packageManager;
  environment.codemux =
    bunPin !== null && bunPin !== `bun@${Bun.version}`
      ? {
          state: "ok",
          severity: "warn",
          detail: `codemux ${pkg.version} runs under bun ${Bun.version}; the pin is ${bunPin}`,
          remedy: `run through the pinned bun (${bunPin}); the installed keg was built for it`,
        }
      : { state: "ok", severity: "ok", detail: `codemux ${pkg.version} (bun ${Bun.version})`, remedy: null };

  environment.aliases = aliasRow(config);

  const scode = await readScodeFacts();
  const [scodeRow, usagemuxVersion, keychain] = await Promise.all([
    scodeEnvironmentRow(scode),
    readUsagemuxVersion(),
    readKeychainStatus(),
  ]);
  environment.scode = scodeRow;
  const usagemux = usagemuxRowFrom(usagemuxVersion);
  environment.usagemux = usagemux;
  environment.keychain = keychainRowFrom(keychain);

  const usagePolicy = resolveQuotaGate({ config: config.quota });
  const adapters = getAllAdapters().filter((adapter) => selected.includes(adapter.id));
  const rows = await Promise.all(
    adapters.map((adapter) =>
      checkHarness(adapter, {
        versionTimeoutMs: timeoutMs,
        scode,
        usagePolicy,
        usagemuxPresent: usagemux.state !== "USAGEMUX-MISSING",
      })
    )
  );

  environment.codexbar = codexbarRow(rows, usagemux.state !== "USAGEMUX-MISSING");

  // An invalid configuration never spends: the paid stage would run under
  // the defaults the operator did not write (review round 48). The exit
  // code below is 2 for the configuration error in any case.
  if (configError === undefined) {
    await applySpendStage(rows, flags);
  } else if (flags.spend) {
    environment.config = {
      ...environment.config!,
      detail: `${environment.config!.detail}; the paid stage did not run (fix the configuration first)`,
    };
  }

  const summary = {
    ok: rows.filter((row) => row.severity === "ok").length,
    warn: rows.filter((row) => row.severity === "warn").length,
    broken: rows.filter((row) => row.severity === "broken").length,
    notInstalled: rows.filter((row) => !row.installed).length,
  };
  const environmentBroken = Object.values(environment).some((row) => row.severity === "broken");
  const environmentWarn = Object.values(environment).some((row) => row.severity === "warn");
  const exitCode =
    configError !== undefined
      ? 2
      : summary.broken > 0 || environmentBroken
        ? 1
        : flags.strict === true && (summary.warn > 0 || environmentWarn)
          ? 1
          : 0;

  return {
    schema: "codemux-doctor-1",
    codemux: { version: pkg.version },
    environment,
    harnesses: rows,
    summary,
    exitCode,
  };
}

// Re-exported so `codemux doctor` and its tests have one import point for
// the check's public surface.
export { probeScodeNamespace } from "./doctor-environment.js";
export {
  usageClientTimeoutSeconds,
  USAGE_CLIENT_TIMEOUT_SECONDS,
  validateAgentFilter,
} from "./doctor-model.js";
export type {
  EnvironmentRow,
  HarnessRow,
  MachineCheckFlags,
  MachineCheckReport,
  MachineCheckState,
  RowSeverity,
} from "./doctor-model.js";
export { MACHINE_CHECK_LABEL_KEY, runSpendProbe, spendProbeArgv } from "./doctor-spend.js";
