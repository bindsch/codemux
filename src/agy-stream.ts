/** Native evidence shared by text-only enforcement and the live canaries. */
export function summarizeAgyStream(stdout: string) {
  let tools: unknown = null;
  let init: unknown = null;
  let response = "";
  let status = "";
  let malformed = false;
  let resultCount = 0;
  const deniedActions = new Set<string>();
  const commandOutputs: string[] = [];
  const commandAttempts = new Set<string>();
  const toolAttempts = new Set<string>();
  const deniedCommands = new Set<string>();
  let toolExecuted = false;
  let nonCommandAttempt = false;
  let resultCommandDenials = 0;
  let anonymousStep = 0;
  const commandActions = new Set(["command", "unsandboxed", "run_command"]);
  const stepTypes = new Set<string>();
  const textSteps = new Set(["user_input", "agent_response"]);
  for (const line of stdout.split("\n").filter((line) => line.trim())) {
    try {
      const frame = JSON.parse(line);
      if (!frame || typeof frame !== "object" || resultCount) { malformed = true; continue; }
      if (frame.event === "init") {
        if (init !== null || !frame.init || typeof frame.init !== "object" || Array.isArray(frame.init)) malformed = true;
        init = frame.init;
        tools = frame.init?.tools ?? null;
      } else if (frame.event === "step_update") {
        if (typeof frame.step_update?.step_type !== "string") malformed = true;
        else {
          stepTypes.add(frame.step_update.step_type);
          const step = frame.step_update;
          const message = step.tool_info?.error?.message;
          const denied = step.state === "ERROR" && typeof message === "string"
            ? /Permission denied for ([a-z_]+)\(/.exec(message)?.[1] : undefined;
          const command = commandActions.has(step.step_type) ||
            (step.step_type === "tool" && (commandActions.has(step.tool_name ?? step.tool_info?.name) ||
              commandActions.has(denied ?? "")));
          if (!textSteps.has(step.step_type)) {
            // Updates with the same native step index describe one attempt.
            // Without an index, separate events cannot prove the same attempt.
            const id = Number.isInteger(step.step_index)
              ? JSON.stringify([step.conversation_id ?? frame.conversation_id ?? "", step.step_index])
              : `anonymous-${anonymousStep++}`;
            toolAttempts.add(id);
            if (!command) nonCommandAttempt = true;
            if (command) commandAttempts.add(id);
            if (step.state === "DONE" || step.tool_info?.output !== undefined) toolExecuted = true;
            if (command && step.state === "ERROR" && typeof message === "string" && /permission denied/i.test(message)) {
              deniedCommands.add(id);
            }
          }
          if (command && step.state === "DONE" && !step.tool_info?.error && typeof step.tool_info?.output === "string") {
            commandOutputs.push(step.tool_info.output);
          }
          // A user-configured deny rule reports the refusal on the tool step
          // itself ("Permission denied for unsandboxed(...)"), not in the
          // result's denied_actions, which only headless auto-denials fill.
          if ((step.step_type === "tool" || command) && step.state === "ERROR"
              && typeof message === "string") {
            if (denied) deniedActions.add(denied);
            else if (/permission denied/i.test(message)) deniedActions.add(command ? "run_command" : "unknown denied action");
          }
        }
      } else if (frame.event === "result") {
        resultCount++;
        response = typeof frame.result?.response === "string" ? frame.result.response : "";
        status = typeof frame.result?.status === "string" ? frame.result.status : "";
        const denied = frame.result?.denied_actions;
        if (denied !== undefined && !Array.isArray(denied)) malformed = true;
        for (const action of Array.isArray(denied) ? denied : []) {
          deniedActions.add(typeof action?.action === "string" ? action.action : "unknown denied action");
          if (commandActions.has(action?.action)) resultCommandDenials++;
        }
      } else malformed = true;
    } catch { malformed = true; }
  }
  const attemptedActions = [...new Set([
    ...[...stepTypes].filter((step) => !textSteps.has(step)), ...deniedActions,
  ])];
  const onlyDeniedCommand = !toolExecuted && !nonCommandAttempt && toolAttempts.size === commandAttempts.size && resultCommandDenials <= 1 &&
    (commandAttempts.size === 1 ? deniedCommands.size === 1 || resultCommandDenials === 1 :
      commandAttempts.size === 0 && resultCommandDenials === 1);
  return { tools, init, response, status, commandOutputs, onlyDeniedCommand, stepTypes: [...stepTypes], deniedActions: [...deniedActions],
    attemptedActions, possibleToolActivity: attemptedActions.length > 0,
    malformed: malformed || init === null || init === undefined || resultCount !== 1 };
}
