import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { runCli } from "./helpers/cli.js";
import { parseInputLine } from "../src/session/protocol.js";
import { claudeSessionCapabilities, CLAUDE_SESSION_FLOOR } from "../src/session/claude-session.js";
import { ZAI_SESSION_FLOOR } from "../src/session/zai-session.js";
import { CODEX_SESSION_FLOOR } from "../src/session/codex-session.js";
import { AGY_SESSION_FLOOR } from "../src/session/agy-session.js";
import { OPENCODE_SESSION_FLOOR } from "../src/session/opencode-session.js";
import { AIDER_SESSION_FLOOR } from "../src/session/aider-session.js";
import { KIMI_SESSION_FLOOR } from "../src/session/kimi-session.js";
import { CURSOR_SESSION_FLOOR } from "../src/session/cursor-session.js";
import { DROID_SESSION_FLOOR } from "../src/session/droid-session.js";
import { PI_SESSION_FLOOR } from "../src/session/pi-session.js";
import { QWEN_SESSION_FLOOR } from "../src/session/qwen-session.js";
import { GEMINI_SESSION_FLOOR } from "../src/session/gemini-session.js";
import { COPILOT_SESSION_FLOOR } from "../src/session/copilot-session.js";
import { GOOSE_SESSION_FLOOR } from "../src/session/goose-session.js";
import { CLINE_SESSION_FLOOR } from "../src/session/cline-session.js";
import { openhandsSessionFloor } from "../src/session/openhands-session.js";
import { readExperimentSpec } from "../src/experiment-mcp.js";
import { getAllAdapters } from "../src/adapters/index.js";
import { FEATURE_FLOORS, HARNESS_CONTRACTS } from "../src/harness-contracts.js";
import { AGENT_IDS } from "../src/types.js";
import { DEFAULT_QUOTA_POLICY } from "../src/config.js";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const markdownFiles = (directory: string): string[] =>
  readdirSync(join(root, directory)).flatMap((name) => {
    const path = join(directory, name);
    return statSync(join(root, path)).isDirectory()
      ? markdownFiles(path)
      : path.endsWith(".md") ? [path] : [];
  });
const sourceFiles = (directory: string): string[] =>
  readdirSync(join(root, directory)).flatMap((name) => {
    const path = join(directory, name);
    return statSync(join(root, path)).isDirectory()
      ? sourceFiles(path)
      : path.endsWith(".ts") ? [path] : [];
  });
const documents = [
  "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md",
  ...markdownFiles("docs"),
];
// Current pages are everything under docs/ outside the archive; the archive
// holds dated evidence that names historical versions on purpose.
const currentPages = (): string[] =>
  markdownFiles("docs").filter((path) => !path.startsWith("docs/archive/"));

function section(text: string, heading: string): string {
  const body = text.split("## " + heading + "\n")[1];
  if (body === undefined) throw new Error("no section " + heading);
  return body.split("\n## ")[0]!;
}

// The last purely-numeric quoted argument of the .option() call naming the
// flag is the commander default the CLI parses.
function optionDefault(path: string, flag: string): string {
  const text = read(path);
  const start = text.indexOf('"' + flag);
  if (start < 0) throw new Error(flag + " not found in " + path);
  const end = Math.min(text.indexOf(".option(", start + 1), text.indexOf(".command(", start + 1));
  const literals = [...text.slice(start, end > 0 ? end : start + 400).matchAll(/"([^"]*)"/g)]
    .map((match) => match[1]!).filter((value) => /^\d+$/.test(value));
  if (literals.length === 0) throw new Error("no numeric default for " + flag + " in " + path);
  return literals[literals.length - 1]!;
}

function links(text: string): string[] {
  return [...text.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)]
    .map((match) => match[1]!);
}

function anchors(text: string): Set<string> {
  const found = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!/^#{1,6} /.test(line)) continue;
    const slug = line.replace(/^#+\s+/, "").toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-");
    const count = counts.get(slug) ?? 0;
    found.add(count ? slug + "-" + count : slug);
    counts.set(slug, count + 1);
  }
  return found;
}

