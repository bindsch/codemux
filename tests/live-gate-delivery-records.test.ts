import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyExperimentEcho } from "../scripts/live-gate/experiment-echo.js";
import { fixtureDirectory } from "./helpers/live-gate.js";
import { MARKER } from "./fixtures/experiment-mcp.js";

test("probe G checks Gemini's actual wrapper and Copilot/Cline's bare content", () => {
  for (const agent of ["gemini", "copilot", "cline"] as const) {
    const wrapped = `<untrusted_context>\n${MARKER}\n</untrusted_context>`;
    for (const text of [MARKER, wrapped, wrapped + "\nchanged", wrapped.replace(MARKER, "wrong")]) {
      const directory = fixtureDirectory();
      try {
        writeFileSync(join(directory, "delivery.jsonl"), [
          { kind: "model_tool_result", call_id: "call", content: [{ type: "text", text }] },
          { kind: "result_comparison", call_id: "call", equal: true },
        ].map((record) => JSON.stringify(record) + "\n").join(""));
        const failure = verifyExperimentEcho(MARKER, MARKER, agent, directory);
        if (text === (agent === "gemini" ? wrapped : MARKER)) expect(failure).toBeNull();
        else expect(failure).not.toBeNull();
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  }
});
