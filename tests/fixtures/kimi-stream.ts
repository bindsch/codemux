export const KIMI_STREAM_SESSION = "session_12345678-1234-1234-1234-123456789abc";

export function kimiResumeHint(sessionId = KIMI_STREAM_SESSION) {
  return { role: "meta", type: "session.resume_hint", session_id: sessionId,
    command: `kimi -r ${sessionId}`, content: `To resume this session: kimi -r ${sessionId}` };
}

export function kimiAssistantCall(id: string, name: string, input: unknown) {
  return { role: "assistant", tool_calls: [{ type: "function", id,
    function: { name, arguments: JSON.stringify(input) } }] };
}