describe("documentation integrity", () => {
  test("every docs/ path named in source names an existing file", () => {
    // Source strings and comments point operators at documents (refusal
    // messages name docs/isolation.md, adapter comments cite sections). A
    // renamed or deleted document that a message still names sends the
    // operator to a missing file, so the scan covers the whole source
    // text, comments included.
    const sources = sourceFiles("src");
    expect(sources.length).toBeGreaterThan(100);
    let named = 0;
    for (const path of sources) {
      // Upstream URLs (a Qwen approval-mode document on GitHub among them)
      // carry the same docs/... shape; only local paths are in scope.
      const text = read(path).replace(/https?:\/\/[^\s"'`)]+/g, "");
      for (const match of text.matchAll(/docs\/[A-Za-z0-9_./-]+\.md/g)) {
        named++;
        expect(existsSync(join(root, match[0]!)), path + " names " + match[0]).toBe(true);
      }
    }
    expect(named).toBeGreaterThan(30);
  });

  test("every tests/ file named in a comment names an existing file", () => {
    // Comments point at the test that pins a behavior ("the busy refusal
    // is pinned in tests/..."). Splitting a test file leaves such pointers
    // stale (review round 3, minors 4), so every reference must name a real
    // file — except a provenance note, where the same breath says the file
    // is where the content came from and no longer exists.
    const sources = ["src", "scripts", "tests"].flatMap(sourceFiles);
    let named = 0;
    let provenance = 0;
    for (const path of sources) {
      const text = read(path);
      for (const match of text.matchAll(/tests\/[A-Za-z0-9_./-]+\.test\.ts/g)) {
        const before = text.slice(Math.max(0, match.index - 80), match.index);
        // "split from" may wrap across a comment line break, and the
        // phrasing varies ("split from", "split out of").
        if (/\bformer\b|\bsplit\b[\s\S]{0,20}\b(from|out of|off)\b/i.test(before)) {
          provenance++;
          continue;
        }
        named++;
        expect(existsSync(join(root, match[0]!)), path + " names " + match[0]).toBe(true);
      }
    }
    expect(named).toBeGreaterThan(5);
    expect(provenance).toBeGreaterThan(20);
  });

  test("all source-tree links and local heading anchors resolve", () => {
    for (const path of documents) {
      for (const link of links(read(path))) {
        if (/^(https?:|mailto:)/.test(link)) continue;
        const [file, fragment] = decodeURIComponent(link).split("#");
        const target = file ? normalize(join(dirname(path), file)) : path;
        expect(existsSync(join(root, target)), path + " -> " + link).toBe(true);
        if (fragment && target.endsWith(".md")) {
          expect(anchors(read(target)).has(fragment), path + " -> " + link).toBe(true);
        }
      }
    }
  });

  test("links survive Homebrew relocation of README, CHANGELOG, and LICENSE", () => {
    const relocated = new Set(["README.md", "CHANGELOG.md", "LICENSE"]);
    const installedPath = (path: string): string =>
      relocated.has(path) ? path : join("libexec", path);
    for (const path of documents) {
      for (const link of links(read(path))) {
        if (/^(https?:|mailto:|#)/.test(link)) continue;
        const file = decodeURIComponent(link.split("#")[0]!);
        const sourceTarget = normalize(join(dirname(path), file));
        const installedTarget = normalize(join(dirname(installedPath(path)), file));
        expect(installedTarget, path + " -> " + link).toBe(installedPath(sourceTarget));
      }
    }
  });

  test("repository navigation URLs name files in the candidate tree", () => {
    const prefix = "https://github.com/bindsch/codemux/blob/main/";
    for (const path of documents) {
      for (const link of links(read(path)).filter((value) => value.startsWith(prefix))) {
        expect(existsSync(join(root, link.slice(prefix.length).split("#")[0]!)),
          path + " -> " + link).toBe(true);
      }
    }
  });

  test("every parsed command and option has a current reference", () => {
    const reference = read("docs/cli.md") + read("docs/sessions.md");
    for (const path of ["src/index.ts", "src/info-commands.ts",
      "src/check-command.ts", "src/calls-command.ts", "src/session/cli.ts", "src/complete/command.ts"]) {
      const source = read(path);
      for (const match of source.matchAll(/\.command\("([^"]+)"/g)) {
        const name = match[1]!;
        expect(reference.includes("`" + name + "`") ||
          new RegExp("^## " + name + "$", "m").test(reference), name).toBe(true);
      }
      for (const match of source.matchAll(/\.option\(\s*"([^"]+)"/g)) {
        const long = match[1]!.match(/--[a-z][a-z-]*/)?.[0];
        expect(long).toBeDefined();
        expect(reference, path).toContain(long!);
      }
    }
  });

  test("experiment option rows and structured adapter count match current capabilities", () => {
    const structured = getAllAdapters().filter((adapter) => adapter.capabilities().supportsResultJson);
    // The count follows the adapters; the matrix row's Result JSON cell is
    // the pinned statement (tests/harness-compatibility-policy.ts).
    expect(structured.length).toBeGreaterThanOrEqual(6);
    expect(read("docs/harnesses.md")).toContain("describe the structured adapters");
    for (const adapter of structured) {
      expect(read("docs/results-and-usage.md"), adapter.id).toContain(adapter.id);
    }
    const rows = read("docs/cli.md").split("\n").filter((line) => line.startsWith("| `--experiment-mcp"));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      for (const agent of ["claude", "zai", "codex", "kimi"]) expect(row).toContain("`" + agent + "`");
    }
    expect(rows[1]).toContain("paired checks are unsupported");
  });

  test("Codex exec refusal documents both native item types", () => {
    for (const path of ["docs/experiment-mcp.md", "docs/experiment-codex-catalog.md"]) {
      const text = read(path).replace(/\s+/g, " ");
      expect(text).toContain("`unknown_tool` for either `function_call` or `custom_tool_call`");
      expect(text).toContain("inventory function named `exec` remains allowed");
    }
  });

  test("relay documentation distinguishes valid notifications from tools/call violations", () => {
    const text = read("docs/experiment-mcp.md");
    expect(text).toContain("Valid notifications get HTTP 202 with no body");
    expect(text).toContain("`tools/call` notification lacks a required request ID");
    expect(text).toContain("HTTP 400 and fails with `protocol` before dispatch");
  });

  test("inventory documentation names both sanitizers and shared validation", () => {
    const text = read("docs/experiment-mcp.md");
    for (const expected of ["mcpCore/tool-naming.ts", "codex-mcp/src/mcp/mod.rs:601",
      "shared inventory validator checks both sanitizers for every harness before exposing tools",
      "`foo__bar` / `foo_bar`", "`foo-bar` / `foo_bar`"]) expect(text).toContain(expected);
  });

  test("sessions documentation partitions every agent into driver and no-driver", async () => {
    // The supported-agents table names the SESSION_AGENTS driver set, and
    // the no-driver list names everyone else with a reason. Together they
    // must cover AGENT_IDS exactly once each: a new agent that lands in
    // neither list, or a driver removed while its bullet stays, is drift.
    const { SESSION_AGENTS } = await import("../src/session/cli.js");
    const { AGENT_IDS } = await import("../src/types.js");
    const section = read("docs/sessions.md").split("## Supported agents\n")[1]?.split("\n## ")[0];
    if (section === undefined) {
      throw new Error("docs/sessions.md has no Supported agents section");
    }
    const tableAgents = [...section.matchAll(/^\| `([a-z]+)` \|/gm)].map((match) => match[1]!);
    expect([...tableAgents].sort()).toEqual(Object.keys(SESSION_AGENTS).sort());
    const bulletAgents = [...section.matchAll(/^- `([a-z]+)`: /gm)].map((match) => match[1]!);
    expect([...new Set([...bulletAgents, ...tableAgents])].sort())
      .toEqual([...AGENT_IDS].sort());
    expect(bulletAgents, "a no-driver bullet names a driver").toEqual(
      bulletAgents.filter((agent) => !(agent in SESSION_AGENTS))
    );
  });

  test("published README input is accepted by the protocol parser", () => {
    const inputs = [...read("README.md").matchAll(/'(\{"type":"[^']+\})'/g)];
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(parseInputLine(input[1]!, {
        capabilities: claudeSessionCapabilities(), hasActiveTurn: false,
        pendingRequestIds: new Set(), shuttingDown: false,
      }).ok).toBe(true);
    }
  });

  test("experiment example resolves a valid spec without launching a model", async () => {
    const example = read("docs/experiment-mcp.md");
    const code = example.match(/bun -e '([\s\S]*?)' > scratch\/experiment-mcp.json/)?.[1];
    expect(code).toBeDefined();
    const child = Bun.spawn([process.execPath, "-e", code!], { cwd: root, stdout: "pipe" });
    const spec = JSON.parse(await new Response(child.stdout).text());
    expect(await child.exited).toBe(0);
    expect(existsSync(spec.command)).toBe(true);
    expect(existsSync(spec.args[0])).toBe(true);
    mkdirSync(join(root, "scratch"), { recursive: true });
    const directory = mkdtempSync(join(root, "scratch", "docs-spec-"));
    try {
      const path = join(directory, "spec.json");
      writeFileSync(path, JSON.stringify(spec));
      expect(readExperimentSpec(path)).toEqual({
        ...spec, recording: join(directory, "recordings"),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("metadata and CLI version stay aligned without a duplicated README banner", async () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg).toMatchObject({
      name: "codemux", private: true,
      description: "Unified CLI for AI coding agents", license: "MIT",
      bin: { codemux: "./bin/codemux" },
      repository: { type: "git", url: "https://github.com/bindsch/codemux.git" },
    });
    expect(read("LICENSE")).toContain("Copyright (c) 2026 Laurent Bindschaedler");
    const result = await runCli(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
    expect(read("README.md")).not.toMatch(/^#.*v\d/m);
    expect(read("CHANGELOG.md")).toContain("## [" + pkg.version + "]");
    // docs/RELEASE-GATE.md and docs/RELEASING.md both require the heading:
    // a release moves entries into the dated section and keeps a fresh
    // [Unreleased] for what lands next (round 16, minor 6).
    expect(read("CHANGELOG.md")).toContain("## [Unreleased]");
  });

  test("make checks each shell script instead of passing the second as an argument", async () => {
    const child = Bun.spawn(["make", "-n", "shell"], { cwd: root, stdout: "pipe" });
    const commands = (await new Response(child.stdout).text()).trim().split("\n");
    expect(await child.exited).toBe(0);
    for (const script of ["bin/codemux", "scripts/aliases.sh"]) {
      expect(commands).toContain("sh -n " + script);
    }
    expect(JSON.parse(read("package.json")).scripts.check).toBe("make check");
    expect(JSON.parse(read("package.json")).scripts.smoke).toBe("make smoke");
  });

  test("documentation does not expose a literal personal home path", () => {
    for (const path of documents) {
      expect(read(path), relative(root, join(root, path))).not.toMatch(/\/(?:Users|home)\/[A-Za-z0-9_.-]+/);
    }
  });
});

describe("current documentation set", () => {
  test("current pages name no codemux release or commit hash", () => {
    for (const path of currentPages()) {
      const text = read(path);
      expect(text.match(/codemux v?\d+\.\d+\.\d+/i), path).toBeNull();
      for (const match of text.matchAll(/`([0-9a-f]{7,40})`/g)) {
        // Digits-only strings are timestamps and ports; a hash carries a-f.
        expect(/[a-f]/.test(match[1]!), path + " names " + match[1]).toBe(false);
      }
    }
  });

  test("the harnesses version-contract table equals HARNESS_CONTRACTS", () => {
    const rows = new Map([...section(read("docs/harnesses.md"), "Version contracts")
      .matchAll(/^\| [^|]+ \| ([a-z]+) \| ([^|]+?) \| ([^|]+?) \|/gm)]
      .map((match) => [match[1]!, [match[2]!.trim().toLowerCase(), match[3]!.trim().toLowerCase()]]));
    expect([...rows.keys()].sort()).toEqual([...AGENT_IDS].sort());
    for (const agent of AGENT_IDS) {
      const [minimum, ceiling] = rows.get(agent)!;
      const contract = HARNESS_CONTRACTS[agent];
      if (contract === undefined) {
        expect(minimum, agent).toBe("none");
        expect(ceiling, agent).toBe("none");
      } else {
        expect(minimum, agent).toBe(contract.min);
        expect(ceiling, agent).toBe(contract.maxAudited);
      }
    }
  });

  test("the sessions table equals the session floor constants", () => {
    const rows = new Map([...section(read("docs/sessions.md"), "Supported agents")
      .matchAll(/^\| `([a-z]+)` \| ([\d.]+) \|/gm)].map((match) => [match[1]!, match[2]!]));
    expect(rows.size).toBeGreaterThan(0);
    const floors: Record<string, string | undefined> = {
      claude: CLAUDE_SESSION_FLOOR, zai: ZAI_SESSION_FLOOR, codex: CODEX_SESSION_FLOOR,
      agy: AGY_SESSION_FLOOR, opencode: OPENCODE_SESSION_FLOOR, aider: AIDER_SESSION_FLOOR,
      kimi: KIMI_SESSION_FLOOR, cursor: CURSOR_SESSION_FLOOR, droid: DROID_SESSION_FLOOR,
      pi: PI_SESSION_FLOOR, qwen: QWEN_SESSION_FLOOR, gemini: GEMINI_SESSION_FLOOR,
      copilot: COPILOT_SESSION_FLOOR, goose: GOOSE_SESSION_FLOOR,
      cline: CLINE_SESSION_FLOOR, openhands: openhandsSessionFloor(),
    };
    expect([...rows.keys()].sort()).toEqual(Object.keys(floors).sort());
    for (const [agent, floor] of Object.entries(floors)) {
      expect(rows.get(agent), agent).toBe(floor);
    }
  });

  test("experiment floors agree across launch.ts and both experiment pages", () => {
    // Launch no longer spells the floors inline; it reads FEATURE_FLOORS
    // (the same table doctor reads), so the table is the code side here.
    const claudeFloor = FEATURE_FLOORS.claude?.["experiment-mcp"];
    const codexFloor = FEATURE_FLOORS.codex?.["experiment-mcp"];
    const kimiFloor = FEATURE_FLOORS.kimi?.["experiment-mcp"];
    expect(claudeFloor).toBeDefined();
    expect(codexFloor).toBeDefined();
    expect(kimiFloor).toBeDefined();
    const harnesses = read("docs/harnesses.md").match(
      /Claude\/Z\.AI require Claude Code ([\d.]+) or later, Codex requires CLI ([\d.]+) or later, and Kimi requires Code ([\d.]+) or later/,
    );
    const mcp = read("docs/experiment-mcp.md").match(
      /Codex requires CLI ([\d.]+) or later; Claude\/Z\.AI require Claude Code ([\d.]+) or later\. Kimi requires Code ([\d.]+) or later/,
    );
    expect(harnesses).toBeDefined();
    expect(mcp).toBeDefined();
    // harnesses: claude, codex, kimi; mcp: codex, claude, kimi.
    expect([claudeFloor!, codexFloor!, kimiFloor!]).toEqual([harnesses![1]!, harnesses![2]!, harnesses![3]!]);
    expect([mcp![1]!, mcp![2]!, mcp![3]!]).toEqual([codexFloor!, claudeFloor!, kimiFloor!]);
  });

  test("every current page carries a read_when purpose", () => {
    for (const path of currentPages()) {
      const text = read(path);
      expect(text.startsWith("---\n"), path).toBe(true);
      const frontMatter = text.slice(0, text.indexOf("\n---\n", 3));
      expect(frontMatter.includes("read_when"), path).toBe(true);
    }
  });

  test("dated report files live only under docs/archive/", () => {
    for (const path of markdownFiles("docs")) {
      const name = path.split("/").pop()!;
      if (/(?:^|-)report\.md$/.test(name) || /^(?:LIVE-SESSIONS|HISTORICAL)-/.test(name)) {
        expect(path.startsWith("docs/archive/"), path).toBe(true);
      }
    }
  });

  test("every root-level markdown file is reachable from README or the index", () => {
    const targets = new Set<string>();
    const prefix = "https://github.com/bindsch/codemux/blob/main/";
    for (const path of ["README.md", "docs/index.md"]) {
      for (const link of links(read(path))) {
        if (link.startsWith(prefix)) targets.add(link.slice(prefix.length).split("#")[0]!);
        else if (!/^(https?:|mailto:|#)/.test(link)) {
          targets.add(normalize(join(dirname(path), decodeURIComponent(link.split("#")[0]!))));
        }
      }
    }
    for (const name of readdirSync(root).filter((entry) => entry.endsWith(".md"))) {
      if (name === "README.md") continue;
      expect(targets.has(name), name).toBe(true);
    }
  });

  test("documented defaults equal the commander-parsed defaults", () => {
    const runTimeout = optionDefault("src/run-command.ts", "--timeout <seconds>");
    const checkTimeout = optionDefault("src/check-command.ts", "--timeout <seconds>");
    const usageTimeout = optionDefault("src/info-commands.ts", "--timeout <seconds>");
    const completeTimeout = optionDefault("src/complete/command.ts", "--timeout <seconds>");
    const cliTimeouts = [...read("docs/cli.md").matchAll(/^\| `--timeout <seconds>` \| (\d+)/gm)]
      .map((match) => match[1]!);
    expect(cliTimeouts.slice().sort()).toEqual([runTimeout, checkTimeout, usageTimeout, completeTimeout].sort());
    expect(cliTimeouts).toHaveLength(4);

    const limit = read("src/calls-command.ts").match(/const DEFAULT_LIMIT = (\d+)/)![1]!;
    expect(read("docs/cli.md")).toMatch(new RegExp("^\\| `-n, --limit <count>` \\| " + limit + "\\b", "m"));

    const seconds = read("docs/sessions.md");
    for (const [flag, option] of [["--permission-timeout", "permissionTimeout"],
      ["--shutdown-grace", "shutdownGrace"]] as const) {
      const fallback = read("src/session/cli-request.ts")
        .match(new RegExp("options\\." + option + "[^)]*\\)\\s*\\?\\?\\s*([\\d_]+)"))![1]!
        .replace(/_/g, "");
      const documented = Number(seconds.match(new RegExp("^\\| `" + flag + " <seconds>` \\| (\\d+)", "m"))![1]!);
      expect(String(documented * 1000), flag).toBe(fallback);
    }

    const config = read("docs/configuration.md");
    const usage = read("docs/results-and-usage.md");
    for (const key of ["minRemainingPercent", "weeklyWarnUsedPercent", "timeoutSeconds"] as const) {
      expect(config).toMatch(new RegExp("^  " + key + ": " + DEFAULT_QUOTA_POLICY[key] + "$", "m"));
      expect(usage).toMatch(new RegExp("^\\| `" + key + "` \\| " + DEFAULT_QUOTA_POLICY[key] + " \\|", "m"));
    }
  });

});
