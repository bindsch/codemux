import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalSandboxBlockPaths,
  lookupForResume,
  processIdentityAlive,
  readRegistry,
  recordSessionEnd,
  recordSessionStart,
  releaseSessionRecord,
  type SessionRecord,
  touchSession,
} from "../src/session/registry.js";
import { MAX_ID_CHARS } from "../src/session/protocol.js";
import { canonicalSandboxBlockPath } from "../src/session/registry/format.js";
import { assertNoCallerBlockOverStateDirs } from "../src/sandbox.js";
import { craftEntry, makeRoot, newRecord, probe, registryIn, seedRegistry } from "./helpers/session-registry.js";

describe("the pre-write validation (review live16)", () => {
  test("a record the reader would reject is refused, and the registry stays readable", () => {
    // Review live16, correctness major: a harness-supplied id over the
    // reader's cap was written, the reader then rejected the whole file,
    // every resume failed closed, and the next fresh start's
    // backup-and-reset dropped every record, live owners included.
    const path = registryIn(makeRoot());
    expect(recordSessionStart(path, newRecord({ id: "keep-me" })).ok).toBe(true);
    const outcome = recordSessionStart(path, newRecord({ id: "x".repeat(MAX_ID_CHARS + 1) }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("nothing was written");
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") expect(read.file.sessions.map((entry) => entry.id)).toEqual(["keep-me"]);
  });
});

describe("recording sessions", () => {
  test("recordSessionStart writes a complete entry and updates in place", () => {
    const path = registryIn(makeRoot());
    expect(recordSessionStart(path, newRecord()).ok).toBe(true);
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome !== "ok") return;
    expect(read.file.sessions.length).toBe(1);
    const entry = read.file.sessions[0] as SessionRecord;
    expect(entry.owner_pid).toBe(process.pid);
    expect(entry.ended).toBeNull();
    expect(entry.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Same id again: one entry, created_at preserved, mode still 0600.
    // The -m value as typed rides beside the resolved model (design P5)
    // and survives the round trip through the file.
    expect(recordSessionStart(path, newRecord({ model: "opus", model_alias: "judge" })).ok).toBe(true);
    const again = readRegistry(path);
    expect(again.outcome).toBe("ok");
    if (again.outcome !== "ok") return;
    expect(again.file.sessions.length).toBe(1);
    const updated = again.file.sessions[0] as SessionRecord;
    expect(updated.model).toBe("opus");
    expect(updated.model_alias).toBe("judge");
    expect(updated.created_at).toBe(entry.created_at);
  });

  test("a record before the model_alias field reads as a raw-id session", () => {
    // A pre-2.0.0 record predates model_alias (design P5); an absent field
    // is a raw-id session — the model as typed, no alias — and refusing it
    // would poison every existing registry as corrupt. The read normalizes
    // it to null and the next write persists it. (The project_settings
    // sibling of this normalization lives with the resume guards, in
    // tests/session-registry-resume.test.ts.)
    const path = registryIn(makeRoot());
    const { model_alias: _omit, ...legacy } = craftEntry();
    seedRegistry(path, [legacy as unknown as SessionRecord]);
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") {
      expect((read.file.sessions[0] as SessionRecord).model_alias).toBeNull();
    }
    // A non-string value is corrupt, like any mistyped field.
    seedRegistry(path, [craftEntry({ model_alias: 1 as unknown as string | null })]);
    expect(readRegistry(path).outcome).toBe("corrupt");
    // The normalization persists at the next write.
    seedRegistry(path, [legacy as unknown as SessionRecord]);
    expect(recordSessionStart(path, newRecord({ id: "sess-1" })).ok).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).sessions[0].model_alias).toBeNull();
  });

  test("a start cannot steal a live foreign owner's record (atomic claim)", async () => {
    // Review live3, correctness 2: two callers can both pass
    // lookupForResume before either spawns, and the second start-write
    // used to replace the first owner unconditionally — both sessions
    // then ran under one record, and either end stamp could free the
    // other. The claim is atomic under the writer lock: a live foreign
    // owner refuses with the same session_busy refusal resume uses (the
    // loser's driver dies through its fail-closed registry-start path),
    // and the winner's ownership survives untouched. A genuinely live
    // child process is the foreign owner — owner_start null keeps
    // liveness true in both table and signal-0 modes.
    const child = Bun.spawn(["sleep", "30"]);
    await Bun.sleep(50);
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry({ owner_pid: child.pid, owner_start: null })]);
    const outcome = recordSessionStart(path, newRecord());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("session_busy");
    }
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") {
      const entry = read.file.sessions[0] as SessionRecord;
      expect(entry.owner_pid).toBe(child.pid);
      expect(entry.ended).toBeNull();
    }
    // Once the foreign owner is gone, the same record updates in place —
    // the refused claim was a liveness refusal, not a corrupted entry.
    child.kill();
    await child.exited;
    let dead = false;
    for (let i = 0; i < 40 && !dead; i++) {
      dead = !processIdentityAlive(child.pid, null);
      if (!dead) await Bun.sleep(50);
    }
    expect(dead).toBe(true);
    expect(recordSessionStart(path, newRecord({ model: "opus" })).ok).toBe(true);
  });

  test("a start finds its own claim whatever start token the claim read (review live20)", () => {
    // claimForResume and recordSessionStart each read the process table
    // once. `ps` can time out to an empty table, so one reading may
    // carry a start token and the other null; the self check compared
    // tokens too and refused the resume's own claim as session_busy.
    // Both directions are pinned: a null token on the claim (ps failed
    // then) and a token that differs from this reading's (ps failed now,
    // or the reading changed).
    for (const claimed of [null, "Thu Jan  1 00:00:00 1970"]) {
      const path = registryIn(makeRoot());
      seedRegistry(path, [craftEntry({ owner_pid: process.pid, owner_start: claimed })]);
      const outcome = recordSessionStart(path, newRecord());
      expect(outcome).toEqual({ ok: true });
    }
  });

  test("an uncreatable registry directory fails as an outcome, never a throw", () => {
    // A regular file where the registry's directory chain needs one:
    // mkdir cannot create `<file>/reg`, and the failure must surface as
    // the designed fail-closed outcome (an EPERM'd home behaves the same
    // way) rather than escaping updateRegistry — the driver records a
    // session start from inside its harness-line handler, where a throw
    // would be misread as harness output.
    const root = makeRoot();
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory");
    const outcome = recordSessionStart(
      join(blocker, "reg", "live-sessions.json"),
      newRecord()
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("cannot update the session registry");
    }
  });

  test("a lost end stamp is reported on stderr, never dropped (review live21)", () => {
    // Correctness minor 2: the CLI's spawn-failure release discarded
    // recordSessionEnd's outcome, which carries failures as values, so a
    // lost release left no trace. Every end path now goes through
    // releaseSessionRecord, which reports the loss the drivers' way.
    const root = makeRoot();
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory");
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      releaseSessionRecord(join(blocker, "reg", "live-sessions.json"), "sess-lost");
    } finally {
      spy.mockRestore();
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("cannot stamp the session end for sess-lost");
    expect(errors[0]).toContain("session_busy");
    // A stamp that lands says nothing.
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry()]);
    const quiet = spyOn(console, "error");
    try {
      releaseSessionRecord(path, "sess-1");
      expect(quiet).not.toHaveBeenCalled();
    } finally {
      quiet.mockRestore();
    }
  });

  test("touch and end stamp last_activity; unknown ids fail", () => {
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry()]);
    expect(touchSession(path, "sess-1").ok).toBe(true);
    expect(recordSessionEnd(path, "sess-1").ok).toBe(true);
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome !== "ok") return;
    const entry = read.file.sessions[0] as SessionRecord;
    expect(entry.ended).toBe(entry.last_activity);
    expect(touchSession(path, "nope").ok).toBe(false);
    expect(recordSessionEnd(path, "nope").ok).toBe(false);
  });

  test("a --final end stamp writes non-resumable with the end; the resume refuses (round 10, edges 4)", () => {
    // An ended record used to be claimable the moment the end stamp
    // landed, while the --final session's private directory was removed
    // only after session_ended — a resume claiming that window had its
    // directory deleted under it. The end stamp now writes `final: true`
    // atomically with `ended`, and the guard refuses a final record
    // outright.
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry({ project_settings: true, ended: null })]);
    expect(recordSessionEnd(path, "sess-1", true).ok).toBe(true);
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") {
      const entry = read.file.sessions[0] as SessionRecord;
      expect(entry.final).toBe(true);
      expect(entry.ended).toBeTruthy();
    }
    const refused = lookupForResume(path, "sess-1", probe({ projectSettings: true }));
    expect(refused.outcome).toBe("refused");
    if (refused.outcome === "refused") {
      expect(refused.reason).toContain("ran with --final");
      expect(refused.reason).toContain("cannot be resumed");
    }
    // A plain end leaves the record resumable, and a record an older
    // codemux wrote without the field reads as not final.
    const pathPlain = registryIn(makeRoot());
    const legacy = craftEntry();
    delete (legacy as Partial<SessionRecord>).final;
    seedRegistry(pathPlain, [legacy]);
    expect(recordSessionEnd(pathPlain, "sess-1").ok).toBe(true);
    expect(lookupForResume(pathPlain, "sess-1", probe()).outcome).toBe("ok");
  });
});

