/**
 * kimi sessions (split from tests/session-cli.test.ts): the two-turn
 * store, the spawn-failure drain, and the KIMI_CODE_HOME record rules.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minimalPath, runCli } from "./helpers/cli.js";
import { readRegistry, sessionRegistryPath } from "../src/session/registry.js";
import { FAKE_KIMI, driveSession, fakeKimiEnv } from "./helpers/session-cli.js";

describe("CLI - kimi sessions", () => {
  test("drives a two-turn session over kimi's own store, carries the override, and records ~/.kimi-code as the home", async () => {
    // The CLI seams the driver e2e cannot reach: the SESSION_AGENTS
    // entry (floor probe, id pattern, --turn-timeout refusal), the
    // kimi harness home, the spawnTurn env cache under a provider
    // override (KIMI_MODEL_* riding the environment, never argv or a
    // `-m` alias), and the per-turn --session resume of the id the
    // first hint named.
    const fake = fakeKimiEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-kimi-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    const ID = "session_11111111-2222-3333-4444-555555555555";
    try {
      const session = await driveSession(
        [
          "session", "-a", "kimi", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR",
        ],
        {
          HOME: isolatedHome,
          FAKE_STATE_DIR: fake.stateDir,
          ...fake.env,
          CODEMUX_KIMI_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
          CODEMUX_KIMI_PROVIDER_API_KEY: "e2e-key-do-not-print",
          CODEMUX_KIMI_PROVIDER_MODEL: "clawvm-qwen32b-coder",
        }
      );
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        const started = await session.waitFor(
          "session_started",
          (event) => event.type === "session_started"
        );
        expect(started.agent).toBe("kimi");
        expect(started.session_id).toBe(ID);
        // The override's model is what the session reports; the spawn
        // carries none of it as a `-m` alias.
        expect(started.model).toBe("clawvm-qwen32b-coder");
        // kimi 2.5.2's print wire names no model (PromptJsonWriter writes
        // role/meta lines only), so no served model is reported on either
        // event — a declared null, never a missing field (design P5).
        expect(started.model_served).toBeNull();
        expect(started.model_served_source).toBeNull();
        // An override-selected model resolves no alias.
        expect(started.model_alias).toBeNull();
        const completed = await session.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        expect(completed.finish).toBe("end");
        expect(completed.model_served).toBeNull();
        expect(completed.model_served_source).toBeNull();
        expect(completed.model_alias).toBeNull();

        session.send({ type: "user", text: "scenario:basic two" });
        await session.waitFor(
          "the second turn",
          (event) =>
            event.type === "turn_completed" &&
            session.events.filter((done) => done.type === "turn_completed").length >= 2
        );

        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
        const ended = session.events[session.events.length - 1] as Record<string, any>;
        expect(ended.resumable).toBe(true);

        // The turn spawns: no --model under the override, the prompt on
        // argv with the author prefix ahead of it, and the second turn
        // resuming the id the first hint named.
        const argvs = readFileSync(join(fake.stateDir, "argv.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { args: string[] });
        expect(argvs).toHaveLength(2);
        expect(argvs[0]!.args).not.toContain("--model");
        // No author field on the message, so no prefix rides the prompt
        // (applyAuthorPrefix prefixes only authored messages).
        expect(argvs[0]!.args[argvs[0]!.args.indexOf("--prompt") + 1]).toBe(
          "scenario:basic one"
        );
        expect(argvs[1]!.args[argvs[1]!.args.indexOf("--session") + 1]).toBe(ID);
        // The override rode the environment (the key's presence, never
        // its value).
        const envRecord = JSON.parse(
          readFileSync(join(fake.stateDir, "env.jsonl"), "utf8").split("\n")[0] as string
        ) as { hasOverride: boolean; kimiCodeHome: string | null };
        expect(envRecord.hasOverride).toBe(true);

        // The harness home is the brand home, and the registry holds the
        // record under the native id with the override's identity.
        const registry = readRegistry(sessionRegistryPath(isolatedHome));
        expect(registry.outcome).toBe("ok");
        const entry =
          registry.outcome === "ok"
            ? registry.file.sessions.find((r) => r.id === ID)
            : undefined;
        expect(entry?.agent).toBe("kimi");
        expect(entry?.harness_home).toBe(join(isolatedHome, ".kimi-code"));
        expect(entry?.model).toBe("clawvm-qwen32b-coder");
        expect(entry?.model_alias).toBeNull();
        expect(entry?.provider_base_url).toBe("http://127.0.0.1:9/v1");
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("-m reports the resolved model with model_alias when the value is a config alias, null when it is a raw id (design P5)", async () => {
    const fake = fakeKimiEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-kimi-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    mkdirSync(join(isolatedHome, ".config", "codemux"), { recursive: true });
    writeFileSync(
      join(isolatedHome, ".config", "codemux", "config.yaml"),
      "models:\n  judge:\n    kimi: kimi-code/k3.1-pro\n"
    );
    try {
      const session = await driveSession(
        [
          "session", "-a", "kimi", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2", "-m", "judge",
          "--pass-env", "FAKE_STATE_DIR",
        ],
        { HOME: isolatedHome, FAKE_STATE_DIR: fake.stateDir, ...fake.env }
      );
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        const started = await session.waitFor(
          "session_started",
          (event) => event.type === "session_started"
        );
        // The announcement reports the alias the caller typed beside the
        // id it resolved to; the served model stays null (the wire names
        // none).
        expect(started.model).toBe("kimi-code/k3.1-pro");
        expect(started.model_alias).toBe("judge");
        expect(started.model_served).toBeNull();
        const completed = await session.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        expect(completed.model_alias).toBe("judge");
        expect(completed.model_served).toBeNull();
        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
        // The per-turn spawn carries the resolved id as --model, and the
        // registry records the same pair the events reported.
        const argv = JSON.parse(
          readFileSync(join(fake.stateDir, "argv.jsonl"), "utf8").split("\n")[0] as string
        ) as { args: string[] };
        expect(argv.args[argv.args.indexOf("--model") + 1]).toBe("kimi-code/k3.1-pro");
        const registry = readRegistry(sessionRegistryPath(isolatedHome));
        expect(registry.outcome).toBe("ok");
        const entry =
          registry.outcome === "ok"
            ? registry.file.sessions.find((r) => r.model_alias === "judge")
            : undefined;
        expect(entry?.model).toBe("kimi-code/k3.1-pro");
      } finally {
        await session.proc.kill();
      }

      // A raw id is not an alias: the same resolved model, a null alias.
      const raw = await driveSession(
        [
          "session", "-a", "kimi", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2", "-m", "kimi-code/k3.1-pro",
          "--pass-env", "FAKE_STATE_DIR",
        ],
        { HOME: isolatedHome, FAKE_STATE_DIR: fake.stateDir, ...fake.env }
      );
      try {
        raw.send({ type: "user", text: "scenario:basic one" });
        const started = await raw.waitFor(
          "session_started",
          (event) => event.type === "session_started"
        );
        expect(started.model).toBe("kimi-code/k3.1-pro");
        expect(started.model_alias).toBeNull();
        raw.send({ type: "shutdown" });
        const [exitCode] = await raw.exit;
        expect(exitCode).toBe(0);
      } finally {
        await raw.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("--turn-timeout is accepted for Kimi supervisor interruption", async () => {
    const fake = fakeKimiEnv();
    try {
      const { stderr, exitCode } = await runCli(
        ["session", "-a", "kimi", "--turn-timeout", "30", "--no-sandbox", "--auto", "high"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("--turn-timeout requires an agent whose sessions support interrupt");
    } finally {
      fake.cleanup();
    }
  });

  test("a spawn failure inside the shutdown drain is a fatal error, never a clean interrupted turn (al11)", async () => {
    // The reviewer's trigger, exactly: stdin closes while the turn's
    // spawn is still in flight, and the spawn fails — a scode whose
    // --version probe stalls past the close and then dies. The end path
    // awaits the in-flight spawn, and before al11 its catch swallowed the
    // rejection: the session exited 0 with the turn synthesized
    // "interrupted" and no error anywhere the caller reads, as though the
    // accepted turn had run. The failure is codemux's own — the turn
    // never ran — so it surfaces as a fatal and the exit is nonzero.
    // The bin pair is hand-written (not createFakeBinaryEnv, whose scode
    // entry answers --version): the kimi wrapper passes the floor probe
    // and execs the scenario fake; the scode stub delays its --version
    // answer so the stdin close lands first, then fails it.
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-kimi-"));
    const workdir = join(isolatedHome, "work");
    const stateDir = mkdtempSync(join(tmpdir(), "session-cli-state-"));
    const binDir = mkdtempSync(join(tmpdir(), "codemux-cli-bin-"));
    mkdirSync(workdir);
    writeFileSync(
      join(binDir, "kimi"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '2.5.2\\n'; exit 0; fi\nexec bun '${FAKE_KIMI}' "$@"\n`
    );
    writeFileSync(
      join(binDir, "scode"),
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then sleep 0.3; exit 1; fi\nexit 1\n"
    );
    chmodSync(join(binDir, "kimi"), 0o755);
    chmodSync(join(binDir, "scode"), 0o755);
    try {
      const session = await driveSession(
        [
          "session", "-a", "kimi", "--sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR",
        ],
        {
          HOME: isolatedHome,
          XDG_CONFIG_HOME: join(isolatedHome, ".config"),
          FAKE_STATE_DIR: stateDir,
          PATH: `${binDir}:${minimalPath()}`,
        }
      );
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        // The close must land while the turn's spawn is in flight —
        // inside the scode probe's 0.3s window. turn_started is emitted
        // before the echo and the spawn (kimi-machine.ts), so waiting for
        // it orders the close after the spawn began; ending stdin on send
        // alone raced the turn's acceptance, and a close that arrived
        // first was the clean idle-exit 0 the fatal here must never look
        // like.
        await session.waitFor("turn_started", (event) => event.type === "turn_started");
        (session.proc.stdin as import("bun").FileSink).end();
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(1);
        const fatal = session.events.find(
          (event) => event.type === "error" && event.fatal === true
        );
        expect(fatal?.source).toBe("codemux");
        expect(fatal?.message).toContain("could not spawn the kimi turn process");
        expect(fatal?.message).toContain("could not verify scode version");
        const completed = session.events.find(
          (event) => event.type === "turn_completed"
        );
        expect(completed?.finish).toBe("failed");
        expect(completed?.reason).toContain("could not spawn the kimi turn process");
        const ended = session.events[session.events.length - 1] as Record<string, any>;
        expect(ended.type).toBe("session_ended");
        expect(ended.reason).toBe("stdin-close");
        // The accepted turn never reached kimi: the fake recorded no
        // prompt.
        expect(existsSync(join(stateDir, "prompts.jsonl"))).toBe(false);
      } finally {
        await session.proc.kill();
      }
    } finally {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a padded KIMI_CODE_HOME is recorded exactly as the child receives it, and resumes (al11)", async () => {
    // kimi reads KIMI_CODE_HOME without trimming, so a padded value names
    // a real (differently spelled) store directory to the child. Before
    // al11 the session CLI trimmed its own copy before recording, so the
    // registry named a store the child never used — and a resume with
    // the same padded value still passed the guard, because the guard
    // compared two trimmed strings. The record is the raw bytes now
    // (src/session/cli.ts, kimiHarnessHome), and the resume guard
    // compares padded against padded.
    const fake = fakeKimiEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-kimi-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    const paddedHome = `${join(isolatedHome, "store")}  `;
    // The padded spelling must be a directory that exists: round al29's
    // adapter rule (now inherited verbatim by the session's run-like gate)
    // refuses a passed-through KIMI_CODE_HOME that names no directory, so
    // the fixture creates the padded spelling itself — exactly what the
    // child would otherwise receive and read.
    mkdirSync(paddedHome);
    const ID = "session_11111111-2222-3333-4444-555555555555";
    const baseEnv = {
      HOME: isolatedHome,
      XDG_CONFIG_HOME: join(isolatedHome, ".config"),
      FAKE_STATE_DIR: fake.stateDir,
      ...fake.env,
      KIMI_CODE_HOME: paddedHome,
    };
    const baseArgs = [
      "session", "-a", "kimi", "--no-sandbox", "--auto", "high",
      "--cwd", workdir, "--shutdown-grace", "2",
      "--pass-env", "FAKE_STATE_DIR,KIMI_CODE_HOME",
    ] as const;
    try {
      const session = await driveSession([...baseArgs], baseEnv);
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        await session.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
      } finally {
        await session.proc.kill();
      }

      // The record and the child's own environment both carry the padded
      // bytes — one spelling, never a trimmed normalization of it.
      const registry = readRegistry(sessionRegistryPath(isolatedHome));
      expect(registry.outcome).toBe("ok");
      const entry =
        registry.outcome === "ok"
          ? registry.file.sessions.find((r) => r.id === ID)
          : undefined;
      expect(entry?.harness_home).toBe(paddedHome);
      const envRecord = JSON.parse(
        readFileSync(join(fake.stateDir, "env.jsonl"), "utf8").split("\n")[0] as string
      ) as { kimiCodeHome: string | null };
      expect(envRecord.kimiCodeHome).toBe(paddedHome);

      // The resume with the same padded value passes the harness-home
      // guard (a mismatch is refused with 78): the identity is announced
      // at run start, and the session ends clean.
      const resumed = await driveSession([...baseArgs, "--resume", ID], baseEnv);
      try {
        await resumed.waitFor(
          "session_started",
          (event) => event.type === "session_started"
        );
        resumed.send({ type: "shutdown" });
        const [exitCode] = await resumed.exit;
        expect(exitCode).toBe(0);
      } finally {
        await resumed.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("an empty KIMI_CODE_HOME is refused at start and resume, never recorded as the default home (al16)", async () => {
    // The finding: sanitizeEnvironment forwards a set-but-EMPTY passthrough
    // value verbatim, and kimi's own resolver preserves it — the store
    // lands under the working directory — while kimiHarnessHome treated
    // empty as unset and recorded the DEFAULT home. The record and the
    // child disagreed, and a later resume retaining the passthrough name
    // but unsetting its value could pass the home guard against a
    // different store. The value is refused as usage now (exit 64, like
    // the relative-path refusal beside it): unset the variable or give it
    // an absolute path.
    const fake = fakeKimiEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-kimi-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    const ID = "session_11111111-2222-3333-4444-555555555555";
    const cleanEnv = {
      HOME: isolatedHome,
      XDG_CONFIG_HOME: join(isolatedHome, ".config"),
      FAKE_STATE_DIR: fake.stateDir,
      ...fake.env,
    };
    try {
      // Session A runs clean — no KIMI_CODE_HOME anywhere — and records
      // the default brand home.
      const session = await driveSession(
        [
          "session", "-a", "kimi", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR",
        ],
        cleanEnv
      );
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        await session.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
      } finally {
        await session.proc.kill();
      }
      const registry = readRegistry(sessionRegistryPath(isolatedHome));
      expect(registry.outcome).toBe("ok");
      const entry =
        registry.outcome === "ok"
          ? registry.file.sessions.find((r) => r.id === ID)
          : undefined;
      expect(entry?.harness_home).toBe(join(isolatedHome, ".kimi-code"));

      // The resume round trip the finding turned on: retain the
      // passthrough name, unset the value. Refused as usage before any
      // registry read or spawn — the fake's records do not move.
      const envBefore = existsSync(join(fake.stateDir, "env.jsonl"))
        ? readFileSync(join(fake.stateDir, "env.jsonl"), "utf8")
        : "";
      const emptyEnv = {
        ...cleanEnv,
        KIMI_CODE_HOME: "",
      };
      const resume = await runCli(
        [
          "session", "-a", "kimi", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--resume", ID,
          "--pass-env", "FAKE_STATE_DIR,KIMI_CODE_HOME",
        ],
        emptyEnv
      );
      expect(resume.exitCode).toBe(64);
      expect(resume.stderr).toContain("KIMI_CODE_HOME must not be empty");
      expect(readFileSync(join(fake.stateDir, "env.jsonl"), "utf8")).toBe(envBefore);

      // The fresh start with the empty value refuses identically: no
      // session ever spawns against a store its record cannot name.
      const fresh = await runCli(
        [
          "session", "-a", "kimi", "--no-sandbox", "--auto", "high",
          "--cwd", workdir,
          "--pass-env", "FAKE_STATE_DIR,KIMI_CODE_HOME",
        ],
        emptyEnv
      );
      expect(fresh.exitCode).toBe(64);
      expect(fresh.stderr).toContain("KIMI_CODE_HOME must not be empty");
      expect(readFileSync(join(fake.stateDir, "env.jsonl"), "utf8")).toBe(envBefore);
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);
});

