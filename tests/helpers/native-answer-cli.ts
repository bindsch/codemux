/** CLI policy fixtures report their observations as native assistant text.
 * Parser/error fixtures must use cli.ts directly to preserve malformed output. */
import { createRunFakeBinaryEnv, READS_PROMPT } from "./cli.js";

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export function createAnswerFakeBinaryEnv(binaries: Record<string, string>, scodeVersion?: string) {
  const wrapped: Record<string, string> = {};
  for (const [name, body] of Object.entries(binaries)) {
    if (!["claude", "codex", "openhands", "goose", "agent", "cursor-agent", "cursor", "kimi", "gemini", "qwen"].includes(name) &&
        !(name === "scode" && !/\bexec\b/.test(body))) {
      wrapped[name] = body; continue;
    }
    const readsStdin = /\bcat\b|\bread\b|\bhead\b|\/dev\/stdin|\bdd\b/.test(body);
    const script = `
      const args = process.argv.slice(1);
      const child = Bun.spawn(["/bin/sh", "-c", ${JSON.stringify(readsStdin ? body : READS_PROMPT + body)}, "fixture", ...args],
        { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
      const text = await new Response(child.stdout).text();
      const code = await child.exited;
      const headless = args.some(a => a === "--json" || a === "--output-format" || a.startsWith("--output-format="));
      let native = false;
      try { native = typeof JSON.parse(text.trim()) === "object"; } catch {}
      const name = ${JSON.stringify(name)};
      if (code !== 0 || !headless || !text.trim() || native) process.stdout.write(text);
      else if (name === "goose") {
        console.log(JSON.stringify({type:"message", message:{role:"assistant",content:text}}));
        console.log(JSON.stringify({type:"complete"}));
      }
      else if (name === "gemini") console.log(JSON.stringify({response:text, stats:{}}));
      else if (name === "codex") {
        for (const event of [{type:"thread.started", thread_id:"0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e"},
          {type:"turn.started"}, {type:"item.completed", item:{id:"answer",type:"agent_message",text:text.trimEnd()}},
          {type:"turn.completed",usage:{input_tokens:0,cached_input_tokens:0,output_tokens:0}}]) console.log(JSON.stringify(event));
      }
      else if (name === "openhands") console.log(JSON.stringify({kind:"MessageEvent",source:"agent",llm_message:{content:text.trimEnd()}}));
      else if (name === "kimi") process.stdout.write("• " + text.trimEnd().replaceAll("\\n", "\\n  ") + "\\n");
      else console.log(JSON.stringify({type:"result", subtype:"success", is_error:false, result:text.trimEnd()}));
      process.exit(code);`;
    // cat makes the normal fixture wrapper leave stdin for this child.
    wrapped[name] = `# stdin is inherited, like cat\n${quote(process.execPath)} -e ${quote(script)} -- "$@"`;
  }
  return createRunFakeBinaryEnv(wrapped, scodeVersion);
}
