// Review m1 and m2 (scratch/fix/review-owner-integration.md): every
// relay-bound experiment harness -- every table entry except the
// stdio-bridged claude family -- refuses the loopback-cutting sandbox
// policy, whether it arrives as a request flag or as an options-only
// launcher override, before any preparation.
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAdapter } from "../src/adapters/index.js";
import { assertExperimentLoopbackPolicy, EXPERIMENT_MCP_HARNESSES } from "../src/experiment-mcp.js";
import { launchRunRequest } from "../src/launch.js";
import type { AgentId, RunRequest } from "../src/types.js";

const RELAY_HOSTS = (Object.keys(EXPERIMENT_MCP_HARNESSES) as AgentId[]).filter((agent) => agent !== "claude" && agent !== "zai");

describe("experiment loopback policy", () => {
  test("covers every relay host in the table (m2)", () => {
    expect(RELAY_HOSTS.length).toBeGreaterThan(0);
    for (const agent of RELAY_HOSTS) {
      expect(() => assertExperimentLoopbackPolicy({ agent, sandboxNoNet: true }), agent).toThrow("refuses --sandbox-no-net");
      expect(() => assertExperimentLoopbackPolicy({ agent, sandboxTrust: "untrusted" }), agent).toThrow("refuses --sandbox-trust untrusted");
    }
    for (const agent of ["claude", "zai"] as const) {
      expect(() => assertExperimentLoopbackPolicy({ agent, sandboxNoNet: true, sandboxTrust: "untrusted" })).not.toThrow();
    }
  });

  test("a new table entry without a prefix inherits the refusals (m2)", () => {
    const table = EXPERIMENT_MCP_HARNESSES as Partial<Record<AgentId, readonly string[]>>;
    expect(table.cursor).toBeUndefined();
    table.cursor = [];
    try {
      expect(() => assertExperimentLoopbackPolicy({ agent: "cursor", sandboxNoNet: true })).toThrow("refuses --sandbox-no-net");
    } finally { delete table.cursor; }
  });

  test.each(RELAY_HOSTS.flatMap((agent) => [[agent, "noNet"], [agent, "trust"]] as const))(
    "%s: an options-only %s override is refused before preparation (m1)", async (agent, constraint) => {
      const cwd = mkdtempSync(join(tmpdir(), "codemux-loopback-"));
      const adapter = getAdapter(agent, {});
      const prepare = spyOn(adapter, "prepareRun").mockImplementation(() => { throw new Error("unexpected preparation"); });
      const request: RunRequest = { agent, prompt: "fixture", cwd, hermetic: true, autonomy: "read-only",
        sandboxed: true, experimentMcp: join(cwd, "spec.json") };
      try {
        await expect(launchRunRequest(adapter, request, { sandbox: true, cwd, requestedAutonomy: "read-only",
          sandboxPolicyOverrides: constraint === "noNet" ? { noNet: true } : { trust: "untrusted" } }))
          .rejects.toThrow(constraint === "noNet" ? "refuses --sandbox-no-net" : "refuses --sandbox-trust untrusted");
        expect(prepare).not.toHaveBeenCalled();
      } finally { prepare.mockRestore(); }
    });
});