describe("--sandbox-block canonicalization past symlinked ancestors (review round 8, edges)", () => {
  test("a missing tail under a symlinked ancestor records the resolved target plus the tail", () => {
    // A block path that does not exist yet used to record its literal
    // spelling, so a symlinked ancestor could be retargeted between the
    // record and the resume while the comparison still passed. The
    // canonical form resolves the longest existing ancestor and keeps
    // only the missing tail literal.
    const root = makeRoot();
    const targetA = join(root, "target-a");
    const targetB = join(root, "target-b");
    mkdirSync(targetA);
    mkdirSync(targetB);
    const link = join(root, "link");
    symlinkSync(targetA, link);
    const blocked = join(link, "deep", "tail");
    try {
      const recorded = canonicalSandboxBlockPaths([blocked]);
      expect(recorded).toEqual([join(realpathSync(targetA), "deep", "tail")]);

      // Retarget the symlink: the probe canonicalizes past it, so the
      // same spelling now names another tree and the resume refuses
      // instead of matching the record.
      rmSync(link);
      symlinkSync(targetB, link);
      const probed = canonicalSandboxBlockPaths([blocked]);
      expect(probed).toEqual([join(realpathSync(targetB), "deep", "tail")]);
      const path = registryIn(makeRoot());
      seedRegistry(path, [craftEntry({ sandboxed: true, sandbox_block: recorded })]);
      const refused = lookupForResume(path, "sess-1", probe({ sandboxed: true, sandboxBlock: probed }));
      expect(refused.outcome).toBe("refused");
      if (refused.outcome === "refused") {
        expect(refused.reason).toContain("--sandbox-block");
      }
      // The un-retargeted probe still resumes.
      rmSync(link);
      symlinkSync(targetA, link);
      expect(
        lookupForResume(path, "sess-1", probe({ sandboxed: true, sandboxBlock: canonicalSandboxBlockPaths([blocked]) }))
          .outcome
      ).toBe("ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a dangling symlink at the final component records its target, so a retarget no longer matches (round 10, contracts-2 2)", () => {
    // The fallback used to join the parent's realpath with the link's own
    // basename, so a dangling link recorded its literal name and
    // retargeting it to another missing target changed nothing in the
    // comparison — the resume matched while the block named a different
    // tree. The canonical form now follows the link's target.
    const root = makeRoot();
    const link = join(root, "link");
    symlinkSync(join(root, "never-a"), link);
    try {
      const recorded = canonicalSandboxBlockPaths([link]);
      expect(recorded).toEqual([join(realpathSync(root), "never-a")]);

      // Retarget to another missing target: the probe now names a
      // different tree, and the resume refuses instead of matching.
      rmSync(link);
      symlinkSync(join(root, "never-b"), link);
      const probed = canonicalSandboxBlockPaths([link]);
      expect(probed).toEqual([join(realpathSync(root), "never-b")]);
      const path = registryIn(makeRoot());
      seedRegistry(path, [craftEntry({ sandboxed: true, sandbox_block: recorded })]);
      const refused = lookupForResume(path, "sess-1", probe({ sandboxed: true, sandboxBlock: probed }));
      expect(refused.outcome).toBe("refused");
      if (refused.outcome === "refused") {
        expect(refused.reason).toContain("--sandbox-block");
        // The refusal names the recorded form, which the retargeted probe
        // no longer matches.
        expect(refused.reason).toContain(join(realpathSync(root), "never-a"));
      }

      // Back on the recorded target the resume matches again, both while
      // the target is still missing and once it exists (realpath then
      // agrees with the recorded form).
      rmSync(link);
      symlinkSync(join(root, "never-a"), link);
      expect(
        lookupForResume(path, "sess-1", probe({ sandboxed: true, sandboxBlock: canonicalSandboxBlockPaths([link]) }))
          .outcome
      ).toBe("ok");
      mkdirSync(join(root, "never-a"));
      expect(
        lookupForResume(path, "sess-1", probe({ sandboxed: true, sandboxBlock: canonicalSandboxBlockPaths([link]) }))
          .outcome
      ).toBe("ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an ancestor that cannot be resolved refuses naming the path", () => {
    // Permissions on an existing ancestor stop realpath without
    // ENOENT: the request is refused (64 through UsageRefusalError)
    // instead of recording a spelling that cannot be judged.
    const root = makeRoot();
    const closed = join(root, "closed");
    mkdirSync(closed, { mode: 0o000 });
    try {
      expect(() => canonicalSandboxBlockPaths([join(closed, "tail")])).toThrow(/--sandbox-block cannot resolve .*closed/);
    } finally {
      // Restore search permission so the recursive remove can descend.
      chmodSync(closed, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("a symlink cycle in a --sandbox-block path refuses instead of recursing without bound (round 34, edges 8)", () => {
  const root = mkdtempSync(join(tmpdir(), "codemux-block-cycle-"));
  try {
    symlinkSync(join(root, "b"), join(root, "a"));
    symlinkSync(join(root, "a"), join(root, "b"));
    expect(() => canonicalSandboxBlockPath(join(root, "a", "leaf"))).toThrow(/symlink hops|cannot resolve/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("a long --sandbox-block list canonicalizes every path, not only the first 41 (array index was the hop count)", () => {
  // `paths.map(canonicalSandboxBlockPath)` used to pass each path's index
  // as the symlink hop count, so the 42nd regular file of a list was
  // refused with "more than 40 symlink hops".
  const root = mkdtempSync(join(tmpdir(), "codemux-block-many-"));
  try {
    const paths = Array.from({ length: 209 }, (_, index) => {
      const path = join(root, `entry-${String(index).padStart(3, "0")}`);
      writeFileSync(path, "");
      return path;
    });
    const canonical = canonicalSandboxBlockPaths(paths);
    expect(canonical).toHaveLength(209);
    expect(canonical).toEqual(paths.map((path) => realpathSync(path)).sort());
    const stateDir = join(root, "state");
    mkdirSync(stateDir);
    expect(() => assertNoCallerBlockOverStateDirs(paths, Array.from({ length: 60 }, () => stateDir))).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
