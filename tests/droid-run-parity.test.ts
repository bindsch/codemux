import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DroidAdapter } from "../src/adapters/droid.js";
import {
  createDroidHermeticHome,
  DROID_HERMETIC_ENV_ASSIGNMENTS,
  DROID_HERMETIC_ENV_OMISSIONS,
} from "../src/droid-hermetic.js";
import {
  DROID_ANSWER_FIELD,
  droidResult,
  parseDroidResultEnvelope,
} from "../src/result-envelope/droid.js";
import type { RunRequest, RunResult } from "../src/types.js";

// Lane R-a: droid's run-surface parity — the hermetic private HOME (the
// env argv prefix that redirects droid's home resolution) and the
// --result-json envelope over `exec --output-format json`.

function scratchBrandHome(): string {
  const home = mkdtempSync(join(tmpdir(), "codemux-droid-home-"));
  const brandHome = join(home, ".factory");
  mkdirSync(brandHome);
  return home;
}

function adapter(home: string, env: Record<string, string | undefined> = {}): DroidAdapter {
  return new DroidAdapter({ HOME: home, ...env } as NodeJS.ProcessEnv, home);
}

describe("droid --hermetic", () => {
  test("prepareRun creates a private HOME under the brand home's .codemux-hermetic", () => {
    const home = scratchBrandHome();
    try {
      const context = adapter(home).prepareRun({ agent: "droid", prompt: "p", hermetic: true });
      const privateHome = context.droidHermeticHome!;
      expect(privateHome.home.startsWith(join(home, ".factory", ".codemux-hermetic"))).toBe(true);
      expect(join(privateHome.home, ".factory")).toBe(privateHome.brandHome);
      expect(lstatSync(privateHome.home).mode & 0o777).toBe(0o700);
      // The brand home exists but holds nothing but the (absent) login:
      // no settings.json, no skills, no hooks.
      expect(existsSync(join(privateHome.brandHome, "settings.json"))).toBe(false);
      adapter(home).cleanupRunSync(context);
      expect(existsSync(privateHome.home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a file login rides a hard link, so a rotation reaches the real file", () => {
    const home = scratchBrandHome();
    try {
      const realAuth = join(home, ".factory", "auth.json");
      writeFileSync(realAuth, "{}", { mode: 0o600 });
      const context = adapter(home).prepareRun({ agent: "droid", prompt: "p", hermetic: true });
      const linked = join(context.droidHermeticHome!.brandHome, "auth.json");
      expect(statSync(linked).ino).toBe(statSync(realAuth).ino);
      adapter(home).cleanupRunSync(context);
      // The real login survives the cleanup.
      expect(existsSync(realAuth)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a missing login links nothing instead of failing", () => {
    const home = scratchBrandHome();
    try {
      const context = adapter(home).prepareRun({ agent: "droid", prompt: "p", hermetic: true });
      expect(existsSync(join(context.droidHermeticHome!.brandHome, "auth.json"))).toBe(false);
      adapter(home).cleanupRunSync(context);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a non-file login is refused", () => {
    const home = scratchBrandHome();
    try {
      symlinkSync("/nowhere", join(home, ".factory", "auth.json"));
      expect(() => createDroidHermeticHome(join(home, ".factory")))
        .toThrow("is not a regular file");
      expect(existsSync(join(home, ".factory", ".codemux-hermetic"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a filesystem without hard links falls back to a symlink", () => {
    const home = scratchBrandHome();
    try {
      writeFileSync(join(home, ".factory", "auth.json"), "{}", { mode: 0o600 });
      const hermetic = createDroidHermeticHome(join(home, ".factory"), {
        hard: () => {
          throw new Error("no hard links here");
        },
        symlink: symlinkSync,
      });
      const linked = join(hermetic.brandHome, "auth.json");
      expect(lstatSync(linked).isSymbolicLink()).toBe(true);
      expect(readlinkSync(linked)).toBe(join(home, ".factory", "auth.json"));
      hermetic.finalize();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the command line redirects the child's home resolution", () => {
    const home = scratchBrandHome();
    try {
      const a = adapter(home);
      const context = a.prepareRun({ agent: "droid", prompt: "p", hermetic: true });
      const expected: string[] = [
        "env",
        ...DROID_HERMETIC_ENV_OMISSIONS.flatMap((name) => ["-u", name]),
        ...DROID_HERMETIC_ENV_ASSIGNMENTS,
        `HOME=${context.droidHermeticHome!.home}`,
        "droid",
        "exec",
      ];
      expect(a.buildRunCommand({ agent: "droid", prompt: "p", hermetic: true }, context)).toEqual(expected);
      a.cleanupRunSync(context);
      // A static preview with no prepared home points HOME at a path that
      // does not exist, so the child fails its own login check there.
      const unprepared = adapter(home).buildRunCommand({ agent: "droid", prompt: "p", hermetic: true });
      const homeIndex = unprepared.indexOf(
        unprepared.find((part) => part.startsWith("HOME="))!
      );
      expect(unprepared[homeIndex]).toBe(`HOME=${join(home, ".factory", ".codemux-hermetic", "unprepared")}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("hermetic composes with the provider override's settings file", () => {
    const home = scratchBrandHome();
    const overrideEnv = {
      CODEMUX_DROID_PROVIDER_BASE_URL: "https://api.example/v1",
      CODEMUX_DROID_PROVIDER_API_KEY: "key-1",
      CODEMUX_DROID_PROVIDER_MODEL: "provider-model",
    };
    try {
      const a = adapter(home, overrideEnv);
      const request: RunRequest = { agent: "droid", prompt: "p", hermetic: true };
      const context = a.prepareRun(request);
      expect(context.droidHermeticHome).toBeDefined();
      expect(context.droidProviderSettings).toBeDefined();
      const cmd = a.buildRunCommand(request, context);
      const droidIndex = cmd.indexOf("droid");
      expect(cmd[droidIndex + 1]).toBe("--settings");
      expect(cmd[droidIndex + 2]).toBe(context.droidProviderSettings!.path);
      expect(cmd).toContain("exec");
      a.cleanupRunSync(context);
      expect(existsSync(context.droidProviderSettings!.path)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a passed-through FACTORY_HOME_OVERRIDE is refused under hermetic", () => {
    const home = scratchBrandHome();
    // A hermetic run needs a clean --cwd of its own (the guideline rule
    // below); this test is about the pass-through, so it supplies one.
    const work = mkdtempSync(join(tmpdir(), "droid-work-"));
    try {
      const a = adapter(home);
      expect(() => a.validateRunRequest({
        agent: "droid", prompt: "p", hermetic: true, cwd: work,
        passthroughEnv: ["FACTORY_API_KEY", "FACTORY_HOME_OVERRIDE"],
      })).toThrow("remove --pass-env FACTORY_HOME_OVERRIDE");
      expect(() => a.validateRunRequest({
        agent: "droid", prompt: "p", hermetic: true, cwd: work,
        passthroughEnv: ["FACTORY_API_KEY"],
      })).not.toThrow();
      // Without hermetic the operator's pass-through is theirs to make.
      expect(() => a.validateRunRequest({
        agent: "droid", prompt: "p",
        passthroughEnv: ["FACTORY_HOME_OVERRIDE"],
      })).not.toThrow();
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("droid --result-json", () => {
  test("a result-json run switches the output format; a plain run keeps the default", () => {
    const home = scratchBrandHome();
    try {
      const a = adapter(home);
      expect(a.buildRunCommand({ agent: "droid", prompt: "p", resultJson: true }))
        .toEqual(["droid", "exec", "--output-format", "json"]);
      expect(a.buildRunCommand({ agent: "droid", prompt: "p" }))
        .toEqual(["droid", "exec"]);
      expect(a.buildRunCommand({ agent: "droid", prompt: "p", autonomy: "high", resultJson: true }))
        .toEqual(["droid", "exec", "--output-format", "json", "--auto", "high"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the result object folds into the envelope under its native field", () => {
    expect(DROID_ANSWER_FIELD).toBe("result");
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 800,
      num_turns: 2,
      result: "the answer",
      session_id: "sess-9",
      usage: {
        input_tokens: 11,
        output_tokens: 4,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 6,
        factory_credits: 2,
        thinking_tokens: 1,
        ttft_ms: 240,
      },
    }) + "\n";
    const parsed = parseDroidResultEnvelope(line)!;
    expect(parsed.answer).toBe("the answer");
    expect(parsed.sessionId).toBe("sess-9");
    // The droid-only extras (factory_credits, thinking_tokens, ttft_ms) drop.
    expect(parsed.usage).toEqual({
      input_tokens: 11,
      output_tokens: 4,
      cached_input_tokens: 9,
      total_tokens: 24,
      cost_usd: null,
    });
    const result = droidResult(
      { stdout: line, stderr: "", exitCode: 0, success: true } as RunResult,
      { agent: "droid", prompt: "p", resultJson: true, model: "m1" }
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.result).toBe("the answer");
    expect(envelope.codemux).toEqual({
      agent: "droid",
      labels: null,
      model: "m1",
      served_model: null,
      model_alias: null,
      usage: envelope.usage,
      session_id: "sess-9",
      recording: null,
      failure_code: null,
    });
  });

  test("an absent usage key stays all-null, not zero", () => {
    const line = JSON.stringify({
      type: "result", subtype: "success", is_error: false, result: "r", session_id: "s",
    }) + "\n";
    expect(parseDroidResultEnvelope(line)!.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
  });

  test("stdout with no result object fails loudly", () => {
    const result = droidResult(
      { stdout: "partial output\n", stderr: "error: died", exitCode: 1, success: false },
      { agent: "droid", prompt: "p", resultJson: true }
    );
    expect(result.success).toBe(false);
    expect(result.stderr).toContain("droid printed no result line");
    expect(parseDroidResultEnvelope("not json at all\n")).toBeNull();
  });

  test("a failure result object fails even at exit 0", () => {
    const line = JSON.stringify({
      type: "result", subtype: "failure", is_error: true, result: "", session_id: "s",
    }) + "\n";
    const result = droidResult(
      { stdout: line, stderr: "", exitCode: 0, success: true },
      { agent: "droid", prompt: "p", resultJson: true }
    );
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).codemux.failure_code).toBe("harness-error");
    expect(result.stderr).toContain("an error result (is_error)");
  });

  test("a success result with empty text fails too", () => {
    const line = JSON.stringify({
      type: "result", subtype: "success", is_error: false, result: "  ", session_id: "s",
    }) + "\n";
    expect(droidResult(
      { stdout: line, stderr: "", exitCode: 0, success: true },
      { agent: "droid", prompt: "p", resultJson: true }
    ).stderr).toContain("no result text");
  });

  test("processRunResult folds only a result-json run", () => {
    const home = scratchBrandHome();
    try {
      const a = adapter(home);
      const plain = { stdout: "text answer", stderr: "", exitCode: 0, success: true } as RunResult;
      expect(a.processRunResult(plain, { agent: "droid", prompt: "p" })).toBe(plain);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("droid --hermetic working directory", () => {
  test("a hermetic run requires an explicit --cwd clean of droid's guideline names", () => {
    const home = scratchBrandHome();
    const work = mkdtempSync(join(tmpdir(), "droid-work-"));
    try {
      const a = adapter(home);
      expect(() => a.validateRunRequest({ agent: "droid", prompt: "p", hermetic: true }))
        .toThrow(/requires an explicit --cwd/);
      // A clean directory passes.
      a.validateRunRequest({ agent: "droid", prompt: "p", hermetic: true, cwd: work });
      // Each name droid 0.221.0 loads from the project is refused: the
      // mixed-case file names and the guideline directories alike.
      for (const name of ["AGENTS.md", "Claude.md", "agents.md"]) {
        writeFileSync(join(work, name), "operator text");
        expect(() => a.validateRunRequest({ agent: "droid", prompt: "p", hermetic: true, cwd: work }))
          .toThrow(/clean working directory/);
        rmSync(join(work, name));
      }
      for (const dir of [".factory", ".agents", ".agent"]) {
        mkdirSync(join(work, dir));
        expect(() => a.validateRunRequest({ agent: "droid", prompt: "p", hermetic: true, cwd: work }))
          .toThrow(/clean working directory/);
        rmSync(join(work, dir), { recursive: true });
      }
      // A plain run in the same directory is not refused.
      writeFileSync(join(work, "AGENTS.md"), "operator text");
      a.validateRunRequest({ agent: "droid", prompt: "p", cwd: work });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
