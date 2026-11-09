/** A fake SessionPrivateHome (src/session/private-home-types.ts) for the
 * hermetic-session e2e suites: a fresh run-shaped directory under a temp
 * parent that settles onto `session-<id>` by rename. It implements the
 * launcher's contract exactly (src/session/private-home.ts): `dir`
 * follows the settle rename, and `remove()` is one attempt that throws
 * the reason on failure and answers true once the directory is gone
 * (idempotent). The drivers' settledPrivateHomePath computation is
 * exercised on top, never replaced. */

import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionPrivateHome } from "../../src/session/private-home-types.js";

export interface FakePrivateHome extends SessionPrivateHome {
  /** The temp parent both the run-shaped and the settled names sit in. */
  readonly parent: string;
  /** Force the settle to fail (the fail-closed paths). */
  failSettle: boolean;
}

/** The settled name a resume computes for this home's session id. */
export function settledPath(home: FakePrivateHome, sessionId: string): string {
  return join(home.parent, `session-${sessionId}`);
}

export function fakePrivateHome(): FakePrivateHome {
  const parent = mkdtempSync(join(tmpdir(), "codemux-fake-home-"));
  // `dir` follows the rename, so the home tracks its live path here.
  let currentPath = mkdtempSync(join(parent, "run-"));
  let settled = false;
  let removed = false;
  const home: FakePrivateHome = {
    parent,
    get dir(): string {
      return currentPath;
    },
    resumed: false,
    get settled(): boolean {
      return settled;
    },
    failSettle: false,
    blockedPaths: [],
    settle(sessionId: string): void {
      if (this.failSettle) throw new Error("settle refused (test)");
      if (settled) return;
      const target = join(parent, `session-${sessionId}`);
      renameSync(currentPath, target);
      currentPath = target;
      settled = true;
    },
    remove(): boolean {
      // One attempt, the launcher's contract: a failure throws the
      // reason (force keeps a missing directory from throwing), and a
      // later call on the gone directory answers true.
      if (removed) return true;
      rmSync(currentPath, { recursive: true, force: true });
      removed = true;
      return true;
    },
  };
  return home;
}

/** A home that resumed an earlier process's settled directory: the dir is
 * the keyed name already, `resumed` and `settled` are true, and no driver
 * path calls settle again. */
export function fakeResumedPrivateHome(sessionId: string): FakePrivateHome {
  const home = fakePrivateHome();
  home.settle(sessionId);
  return { ...home, resumed: true };
}
