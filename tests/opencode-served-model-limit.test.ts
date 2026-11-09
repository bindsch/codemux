import { describe, expect, test } from "bun:test";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import { RUN_DECLARATIONS } from "../src/parity/declarations-run.js";
import { SERVED_MODEL_EVIDENCE_HARNESSES } from "../src/result-envelope/index.js";

describe("opencode ordinary served-model limitation", () => {
  test("ordinary launches retain pure mode even with a provider override", () => {
    const adapter = new OpencodeAdapter({
      PATH: "", CODEMUX_OPENCODE_PROVIDER_BASE_URL: "https://provider.invalid/v1",
      CODEMUX_OPENCODE_PROVIDER_API_KEY: "synthetic-key", CODEMUX_OPENCODE_PROVIDER_MODEL: "selected-model",
    });
    const command = adapter.buildRunCommand({ agent: "opencode", prompt: "synthetic", resultJson: true });
    expect(command).toContain("--pure");
    expect(command).toContain("codemux/selected-model");
    expect(command.join(" ")).not.toContain("synthetic-key");
    expect(SERVED_MODEL_EVIDENCE_HARNESSES.has("opencode")).toBe(false);
  });

  test.each(["selected-model", "different-model"])("JSON model labels remain unproved: %s", (model) => {
    const adapter = new OpencodeAdapter({ PATH: "" });
    const result = adapter.processRunResult({
      stdout: JSON.stringify({ type: "text", sessionID: "ses_synthetic12345", modelID: model,
        model, part: { text: "answer", modelID: model, model } }) + "\n",
      stderr: "", exitCode: 0, success: true,
    }, { agent: "opencode", prompt: "synthetic", model: "selected-model", resultJson: true });
    expect(result.success).toBe(true);
    expect(result.servedModel).toBeNull();
    expect(JSON.parse(result.stdout).codemux.served_model).toBeNull();
  });

  test.each(["run.served-model-evidence", "check.provider-override.served-model"] as const)(
    "%s records the native pure-mode and telemetry constraints", (feature) => {
      const state = RUN_DECLARATIONS.opencode[feature];
      expect(state.state).toBe("harness-limitation");
      if (state.state !== "harness-limitation") throw new Error("missing opencode limitation");
      expect(state.reason).not.toContain("OPEN:");
      expect(state.refusal).toBe("served_model: null");
      // Read from installed bin/opencode 1.19.5 on 2026-11-09; the server
      // plugin gate is UTF-16LE. It has no private-path or origin exception.
      expect(state.evidence).toContain("let T=n.pure?[]:y.plugin_origins??[];");
      expect(state.evidence).toContain("modelId:(Rt=j.modelId)!=null?Rt:Be.modelId");
    }
  );
});
