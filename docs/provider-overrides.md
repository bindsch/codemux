---
read_when: "Routing a harness to a different provider or setting token limits."
---
# Provider overrides

A provider override selects the endpoint and credentials used by one adapter. Set `CODEMUX_<AGENT>_PROVIDER_BASE_URL`, `CODEMUX_<AGENT>_PROVIDER_API_KEY`, and `CODEMUX_<AGENT>_PROVIDER_MODEL`, where AGENT is the uppercase codemux ID. The model can instead come from `--model` on adapters that support it; an effective model is required.

Keep the key in the environment, outside committed files and command arguments. Blank values count as unset. Partial overrides, unsupported adapters, malformed URLs/models, and unsupported limits fail before launch.

URLs must be absolute HTTP(S), without user/password credentials, fragments, or braces. Models cannot contain interpolation braces. Keys must be 1–4096 printable ASCII bytes without whitespace. Avoid secrets in URL queries: the actual endpoint receives the query, although recorded provider identities remove it.

## Delivery and wire formats

| Adapter | Required endpoint/protocol | Delivery | TUI |
| --- | --- | --- | --- |
| Claude | Anthropic Messages; base URL at host root | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, selected model, and inline model-picker settings | Yes |
| Codex | OpenAI Responses; normally base URL includes `/v1` | Private CODEX_HOME/config.toml with an environment-key reference; no operator auth.json | Refused |
| OpenCode | OpenAI-compatible provider | Per-run OPENCODE_CONFIG file with environment-key reference | Refused |
| Aider | OpenAI-compatible provider | OPENAI_API_BASE/OPENAI_API_KEY; litellm `openai/` model prefix | Yes |
| Kimi | Supported Kimi model endpoint | KIMI_MODEL_* environment group | Yes |
| Droid | BYOK provider | Private settings file with customModels entry and environment-key reference | Refused |
| Pi | OpenAI-compatible provider | Private PI_CODING_AGENT_DIR/models.json with environment-key reference | Refused |
| Goose | Built-in OpenAI provider | GOOSE_PROVIDER, OPENAI_HOST, OPENAI_BASE_PATH, OPENAI_API_KEY, GOOSE_MODEL | Yes |
| OpenHands | OpenAI-compatible provider | LLM_BASE_URL/LLM_API_KEY/LLM_MODEL through `--override-with-envs`; litellm prefix | Yes |

Z.AI, Antigravity, Cursor, Copilot, Gemini, Cline, and Qwen do not support this override group. Z.AI is its own fixed gateway adapter, not a configurable provider override.

The override survives supported hermetic modes because codemux explicitly supplies it. Session-capable adapters use the same delivery mechanisms for session spawns; Codex session homes persist for resume. TUI supports the listed environment mappings, and **Claude additionally receives inline `--settings` JSON**. It is not environment-only delivery.

## Claude details

Claude Code appends `/v1/messages` to the base URL itself, so codemux strips one trailing `/v1` from `CODEMUX_CLAUDE_PROVIDER_BASE_URL`: the OpenAI-style `http://host:port/v1` form every other override takes and the host root `http://host:port` both work. Any other path, such as a gateway's `/api/anthropic`, is kept as given. The endpoint must serve the Anthropic Messages API; a chat-completions endpoint alone is insufficient. Claude Code asks for 64000 output tokens by default; an endpoint whose context window is smaller (vLLM answers `max_completion_tokens=64000 cannot be greater than max_model_len`) needs `CODEMUX_CLAUDE_PROVIDER_MAX_OUTPUT_TOKENS` set below that window, which codemux passes as `CLAUDE_CODE_MAX_OUTPUT_TOKENS`. Claude Code 2.1.280's default prompt with its full tool set is at least 31,745 input tokens (measured live against vLLM, which then answers `This model's maximum context length is 32768 tokens`), so a 32k endpoint cannot host a full-tools run at any output cap; `--hermetic --tools none` fits (a few thousand tokens), and larger windows host the full set. Claude Code retries such 500s until the run's timeout, so an oversized prompt surfaces as `agent timed out`.

