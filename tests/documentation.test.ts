import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { runCli } from "./helpers/cli.js";
import { parseInputLine } from "../src/session/protocol.js";
import { claudeSessionCapabilities } from "../src/session/claude-session.js";
import { readExperimentSpec } from "../src/experiment-mcp.js";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const markdownFiles = (directory: string): string[] =>
  readdirSync(join(root, directory)).flatMap((name) => {
    const path = join(directory, name);
    return statSync(join(root, path)).isDirectory()
      ? markdownFiles(path)
      : path.endsWith(".md") ? [path] : [];
  });
const documents = [
  "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md",
  ...markdownFiles("docs"),
];

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
      "src/check-command.ts", "src/calls-command.ts", "src/session/cli.ts"]) {
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
