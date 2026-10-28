export const CLAUDE_ENVELOPE =
  '{"type":"result","subtype":"success","session_id":"8f14e45f-ea75-4c8f-9d0b-4bba9c9b1b1b",' +
  '"result":"OK","usage":{"input_tokens":24114,"output_tokens":98,' +
  '"cache_read_input_tokens":300,"cache_creation_input_tokens":20},' +
  '"total_cost_usd":0.12735,"modelUsage":{"claude-opus-5":{}}}';

export const CODEX_EVENTS = [
  '{"type":"thread.started","thread_id":"0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"the reply"}}',
  '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":600,' +
    '"cache_write_input_tokens":200,"output_tokens":50,"reasoning_output_tokens":10}}',
].join("\n");

export const claudeVersionPreamble =
  'if [ "$1" = --version ]; then printf "2.1.280\\n"; exit 0; fi\n';
export const codexVersionPreamble =
  'if [ "$1" = --version ]; then printf "codex-cli 0.159.3\\n"; exit 0; fi\n';