Codemux passes an inline `modelPicker` entry mapping the effective model to `behavesAs: "claude-sonnet-5"`. This supplies client-side catalog behavior without changing the model ID sent to the endpoint. The JSON rides argv and contains model settings, not the provider key. Run, TUI, and session all carry it. Retained Claude 2.1.280 evidence confirms that `--safe-mode` still honors this explicit settings argument.

When the override's MODEL variable is set, codemux pins Claude's haiku, small-fast, sonnet, and opus environment defaults to it. With only `--model`, those background defaults stay Claude's own. Plain runs still load user settings, whose `env` entries can compete with endpoint settings. Hermetic safe mode suppresses operator settings, but managed settings remain.

The endpoint must accept Claude's actual request shape, including system-role messages used by the recorded 2.1.2xx client. The retained vLLM 0.12 shim rejected those messages even though it implemented Messages. API-name compatibility alone does not establish wire compatibility.

The override uses its own token and removes ambient Claude API/OAuth credentials. It skips credential copying, but the [reachable refresh-token mirror guard](authentication.md) remains.

## Codex details

The generated config selects `wire_api = "responses"` and an environment-key reference. The key is not written into config or argv. The private home does not load the operator's config, profiles, MCP configuration, or hooks from that config. A hermetic override retains the other hermetic restrictions while reading codemux's generated config.

`CODEMUX_CODEX_PROVIDER_MULTI_AGENT=off` writes `features.multi_agent = false`. This avoids grouped namespace tools on endpoints that cannot accept them and prevents Codex subagents. `on` is the default and writes no setting. Only `on`/`off` are accepted; a nonblank value requires an override.

`CODEMUX_CODEX_PROVIDER_STORE` is refused for any nonblank value. The recorded 0.159.3/0.160.1 clients have no supported storage config knob and already send `store: false`; codemux does not pretend to configure it. These observed wire details are version-specific, not guarantees about every future Codex.

## Token limits

Set positive integer values in `CODEMUX_<AGENT>_PROVIDER_MAX_OUTPUT_TOKENS` and/or `CODEMUX_<AGENT>_PROVIDER_MAX_CONTEXT_TOKENS`. A limit without an override is refused.

After trimming, limits accept decimal digits only and must be safe integers
from 1 through 9007199254740991. Signs, fractions, and exponent notation fail.

| Harness | Output limit | Context limit |
| --- | --- | --- |
| Claude | CLAUDE_CODE_MAX_OUTPUT_TOKENS | Refused |
| Codex | Refused | model_context_window |
| OpenCode | limit.output | limit.context; both limits required together |
| Aider | Refused | Refused |
| Kimi | KIMI_MODEL_MAX_COMPLETION_TOKENS | KIMI_MODEL_MAX_CONTEXT_SIZE |
| Droid | maxOutputTokens | Refused |
| Pi | maxTokens | contextWindow |
| Goose, OpenHands | Refused | Refused |

These configure the harness's budget or context assumption. They do not guarantee that every endpoint accepts the requested size.

## Credential exposure

Generated files contain key references rather than literal keys for Codex, OpenCode, Droid, and Pi. Files/directories are private to the launch lifecycle, not a security boundary against other processes owned by the same user.

The harness receives the provider key in its environment. Whether tool subprocesses inherit it depends on that harness. OpenHands' recorded terminal implementations inherit `LLM_API_KEY`; codemux warns because a model-run command can read it. Use credentials scoped to the endpoint and revocable after an experiment.

Scode's environment scrub removes credential-shaped ambient names. Codemux exempts its injected names only when scrubbing is enabled through codemux's own options. A scrubbed launch relying on an injected credential requires `--keep-env` support, introduced in scode 0.6.0. See the [conditional requirement table](autonomy-and-sandboxing.md#conditional-scode-requirements).

Sources: [validation](../src/provider-override.ts), [Claude family](../src/claude-family.ts), [Codex config](../src/codex-provider.ts), [OpenCode config](../src/opencode-provider.ts), [Droid config](../src/droid-provider.ts), [Pi config](../src/pi-provider.ts), and the [adapters](../src/adapters/).
