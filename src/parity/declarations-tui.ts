import type { AgentId } from "../types.js";
import { supported, type FeatureState, type TuiFeature } from "./features.js";
import { RUN_REASONS } from "./reasons-run.js";
import { W2_RUN_LIMITATIONS } from "./reasons-run-w2.js";

export const TUI_DECLARATIONS = {
  claude: {
    "tui.model": supported("tests/adapters-claude.test.ts"),
    "tui.effort": supported("tests/adapters-claude.test.ts"),
    "tui.provider-override": supported("tests/provider-override-mappings-claude.test.ts"),
  },
  codex: {
    "tui.model": supported("tests/adapters-codex-argv.test.ts"),
    "tui.effort": supported("tests/adapters-codex-argv.test.ts"),
    "tui.provider-override": supported("tests/codex-tui-provider.test.ts",
      "The private per-launch CODEX_HOME a plain override run gets (writeCodexProviderConfig) rides prepareTuiEnvironment, which both TUI launch paths call and finalize; the key the config's env_key names rides the environment and -m stays off."),
  },
  zai: {
    "tui.model": supported("tests/adapters-zai.test.ts"),
    "tui.effort": supported("tests/adapters-zai.test.ts"),
    "tui.provider-override": supported("tests/provider-override-mappings-zai.test.ts"),
  },
  agy: {
    "tui.model": supported("tests/new-adapters.test.ts"),
    "tui.effort": supported("tests/new-adapters.test.ts"),
    "tui.provider-override": W2_RUN_LIMITATIONS.agyProvider,
  },
  aider: {
    "tui.model": supported("tests/new-adapters-aider.test.ts"),
    "tui.effort": supported("tests/new-adapters-aider.test.ts"),
    "tui.provider-override": supported("tests/provider-override-mappings-aider.test.ts"),
  },
  cline: {
    "tui.model": supported("tests/new-adapters-cline.test.ts"),
    "tui.effort": supported("tests/new-adapters-cline.test.ts"),
    "tui.provider-override": supported("tests/cline-run-parity.test.ts"),
  },
  copilot: {
    "tui.model": supported("tests/new-adapters-copilot.test.ts"),
    "tui.effort": supported("tests/new-adapters-copilot.test.ts"),
    "tui.provider-override": supported("tests/copilot-parity.test.ts"),
  },
  cursor: {
    "tui.model": supported("tests/new-adapters-cursor.test.ts"),
    "tui.effort": RUN_REASONS.cursorEffort,
    "tui.provider-override": supported("tests/cursor-run-parity.test.ts", "CURSOR_API_ENDPOINT and CURSOR_API_KEY ride the TUI environment under an override."),
  },
  droid: {
    "tui.model": supported("tests/adapters-droid.test.ts", "The sessionDefaultSettings settings file selects the model through the root-level --settings flag."),
    "tui.effort": supported("tests/adapters-droid.test.ts", "The settings file's sessionDefaultSettings.reasoningEffort carries the effort."),
    "tui.provider-override": supported("tests/provider-override-mappings-droid.test.ts", "The TUI settings file carries the BYOK entry; the key rides the environment."),
  },
  gemini: {
    "tui.model": supported("tests/adapters-gemini.test.ts"),
    "tui.effort": RUN_REASONS.geminiEffort,
    "tui.provider-override": supported("tests/gemini-tui.test.ts"),
  },
  goose: {
    "tui.model": supported("tests/adapters-goose.test.ts", "Model selection is carried by GOOSE_MODEL."),
    "tui.effort": supported("tests/adapters-goose.test.ts", "Effort is carried by GOOSE_THINKING_EFFORT."),
    "tui.provider-override": supported("tests/provider-override-mappings-goose.test.ts"),
  },
  kimi: {
    "tui.model": supported("tests/provider-override-mappings-kimi.test.ts"),
    "tui.effort": supported("tests/kimi.test.ts", "Effort rides KIMI_MODEL_THINKING_EFFORT in the TUI environment, the same env alias the run path uses."),
    "tui.provider-override": supported("tests/provider-override-mappings-kimi.test.ts"),
  },
  opencode: {
    "tui.model": supported("tests/adapters-extended.test.ts"),
    "tui.effort": supported("tests/opencode-tui-lifecycle.test.ts", "Requires an explicit provider/model selector or a provider override model."),
    "tui.provider-override": supported("tests/opencode-run-parity.test.ts"),
  },
  openhands: {
    "tui.model": supported("tests/provider-override-mappings-openhands.test.ts", "Model selection is carried by LLM_MODEL with --override-with-envs."),
    "tui.effort": RUN_REASONS.openhandsEffort,
    "tui.provider-override": supported("tests/provider-override-mappings-openhands.test.ts"),
  },
  pi: {
    "tui.model": supported("tests/adapters-extended.test.ts"),
    "tui.effort": supported("tests/adapters-extended.test.ts"),
    "tui.provider-override": supported("tests/pi-tui-provider.test.ts"),
  },
  qwen: {
    "tui.model": supported("tests/adapters-extended.test.ts", "The current qwen CLI supports model selection; legacy qwen-coder refuses it."),
    "tui.effort": supported("tests/qwen-run-parity.test.ts", "prepareTuiEnvironment writes the private effort settings file and points QWEN_EFFORT_SETTINGS_ENV at it; finalize removes it."),
    "tui.provider-override": supported("tests/qwen-run-parity.test.ts", "The provider environment (OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL) rides prepareTuiEnvironment with the effort settings."),
  },
} satisfies Record<AgentId, Record<TuiFeature, FeatureState>>;
