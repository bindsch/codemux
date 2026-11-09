/** Native rule fixture pinned to Kimi 2.5.2's bundled
 * agent-core-v2/src/agent/permissionRules/matchesRule.ts:
 * `if (openIdx === -1) return { toolName: trimmed };`
 * `if (parsed.toolName !== "*" && !import_picomatch.default.isMatch(toolName, parsed.toolName)) return;`
 * `if (parsed.argPattern === void 0) return {` then `strategy: "tool_name_only"`.
 * This fixture implements only tool-name-only patterns used by these tests.
 * It models policy application; it does not verify a live harness run.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Writer = (value: Record<string, unknown>) => void;
type Rule = { decision?: string; scope?: string; pattern?: string; tool?: string };

export function runKimiPermissionTools(write: Writer): void {
  const config = Bun.TOML.parse(readFileSync(join(process.env.KIMI_CODE_HOME!, "config.toml"), "utf8")) as Record<string, unknown>;
  const permission = config.permission as { rules?: Rule[] } | undefined;
  const rules = permission?.rules ?? [];
  const tools = ["Bash", "Write", "Edit", "Read", "mcp__fixture__write"];
  for (const [index, name] of tools.entries()) {
    const id = `policy_${index}`;
    const command = "printf allowed > permission-bash.txt";
    const input = name === "Bash" ? { command } : { file_path: `permission-${name.toLowerCase()}.txt` };
    write({ role: "assistant", tool_calls: [{
      type: "function", id, function: { name, arguments: JSON.stringify(input) },
    }] });
    // user-configured-deny runs before auto-mode-approve. User allow rules
    // therefore cannot override the generated deny, regardless of ordering.
    const denied = rules.some((rule) => rule.decision === "deny" && rule.tool === undefined &&
      [undefined, "user", "project", "turn-override"].includes(rule.scope) &&
      (rule.pattern === "*" || rule.pattern === name));
    if (!denied) {
      if (name === "Bash") {
        const child = Bun.spawnSync(["/bin/sh", "-c", command], { cwd: process.cwd() });
        if (child.exitCode !== 0) throw new Error("fake shell write failed");
      } else if (name !== "Read") {
        writeFileSync(`permission-${name.toLowerCase()}.txt`, "allowed");
      }
    }
    write({ role: "tool", tool_call_id: id,
      content: denied ? `Tool "${name}" was denied by permission rule.` : "allowed" });
  }
  write({ role: "assistant", content: "Finished native permission fixture." });
}
