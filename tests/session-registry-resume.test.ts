import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  claimForResume,
  lookupForResume,
  readRegistry,
  recordSessionStart,
  registryInside,
  type SessionRecord,
} from "../src/session/registry.js";
import { aiderSessionAutonomyFlags } from "../src/session/aider-session.js";
import * as registryIo from "../src/session/registry-io.js";
import { opencodeSessionAutonomyFlags } from "../src/session/opencode-session.js";
import type { AutonomyLevel } from "../src/types.js";
import { craftEntry, DEAD_PID, makeRoot, newRecord, probe, registryIn, seedRegistry } from "./helpers/session-registry.js";

describe("resume guards", () => {
  test("a matching dead-owner entry resumes", () => {
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry()]);
    const result = lookupForResume(path, "sess-1", probe());
    expect(result.outcome).toBe("ok");
  });

  test("missing registry or missing entry is not_found", () => {
    const path = registryIn(makeRoot());
    expect(lookupForResume(path, "sess-1", probe()).outcome).toBe("not_found");
    seedRegistry(path, [craftEntry()]);
    expect(lookupForResume(path, "other", probe()).outcome).toBe("not_found");
  });

  test("agent and harness-home mismatches refuse", () => {
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry()]);
    const agent = lookupForResume(path, "sess-1", probe({ agent: "zai" }));
    expect(agent.outcome).toBe("refused");
    if (agent.outcome === "refused") expect(agent.reason).toContain("belongs to agent");
    const home = lookupForResume(path, "sess-1", probe({ harnessHome: "/elsewhere/.claude" }));
    expect(home.outcome).toBe("refused");
    if (home.outcome === "refused") expect(home.reason).toContain("harness home");
  });

  test("the provider identity pins the endpoint a resume may replay against (review D3, security)", () => {
    // The recorded state directory does not move with the endpoint for
    // claude (~/.claude), opencode (the real data dir), or aider
    // (~/.aider), so the harness-home guard cannot carry this rule: the
    // override's base URL — or null for the operator's own login — must
    // equal the resume's, in both directions, or the transcript replays
    // on a provider the caller never chose at creation.
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry({ provider_base_url: "http://127.0.0.1:9/v1" })]);
    expect(
      lookupForResume(path, "sess-1", probe({ providerBaseUrl: "http://127.0.0.1:9/v1" })).outcome
    ).toBe("ok");
    const other = lookupForResume(path, "sess-1", probe({ providerBaseUrl: "http://127.0.0.1:10/v1" }));
    expect(other.outcome).toBe("refused");
    if (other.outcome === "refused") {
      expect(other.reason).toContain("created against the provider override at http://127.0.0.1:9/v1");
      expect(other.reason).toContain("cannot resume against the provider override at http://127.0.0.1:10/v1");
    }
    const login = lookupForResume(path, "sess-1", probe());
    expect(login.outcome).toBe("refused");
    if (login.outcome === "refused") {
      expect(login.reason).toContain("cannot resume against the operator's own login");
    }
    // The mirror: an operator-login session never runs under an override.
    seedRegistry(path, [craftEntry()]);
    const flipped = lookupForResume(path, "sess-1", probe({ providerBaseUrl: "http://127.0.0.1:9/v1" }));
    expect(flipped.outcome).toBe("refused");
    if (flipped.outcome === "refused") {
      expect(flipped.reason).toContain("created against the operator's own login");
    }
    expect(lookupForResume(path, "sess-1", probe()).outcome).toBe("ok");
  });

  test("a 0.9.0 record without the provider field reads as operator login (review D3)", () => {
    // Sessions refused every override before this field existed, so an
    // absent provider_base_url IS an operator-login record: refusing it
    // would poison every existing registry as corrupt. The read
    // normalizes it to null, and the next write persists the explicit
    // null.
    const path = registryIn(makeRoot());
    const { provider_base_url: _omit, ...legacy } = craftEntry();
    seedRegistry(path, [legacy as unknown as SessionRecord]);
    expect(readRegistry(path).outcome).toBe("ok");
    expect(lookupForResume(path, "sess-1", probe()).outcome).toBe("ok");
    expect(
      lookupForResume(path, "sess-1", probe({ providerBaseUrl: "http://127.0.0.1:9/v1" })).outcome
    ).toBe("refused");
    // Any other missing key is still corrupt, and a non-string value too.
    const { harness_home: _home, ...noHome } = craftEntry();
    seedRegistry(path, [noHome as unknown as SessionRecord]);
    expect(readRegistry(path).outcome).toBe("corrupt");
    seedRegistry(path, [craftEntry({ provider_base_url: 7 as unknown as string })]);
    expect(readRegistry(path).outcome).toBe("corrupt");
    // The normalization persists at the next write.
    seedRegistry(path, [legacy as unknown as SessionRecord]);
    expect(recordSessionStart(path, newRecord({ id: "sess-1" })).ok).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).sessions[0].provider_base_url).toBeNull();
  });

  test("containment may not drop and trust may not rise", () => {
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry({ sandboxed: true, sandbox_trust: "standard" })]);
    const drop = lookupForResume(path, "sess-1", probe({ sandboxed: false }));
    expect(drop.outcome).toBe("refused");
    if (drop.outcome === "refused") expect(drop.reason).toContain("scode");
    const rise = lookupForResume(path, "sess-1", probe({ sandboxed: true, sandboxTrust: "trusted" }));
    expect(rise.outcome).toBe("refused");
    if (rise.outcome === "refused") expect(rise.reason).toContain("trust");
    // Staying equal or narrowing is allowed.
    expect(
      lookupForResume(path, "sess-1", probe({ sandboxed: true, sandboxTrust: "untrusted" })).outcome
    ).toBe("ok");
  });

  test("a recorded --sandbox-no-net or --sandbox-scrub-env may not be cleared on resume", () => {
    // Review live4, security: the entry recorded neither flag, so a
    // session created without network (or with a scrubbed environment)
    // and fed untrusted content could be resumed with the flag gone —
    // the transcript then running with reach creation never granted.
    const path = registryIn(makeRoot());
    seedRegistry(path, [
      craftEntry({ sandboxed: true, sandbox_no_net: true, sandbox_scrub_env: true }),
    ]);
    const noNet = lookupForResume(path, "sess-1", probe({ sandboxed: true, sandboxScrubEnv: true }));
    expect(noNet.outcome).toBe("refused");
    if (noNet.outcome === "refused") expect(noNet.reason).toContain("--sandbox-no-net");
    const scrub = lookupForResume(
      path,
      "sess-1",
      probe({ sandboxed: true, sandboxNoNet: true })
    );
    expect(scrub.outcome).toBe("refused");
    if (scrub.outcome === "refused") expect(scrub.reason).toContain("--sandbox-scrub-env");
    // Both flags kept: the resume passes (nothing else refuses it).
    expect(
      lookupForResume(
        path,
        "sess-1",
        probe({ sandboxed: true, sandboxNoNet: true, sandboxScrubEnv: true })
      ).outcome
    ).toBe("ok");
    // The rule is one-directional: a session created WITHOUT the flags
    // may resume with them (adding containment only tightens).
    seedRegistry(path, [craftEntry({ id: "plain", sandboxed: true })]);
    expect(
      lookupForResume(
        path,
        "plain",
        probe({ sandboxed: true, sandboxNoNet: true, sandboxScrubEnv: true })
      ).outcome
    ).toBe("ok");
  });

  test("a recorded --sandbox-block path may not be dropped on resume", () => {
    // Review round 4, edges finding 2: the record carried no block
    // paths, so a session created with --sandbox-block resumed without
    // the flag and silently unblocked the recorded tree. The rule is
    // the flags' own one-directional shape: every recorded path must be
    // present, and a resume may add.
    const path = registryIn(makeRoot());
    seedRegistry(path, [
      craftEntry({ sandboxed: true, sandbox_block: ["/private/etc", "/var/root"] }),
    ]);
    const dropped = lookupForResume(path, "sess-1", probe({ sandboxed: true, sandboxBlock: ["/private/etc"] }));
    expect(dropped.outcome).toBe("refused");
    if (dropped.outcome === "refused") {
      expect(dropped.reason).toContain("--sandbox-block /var/root");
    }
    // A superset (another block added) and the equal set both resume.
    expect(
      lookupForResume(
        path,
        "sess-1",
        probe({ sandboxed: true, sandboxBlock: ["/var/root", "/private/etc", "/extra"] })
      ).outcome
    ).toBe("ok");
    expect(
      lookupForResume(path, "sess-1", probe({ sandboxed: true, sandboxBlock: ["/private/etc", "/var/root"] }))
        .outcome
    ).toBe("ok");
    // One-directional like the flags: a session created WITHOUT blocks
    // may resume with them (adding containment only tightens).
    seedRegistry(path, [craftEntry({ id: "plain", sandboxed: true, sandbox_block: [] })]);
    expect(
      lookupForResume(path, "plain", probe({ sandboxed: true, sandboxBlock: ["/private/etc"] })).outcome
    ).toBe("ok");
  });

  test("a record without sandbox_block is legacy and reads as no blocks", () => {
    // Records codemux before 2.0.0 wrote carry no field, and sessions
    // accepted no --sandbox-block then, so the absent field is exactly
    // an empty list — refusing it would poison every existing registry.
    // The read normalizes it and the next write persists [].
    const path = registryIn(makeRoot());
    const { sandbox_block: _omit, ...legacy } = craftEntry();
    seedRegistry(path, [legacy as unknown as SessionRecord]);
    expect(readRegistry(path).outcome).toBe("ok");
    expect(lookupForResume(path, "sess-1", probe()).outcome).toBe("ok");
    expect(lookupForResume(path, "sess-1", probe({ sandboxBlock: ["/private/etc"] })).outcome).toBe("ok");
    // A relative or NUL-carrying value is corrupt, like any mistyped field.
    seedRegistry(path, [craftEntry({ sandbox_block: ["relative/path"] as unknown as string[] })]);
    expect(readRegistry(path).outcome).toBe("corrupt");
    seedRegistry(path, [craftEntry({ sandbox_block: ["/var/root\0"] as unknown as string[] })]);
    expect(readRegistry(path).outcome).toBe("corrupt");
    // The normalization persists at the next write; the start record
    // sorts and deduplicates what it is given.
    seedRegistry(path, [legacy as unknown as SessionRecord]);
    expect(recordSessionStart(path, newRecord({ id: "sess-1", sandbox_block: ["/b", "/a", "/b"] })).ok).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).sessions[0].sandbox_block).toEqual(["/a", "/b"]);
  });

  test("a resume may not change the cwd, add a --pass-env name, or turn on Playwright (review live16)", () => {
    // Review live16, security: only the sandbox flags were compared, so
    // a resume could hand a possibly injected transcript another tree, a
    // secret, or a browser that creation never granted.
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry({ pass_env: ["A_TOKEN", "B_TOKEN"], playwright_mcp: false })]);
    const moved = lookupForResume(path, "sess-1", probe({ cwd: "/somewhere/else" }));
    expect(moved.outcome).toBe("refused");
    if (moved.outcome === "refused") expect(moved.reason).toContain("cannot resume in /somewhere/else");
    const secret = lookupForResume(path, "sess-1", probe({ passEnv: ["A_TOKEN", "GITHUB_TOKEN"] }));
    expect(secret.outcome).toBe("refused");
    if (secret.outcome === "refused") expect(secret.reason).toContain("--pass-env GITHUB_TOKEN");
    const browser = lookupForResume(path, "sess-1", probe({ playwrightMcp: true }));
    expect(browser.outcome).toBe("refused");
    if (browser.outcome === "refused") expect(browser.reason).toContain("--enable-playwright-mcp");
    // One-directional: the same names, a subset, or none at all pass.
    for (const passEnv of [["B_TOKEN", "A_TOKEN"], ["A_TOKEN"], []]) {
      expect(lookupForResume(path, "sess-1", probe({ passEnv })).outcome).toBe("ok");
    }
    // A record created with the MCP may resume with or without it.
    seedRegistry(path, [craftEntry({ id: "pw", playwright_mcp: true })]);
    expect(lookupForResume(path, "pw", probe({ playwrightMcp: true })).outcome).toBe("ok");
    expect(lookupForResume(path, "pw", probe()).outcome).toBe("ok");
  });

  test("the start record stores the --pass-env names sorted, never values (review live16)", () => {
    const path = registryIn(makeRoot());
    expect(recordSessionStart(path, newRecord({ pass_env: ["Z_TOKEN", "A_TOKEN"] })).ok).toBe(true);
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") expect(read.file.sessions[0]?.pass_env).toEqual(["A_TOKEN", "Z_TOKEN"]);
  });

  test("the autonomy ladder is ranked by reach, not by name", () => {
    const path = registryIn(makeRoot());
    const cases: Array<{
      created: AutonomyLevel;
      resume: AutonomyLevel;
      ok: boolean;
    }> = [
      { created: "read-only", resume: "medium", ok: false },
      { created: "read-only", resume: "read-only", ok: true },
      { created: "medium", resume: "read-only", ok: true },
      { created: "medium", resume: "high", ok: false },
      { created: "high", resume: "low", ok: false },
      { created: "high", resume: "medium", ok: true },
      { created: "low", resume: "high", ok: true },
      { created: "low", resume: "low", ok: true },
    ];
    for (const { created, resume, ok } of cases) {
      seedRegistry(path, [craftEntry({ autonomy: created })]);
      const result = lookupForResume(path, "sess-1", probe({ autonomy: resume }));
      expect(result.outcome).toBe(ok ? "ok" : "refused");
      if (!ok && result.outcome === "refused") {
        expect(result.reason).toContain("autonomy");
      }
    }
  });

  test("the agy autonomy ladder is strict: no resume above creation", () => {
    // Review live9, security 1: agy has no permission round-trip
    // (`permissions: false` — approvals become soft denials headless), so
    // its low has the LEAST reach of the three flag levels (low = no mode
    // flag, medium = `--mode=accept-edits`, high =
    // `--dangerously-skip-permissions`). The claude/codex ranking (low
    // out-reaches high, because a low caller approves everything) applied
    // to agy let a session created at low resume at high — the bypass
    // flag — and low→medium the same way.
    const path = registryIn(makeRoot());
    const cases: Array<{ created: AutonomyLevel; resume: AutonomyLevel; ok: boolean }> = [
      { created: "low", resume: "high", ok: false }, // the finding's escalation
      { created: "low", resume: "medium", ok: false },
      { created: "medium", resume: "high", ok: false },
      { created: "read-only", resume: "low", ok: false },
      { created: "high", resume: "medium", ok: true },
      { created: "low", resume: "low", ok: true },
      { created: "read-only", resume: "read-only", ok: true },
    ];
    for (const { created, resume, ok } of cases) {
      seedRegistry(path, [craftEntry({ agent: "agy", autonomy: created })]);
      const result = lookupForResume(path, "sess-1", probe({ agent: "agy", autonomy: resume }));
      expect(result.outcome).toBe(ok ? "ok" : "refused");
      if (!ok && result.outcome === "refused") {
        expect(result.reason).toContain("autonomy");
      }
    }
    // Contrast, pinned for the claude family: low→high stays resumable —
    // a low caller can approve anything, so resuming at high narrows.
    seedRegistry(path, [craftEntry({ agent: "claude", autonomy: "low" })]);
    expect(
      lookupForResume(path, "sess-1", probe({ agent: "claude", autonomy: "high" })).outcome
    ).toBe("ok");
  });

  test("opencode's and aider's adjacent autonomy ties still refuse an upward resume (review D1, 2.1)", () => {
    // opencode's low and medium both spawn `--agent build`, and aider's
    // medium and high both spawn `--yes-always` — each ladder has one
    // adjacent tie, so the strict ranking refuses a resume into a level
    // whose command is byte-identical to the recorded one. The refusal is
    // the intended conservatism (a refused byte-identical resume costs a
    // retry at the recorded level; a folded tie could never be proven
    // narrow), and this test plus the flag pins keep the ranking and the
    // ties honest against each other.
    expect(opencodeSessionAutonomyFlags("low")).toEqual(["--agent", "build"]);
    expect(opencodeSessionAutonomyFlags("medium")).toEqual(["--agent", "build"]);
    expect(aiderSessionAutonomyFlags("medium")).toEqual(["--yes-always"]);
    expect(aiderSessionAutonomyFlags("high")).toEqual(["--yes-always"]);
    const path = registryIn(makeRoot());
    const cases: Array<{ agent: "opencode" | "aider"; created: AutonomyLevel; resume: AutonomyLevel }> = [
      { agent: "aider", created: "medium", resume: "high" }, // byte-identical command, still refused
      { agent: "opencode", created: "low", resume: "medium" }, // the same shape on the other ladder
    ];
    for (const { agent, created, resume } of cases) {
      seedRegistry(path, [craftEntry({ agent, autonomy: created })]);
      const result = lookupForResume(path, "sess-1", probe({ agent, autonomy: resume }));
      expect(result.outcome).toBe("refused");
      if (result.outcome === "refused") {
        expect(result.reason).toContain("autonomy");
      }
      // The same-level resume stays open: the tie costs nothing downward.
      expect(
        lookupForResume(path, "sess-1", probe({ agent, autonomy: created })).outcome
      ).toBe("ok");
    }
  });

  test("hermetic provenance must match", () => {
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry({ hermetic: true })]);
    expect(lookupForResume(path, "sess-1", probe()).outcome).toBe("refused");
    expect(lookupForResume(path, "sess-1", probe({ hermetic: true })).outcome).toBe("ok");
  });

  test("project-settings provenance must match in both directions", () => {
    // Containment provenance, not a preference (SessionRecord's field
    // doc): the mode decides where the transcript lives (the recorded
    // harness_home names the private config directory) and what the
    // harness loads, so neither adding it to nor removing it from a
    // session on resume is the same session. The hermetic guard sits
    // ahead of this one, so the dropping probe keeps hermetic true.
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry({ hermetic: true, project_settings: true })]);
    const drop = lookupForResume(path, "sess-1", probe({ hermetic: true }));
    expect(drop.outcome).toBe("refused");
    if (drop.outcome === "refused") {
      expect(drop.reason).toContain("--experiment-project-settings");
    }
    expect(lookupForResume(path, "sess-1", probe({ hermetic: true, projectSettings: true })).outcome).toBe("ok");
    // The mirror: a plain session may not gain the mode on resume.
    const plainPath = registryIn(makeRoot());
    seedRegistry(plainPath, [craftEntry()]);
    const gain = lookupForResume(plainPath, "sess-1", probe({ projectSettings: true }));
    expect(gain.outcome).toBe("refused");
    if (gain.outcome === "refused") {
      expect(gain.reason).toContain("--experiment-project-settings");
    }
  });

  test("a record before the project-settings field reads as a plain session", () => {
    // A pre-0.16.0 record predates the field; sessions refused the mode
    // entirely there, so an absent field IS a plain-session record, and
    // refusing it would poison every existing registry as corrupt. The
    // read normalizes it to false and the next write persists it.
    const path = registryIn(makeRoot());
    const { project_settings: _omit, ...legacy } = craftEntry();
    seedRegistry(path, [legacy as unknown as SessionRecord]);
    expect(readRegistry(path).outcome).toBe("ok");
    expect(lookupForResume(path, "sess-1", probe()).outcome).toBe("ok");
    expect(lookupForResume(path, "sess-1", probe({ projectSettings: true })).outcome).toBe("refused");
    // A non-boolean value is corrupt, like any mistyped field.
    seedRegistry(path, [craftEntry({ project_settings: 1 as unknown as boolean })]);
    expect(readRegistry(path).outcome).toBe("corrupt");
    // The normalization persists at the next write.
    seedRegistry(path, [legacy as unknown as SessionRecord]);
    expect(recordSessionStart(path, newRecord({ id: "sess-1" })).ok).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).sessions[0].project_settings).toBe(false);
  });

  test("a live owner refuses with session_busy; an ended session does not", async () => {
    // A live foreign process is the owner: this process's own pid is
    // exempt (review live25, the test below).
    const child = Bun.spawn(["sleep", "30"]);
    try {
      await Bun.sleep(50);
      const path = registryIn(makeRoot());
      seedRegistry(path, [
        craftEntry({ id: "alive", owner_pid: child.pid }),
        craftEntry({ id: "done", owner_pid: child.pid, ended: "2026-10-05T11:00:00.000Z" }),
      ]);
      const busy = lookupForResume(path, "alive", probe());
      expect(busy.outcome).toBe("refused");
      if (busy.outcome === "refused") expect(busy.reason).toContain("session_busy");
      expect(lookupForResume(path, "done", probe()).outcome).toBe("ok");
    } finally {
      child.kill();
    }
  });

  test("a record naming this process's own pid as live owner is not busy (review live25)", () => {
    // Review live25, correctness-2 minor 9: recordSessionStart exempts its
    // own pid, judgeResumeEntry did not, so a reused pid's stale unended
    // record (start token null) refused every resume from that pid.
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry({ id: "mine", owner_pid: process.pid, owner_start: null })]);
    expect(lookupForResume(path, "mine", probe()).outcome).toBe("ok");
    expect(claimForResume(path, "mine", probe()).outcome).toBe("ok");
  });

  test("two claims racing for one id under the writer lock: exactly one wins (round 15, minor 5)", async () => {
    // The CLI-level staging of review D5's between-lookup-and-claim
    // window went away when the claim moved ahead of the launch
    // preparation (review round 13, edges 3); the invariant it protected
    // stays pinned here at the registry level. Two claims for one ended
    // record — serialized by the same writer lock two concurrent
    // processes contend on — cannot both win: the first stamps itself
    // the live owner, and the second is refused session_busy before it
    // could spawn anything.
    const child = Bun.spawn(["sleep", "30"]);
    let identity: ReturnType<typeof spyOn> | null = null;
    const ownerPid = (): number =>
      (JSON.parse(readFileSync(path, "utf8")) as { sessions: Array<{ owner_pid: number }> }).sessions[0]!.owner_pid;
    const path = registryIn(makeRoot());
    try {
      await Bun.sleep(50);
      seedRegistry(path, [craftEntry({ id: "race", owner_pid: DEAD_PID, ended: "2026-10-05T11:00:00.000Z" })]);
      // The winner claims as a live FOREIGN process (this process's own
      // pid is exempt from the busy check), like a concurrent codemux.
      identity = spyOn(registryIo, "currentProcessIdentity")
        .mockImplementation(() => ({ pid: child.pid, start: null }));
      const winner = claimForResume(path, "race", probe());
      identity.mockRestore();
      identity = null;
      expect(winner.outcome).toBe("ok");
      if (winner.outcome === "ok") expect(winner.entry.owner_pid).toBe(child.pid);
      expect(ownerPid()).toBe(child.pid);
      // The loser — the second claim through the same lock — is refused
      // busy, and its attempt overwrites nothing.
      const loser = claimForResume(path, "race", probe());
      expect(loser.outcome).toBe("refused");
      if (loser.outcome === "refused") {
        expect(loser.reason).toContain("session_busy");
        expect(loser.reason).toContain(`live process ${child.pid}`);
      }
      expect(ownerPid()).toBe(child.pid);
    } finally {
      identity?.mockRestore();
      child.kill();
    }
  });

  test("a registry inside the entry's cwd or harness home is untrusted", () => {
    const root = makeRoot();
    const path = registryIn(root);
    seedRegistry(path, [craftEntry({ id: "in-cwd", cwd: root })]);
    const inCwd = lookupForResume(path, "in-cwd", probe({ cwd: root }));
    expect(inCwd.outcome).toBe("untrusted");
    if (inCwd.outcome === "untrusted") expect(inCwd.reason).toContain("cwd");
    seedRegistry(path, [
      craftEntry({ id: "in-home", harness_home: root }),
    ]);
    const inHome = lookupForResume(path, "in-home", probe({ harnessHome: root }));
    expect(inHome.outcome).toBe("untrusted");
    if (inHome.outcome === "untrusted") expect(inHome.reason).toContain("harness home");
  });

  test("a root cwd or harness home contains every registry placement", () => {
    // Review live7, security 3: the containment prefix for a root scope
    // was `//`, which no real path starts with, so `--cwd /` reported
    // the registry as outside the writable set — both the start-time
    // refusal and this untrusted check let a registry that sat inside
    // the harness's writable scope through. A root scope contains every
    // absolute path, the same rule the ceiling's scope check carries.
    const path = registryIn(makeRoot());
    expect(registryInside(path, "/")).toBe(true);
    seedRegistry(path, [craftEntry({ id: "at-root", cwd: "/" })]);
    const atRoot = lookupForResume(path, "at-root", probe({ cwd: "/" }));
    expect(atRoot.outcome).toBe("untrusted");
    if (atRoot.outcome === "untrusted") expect(atRoot.reason).toContain("cwd");
    // The harness-home half the name promises (review live25: the body
    // exercised only the cwd side).
    seedRegistry(path, [craftEntry({ id: "home-root", harness_home: "/" })]);
    const homeRoot = lookupForResume(path, "home-root", probe({ harnessHome: "/" }));
    expect(homeRoot.outcome).toBe("untrusted");
    if (homeRoot.outcome === "untrusted") expect(homeRoot.reason).toContain("harness home");
  });
});
