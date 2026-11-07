/**
 * Review round 115, finding 3: every stale-artifact sweeper accepted any
 * digit sequence as a pid and treated every `process.kill` error but ESRCH
 * as evidence of life, so an entry named with pid 0 (the caller's process
 * group — the probe succeeds) or a 30-digit pid (the probe throws a
 * non-ESRCH TypeError) was never swept. The sweepers now share
 * pidProbeAlive (src/process-table.ts), which refuses to probe either
 * shape, so both fall to each sweeper's existing age rule. One row per
 * sweeper family drives its real entry point; the fresh and live-owner
 * entries prove the sweep still spares what it must.
 */

import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertTrustedDirectory, prepareRunDirParent } from "../src/hermetic-home.js";
import { createOpencodeHermeticHome } from "../src/opencode-hermetic.js";
import { writeOpencodeProviderConfig } from "../src/opencode-provider.js";
import { createAiderHistoryFile } from "../src/aider-history.js";
import { writeKimiNoToolsFile } from "../src/kimi-no-tools.js";
import { writeDroidProviderSettings } from "../src/droid-provider.js";
import { writePiProviderAgentDir } from "../src/pi-provider.js";

const OVERRIDE = { baseUrl: "https://override.example/v1", apiKey: "probe-key" } as const;
const THREE_DAYS_AGO = new Date(Date.now() - 3 * 86_400_000);
/** A 30-digit pid: far past MAX_PID, so `process.kill` itself rejects it —
 * the non-ESRCH error the old private probes read as alive. */
const HUGE_PID = "123456789012345678901234567890";

interface SweepFamily {
  name: string;
  /** The entry-name prefix the sweeper parses a pid out of. */
  prefix: string;
  /** File entries (aider, kimi) instead of directories. */
  file?: boolean;
  /** An optional suffix the sweeper's own names carry. */
  suffix?: string;
  /** Build the parent directory under a fresh root and name the sweep's
   * real entry point. Returns the parent plus the driver's cleanup. */
  family: () => { parent: string; sweep: () => void; done: () => void };
}

const families: SweepFamily[] = [
  {
    name: "codex run directories (hermetic-sweep)",
    prefix: "run-",
    family: () => {
      const root = mkdtempSync(join(tmpdir(), "cmx-pid-probe-"));
      const parent = join(root, ".codemux-hermetic");
      mkdirSync(parent, { recursive: true });
      return {
        parent,
        sweep: () => { prepareRunDirParent(root, ".codemux-hermetic"); },
        done: () => rmSync(root, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "opencode hermetic homes",
    prefix: "run-",
    family: () => {
      const root = mkdtempSync(join(tmpdir(), "cmx-pid-probe-"));
      const parent = join(root, ".codemux-hermetic");
      mkdirSync(parent, { recursive: true });
      return {
        parent,
        sweep: () => { createOpencodeHermeticHome(root).finalize(); },
        done: () => rmSync(root, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "opencode provider config directories",
    prefix: "provider-",
    family: () => {
      const root = mkdtempSync(join(tmpdir(), "cmx-pid-probe-"));
      const parent = join(root, ".codemux");
      mkdirSync(parent, { recursive: true });
      return {
        parent,
        sweep: () => { writeOpencodeProviderConfig(root, OVERRIDE, "test-model").finalize(); },
        done: () => rmSync(root, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "aider history files",
    prefix: "history-",
    file: true,
    suffix: ".md",
    family: () => {
      const root = mkdtempSync(join(tmpdir(), "cmx-pid-probe-"));
      const parent = join(root, ".aider", ".codemux");
      mkdirSync(parent, { recursive: true });
      return {
        parent,
        sweep: () => { createAiderHistoryFile(root).finalize(); },
        done: () => rmSync(root, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "kimi no-tools agent files",
    prefix: "no-tools-",
    file: true,
    suffix: ".md",
    family: () => {
      const root = mkdtempSync(join(tmpdir(), "cmx-pid-probe-"));
      const brand = join(root, ".kimi-code");
      const parent = join(brand, ".codemux");
      mkdirSync(parent, { recursive: true });
      return {
        parent,
        sweep: () => { writeKimiNoToolsFile(brand).finalize(); },
        done: () => rmSync(root, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "droid provider settings directories",
    prefix: "provider-",
    family: () => {
      const root = mkdtempSync(join(tmpdir(), "cmx-pid-probe-"));
      const parent = join(root, ".codemux");
      mkdirSync(parent, { recursive: true });
      return {
        parent,
        sweep: () => { writeDroidProviderSettings(root, OVERRIDE, "test-model").finalize(); },
        done: () => rmSync(root, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "pi agent directories",
    prefix: "provider-",
    family: () => {
      const root = mkdtempSync(join(tmpdir(), "cmx-pid-probe-"));
      const parent = join(root, ".codemux");
      mkdirSync(parent, { recursive: true });
      return {
        parent,
        sweep: () => { writePiProviderAgentDir(root, OVERRIDE, "test-model").finalize(); },
        done: () => rmSync(root, { recursive: true, force: true }),
      };
    },
  },
];

test.each(families)("%s: old pid-0 and out-of-range names go, fresh and live ones stay", ({ prefix, file, suffix = "", family }) => {
  const { parent, sweep, done } = family();
  try {
    const plant = (entry: string, when?: Date): void => {
      const path = join(parent, entry);
      if (file) writeFileSync(path, "stale");
      else mkdirSync(path);
      if (when) utimesSync(path, when, when);
    };
    // Old entries named with pid 0 and a 30-digit pid: not alive by the
    // shared probe, old by the age rule — both must be swept.
    plant(`${prefix}0-named${suffix}`, THREE_DAYS_AGO);
    plant(`${prefix}${HUGE_PID}-huge${suffix}`, THREE_DAYS_AGO);
    // A fresh pid-0 entry: not alive either, but young — the age rule keeps it.
    plant(`${prefix}0-fresh${suffix}`);
    // An old entry named with this live process: the pid gate keeps it.
    plant(`${prefix}${process.pid}-live${suffix}`, THREE_DAYS_AGO);
    sweep();
    const kept = readdirSync(parent);
    expect(kept).not.toContain(`${prefix}0-named${suffix}`);
    expect(kept).not.toContain(`${prefix}${HUGE_PID}-huge${suffix}`);
    expect(kept).toContain(`${prefix}0-fresh${suffix}`);
    expect(kept).toContain(`${prefix}${process.pid}-live${suffix}`);
  } finally {
    done();
  }
});

/** Review round 331, item 6: the trusted-directory check tested type and
 * ownership but not write permissions, so a pre-existing group- or
 * world-writable `.codemux-hermetic` parent passed, and anyone with write
 * access could replace run-directory entries between runs. Both shapes must
 * refuse — at the shared check and at the parent-preparation entry point a
 * run actually takes. */
test("a group- or world-writable run-directory parent is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "cmx-trusted-dir-"));
  try {
    const parent = join(root, ".codemux-hermetic");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    for (const mode of [0o770, 0o702] as const) {
      chmodSync(parent, mode);
      expect(() => assertTrustedDirectory(parent)).toThrow("group- or world-writable");
      expect(() => prepareRunDirParent(root, ".codemux-hermetic")).toThrow("group- or world-writable");
    }
    chmodSync(parent, 0o700);
    expect(() => assertTrustedDirectory(parent)).not.toThrow();
    expect(() => prepareRunDirParent(root, ".codemux-hermetic")).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
