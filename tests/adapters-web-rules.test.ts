import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import { claudeAutonomyFlags } from "../src/claude-autonomy.js";

describe("Run request web rules", () => {
  for (const adapter of [new ClaudeAdapter({}), new ZaiAdapter({})]) {
    test(`${adapter.id} denies web tools exactly once with or without autonomy`, () => {
      for (const autonomy of [undefined, "read-only", "low", "medium", "high"] as const) {
        const flags = adapter.buildRunCommand({
          agent: adapter.id, prompt: "test", web: false, autonomy,
        });
        expect(flags.filter((flag) => flag === "--disallowedTools")).toHaveLength(1);
        const denyAt = flags.indexOf("--disallowedTools");
        expect(flags.slice(denyAt, denyAt + 3)).toEqual([
          "--disallowedTools", "WebSearch", "WebFetch",
        ]);
        expect(flags.filter((flag) => flag === "WebSearch")).toHaveLength(1);
        expect(flags.filter((flag) => flag === "WebFetch")).toHaveLength(1);
        if (autonomy === undefined) {
          expect(flags).not.toContain("--permission-mode");
          expect(flags).not.toContain("--dangerously-skip-permissions");
        }
      }
    });

    test(`${adapter.id} denies web tools exactly once for experiment runs`, () => {
      const flags = adapter.buildRunCommand({
        agent: adapter.id, prompt: "test", web: false, autonomy: "read-only",
        hermetic: true, tools: "none", sandboxed: true,
        experimentMcp: join(import.meta.dir, "fixtures", "no-web-experiment.json"),
      });
      expect(flags.filter((flag) => flag === "--disallowedTools")).toHaveLength(1);
      expect(flags.slice(flags.indexOf("--disallowedTools"))).toEqual([
        "--disallowedTools", "WebSearch", "WebFetch",
      ]);
    });

    test(`${adapter.id} rejects defined nonboolean web values`, () => {
      for (const web of ["false", "true", 0, 1, null, {}, []]) {
        expect(() => adapter.validateRunRequest({
          agent: adapter.id, prompt: "test", web: web as unknown as boolean,
        })).toThrow("web must be a boolean");
      }
    });

    test(`${adapter.id} accepts boolean and omitted web values`, () => {
      for (const web of [false, true, undefined]) {
        expect(() => adapter.validateRunRequest({
          agent: adapter.id, prompt: "test", web,
        })).not.toThrow();
      }
      expect(() => adapter.validateRunRequest({
        agent: adapter.id, prompt: "test",
      })).not.toThrow();
    });
  }

  test('the "deny" web rule preserves other autonomy flags without web grants', () => {
    for (const autonomy of ["read-only", "low", "medium", "high"] as const) {
      expect(claudeAutonomyFlags(autonomy, "/tmp/launch", { web: "deny" })).toEqual([
        ...claudeAutonomyFlags(autonomy, "/tmp/launch", { web: "callback" }),
        "--disallowedTools", "WebSearch", "WebFetch",
      ]);
    }
  });
});
