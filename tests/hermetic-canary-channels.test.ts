import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { CANARY_MARKER_PATTERN, plantCanary } from "../src/hermetic-canary.js";
import { HERMETIC_CHECK_CHANNELS } from "../src/hermetic-check-channels.js";

function scratch(): string {
  const parent = join(import.meta.dir, "../scratch");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "canary-channels-"));
}

test("legacy session and experiment plants keep both instruction files", () => {
  const root = scratch();
  try {
    for (const experiment of [false, true]) {
      const plant = plantCanary(experiment, root);
      try {
        expect(plant.marker).toMatch(CANARY_MARKER_PATTERN);
        for (const name of ["AGENTS.md", "CLAUDE.md"]) {
          expect(readFileSync(join(plant.cwd, name), "utf8")).toContain(plant.marker);
        }
        expect(existsSync(join(plant.cwd, ".claude/skills/canary/SKILL.md"))).toBe(experiment);
        expect(existsSync(join(plant.cwd, ".mcp.json"))).toBe(experiment);
      } finally { plant.cleanup(); }
      expect(existsSync(plant.cwd)).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [agent, channel] of Object.entries(HERMETIC_CHECK_CHANNELS)) {
  if (channel.kind === "limitation" || "custom" in channel) continue;
  test(`${agent} plants only its declared files in an owned scratch directory`, () => {
    const root = scratch();
    try {
      const plant = plantCanary(channel, root);
      try {
        expect(existsSync(join(plant.cwd, ".git"))).toBe(true);
        expect(plant.home !== undefined).toBe(channel.location === "home");
        for (const [name, template] of Object.entries(channel.files)) {
          const path = join(plant.home ?? plant.cwd, name);
          expect(readFileSync(path, "utf8")).toBe(template.replaceAll("{{MARKER}}", plant.marker));
          expect(statSync(path).mode & 0o777).toBe(0o600);
          if (plant.home) expect(existsSync(join(plant.cwd, name))).toBe(false);
        }
        expect(readdirSync(plant.cwd).sort()).toEqual(
          channel.location === "home" ? [".git", "operator"] : [".git", ...Object.keys(channel.files)].sort()
        );
      } finally { plant.cleanup(); }
      expect(readdirSync(root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("a failed file plant removes its partially created directory", () => {
  const root = scratch();
  try {
    expect(() => plantCanary({ ...HERMETIC_CHECK_CHANNELS.claude,
      files: { blocked: "file", "blocked/child": "{{MARKER}}" },
    }, root)).toThrow();
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each(["exit", "SIGINT", "SIGTERM", "SIGHUP"])("scratch home is removed on %s", async (ending) => {
  const root = scratch();
  const runtimeHome = join(root, "runtime-home");
  mkdirSync(runtimeHome);
  const canaryModule = join(import.meta.dir, "../src/hermetic-canary.ts");
  const channelsModule = join(import.meta.dir, "../src/hermetic-check-channels.ts");
  try {
    const code = `
      import { plantCanary } from ${JSON.stringify(canaryModule)};
      import { HERMETIC_CHECK_CHANNELS } from ${JSON.stringify(channelsModule)};
      const plant = plantCanary(HERMETIC_CHECK_CHANNELS.copilot, ${JSON.stringify(root)});
      console.log(plant.cwd);
      ${ending === "exit" ? "process.exit(17);" : `process.kill(process.pid, ${JSON.stringify(ending)}); setInterval(() => {}, 1000);`}
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e", code], {
      cwd: root, env: { PATH: "", HOME: runtimeHome }, stdout: "pipe", stderr: "pipe",
    });
    const [output, error, status] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(error).toBe("");
    expect(status).toBe({ exit: 17, SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[ending]);
    expect(output.trim()).toContain("codemux-canary-");
    expect(existsSync(output.trim())).toBe(false);
    expect(readdirSync(root)).toEqual(["runtime-home"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
