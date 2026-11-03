import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRequest } from "../src/types.js";
import { codexAdapter, fakeHome, newSignalListeners, prepare, prepared, scratch, signalListeners } from "./helpers/hermetic-codex.js";

describe("hermetic runs: codex", () => {
  let baseline = signalListeners();
  beforeEach(() => {
    baseline = signalListeners();
  });
  afterEach(() => {
    for (const { adapter, context } of prepared.splice(0)) adapter.cleanupRun(context);
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
    // No home may leave a signal handler behind: a later synthetic signal
    // in another test would otherwise end the whole test process.
    expect(newSignalListeners(baseline)).toBe(0);
  });

  test("hermetic flags disable project docs, account and disk customizations", () => {
    const adapter = codexAdapter({}, fakeHome());
    const request: RunRequest = { agent: "codex", prompt: "p", hermetic: true, sandboxed: true };
    const context = prepare(adapter, request);
    const cmd = adapter.buildRunCommand(request, context);
    // The private home reaches Codex through env(1), never through the
    // environment scode itself runs with.
    expect(cmd[0]).toBe("env");
    expect(cmd[1]).toMatch(/^HOME=.*\.codex\/\.codemux-hermetic\/run-\d+-/);
    expect(cmd[2]).toBe(`CODEX_HOME=${cmd[1]!.slice("HOME=".length)}/.codex`);
    expect(cmd.slice(3, 5)).toEqual(["codex", "-c"]);
    expect(cmd).toContain('cli_auth_credentials_store="file"');
    expect(cmd).toContain("project_doc_max_bytes=0");
    expect(cmd).toContain("include_apps_instructions=false");
    for (const feature of ["apps", "plugins", "hooks", "memories", "shell_snapshot"]) {
      expect(cmd[cmd.indexOf(feature) - 1]).toBe("--disable");
    }
    // Every run asks for the event stream, then names its fallback file
    // (round al29: a plain run names it too, its verdict scoped to the
    // Plan-only turn's messageless stream — the prepared hermetic path
    // sits at the private HOME's root), then the hermetic config closer
    // and the stdin marker; a plain run streams the events through a
    // fold (0.12.0) instead of capturing them.
    expect(cmd[cmd.length - 1]).toBe("-");
    expect(cmd[cmd.length - 2]).toBe("--ignore-user-config");
    expect(cmd[cmd.length - 3]).toBe(`${cmd[1]!.slice("HOME=".length)}/last-message`);
    expect(cmd[cmd.length - 4]).toBe("--output-last-message");
    expect(cmd[cmd.length - 5]).toBe("--json");
    // No tools flag unless asked.
    expect(cmd).not.toContain("shell_tool");
  });

  test("--tools none disables every tool that reaches the machine or network", () => {
    const home = fakeHome();
    const cmd = codexAdapter({}, home).buildRunCommand({ agent: "codex", prompt: "p", tools: "none" });
    expect(cmd[0]).toBe("codex");
    for (const feature of ["shell_tool", "unified_exec", "view_image", "multi_agent", "browser_use", "computer_use"]) {
      expect(cmd[cmd.indexOf(feature) - 1]).toBe("--disable");
    }
    // The top-level mode; Codex drops a boolean tools.web_search.
    expect(cmd).toContain('web_search="disabled"');
    expect(cmd).not.toContain("tools.web_search=false");
    expect(cmd).not.toContain("--ignore-user-config");
    // The stream flag rides every run, and the fallback file with it
    // (round al29): a plain run names the file, its verdict scoped to
    // the Plan-only turn. Without a prepared context the static shape is
    // the fail-closed placeholder.
    expect(cmd.slice(-7)).toEqual([
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-rules",
      "--json",
      "--output-last-message",
      join(home, ".codex", ".codemux-scratch", "unprepared", "last-message"),
      "-",
    ]);
    expect(cmd[cmd.length - 1]).toBe("-");
  });

  test("--tools none is accepted only at read-only autonomy (apply_patch cannot be removed)", () => {
    const adapter = codexAdapter({}, fakeHome());
    const cwd = mkdtempSync(join(tmpdir(), "codemux-codex-ro-"));
    scratch.push(cwd);
    mkdirSync(join(cwd, ".git"));
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd, tools: "none" })).not.toThrow();
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd, tools: "none", autonomy: "read-only" })).not.toThrow();
    for (const autonomy of ["low", "medium", "high"] as const) {
      expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd, tools: "none", autonomy }))
        .toThrow("needs --auto read-only");
    }
  });

  test("a static hermetic command without prepareRun points at a home that does not exist", () => {
    const cmd = codexAdapter({}, fakeHome()).buildRunCommand({ agent: "codex", prompt: "p", hermetic: true });
    expect(cmd[1]).toMatch(/^HOME=.*\.codemux-hermetic\/unprepared$/);
    expect(() => statSync(cmd[1]!.slice("HOME=".length))).toThrow();
  });

  test("plain commands are unchanged by the hermetic machinery", () => {
    // No env(1) prefix and no hermetic home. The event stream flag and
    // the bounded fallback file ride the run anyway (0.12.0, round al29):
    // a plain run streams the events through a fold and names the file
    // its verdict consults only for the Plan-only turn, so nothing
    // hermetic varies with the machinery.
    const home = fakeHome();
    expect(codexAdapter({}, home).buildRunCommand({ agent: "codex", prompt: "p" }))
      .toEqual([
        "codex",
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-rules",
        "--json",
        "--output-last-message",
        join(home, ".codex", ".codemux-scratch", "unprepared", "last-message"),
        "-",
      ]);
  });
});
