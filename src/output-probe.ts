import { stripVTControlCharacters } from "node:util";
import { runCapturedCommand, type CapturedCommandOptions } from "./process-runner.js";

export type ProbeAnswer = (output: string) => boolean;

/** Only newline-terminated records can prove completion before EOF. Never
 * let a chunk boundary turn a prerelease or a model ID into a shorter one. */
export function completeLines(output: string): string {
  return output.slice(0, output.lastIndexOf("\n") + 1);
}

export const versionAnswer = (pattern: RegExp): ProbeAnswer => (output) => {
  pattern.lastIndex = 0;
  return pattern.exec(output.trim())?.[1] !== undefined;
};

/** A capability query is answered once every requested token is printed.
 * A missing token still needs a clean exit; a truncated help page cannot
 * establish absence. Callers retain their own required-token assertions. */
export const helpAnswer = (required: readonly string[]): ProbeAnswer => (output) =>
  required.length > 0 && required.every((token) => output.includes(token));

/** Cursor prints this footer after the entire model table. Rows alone do
 * not prove completion, and authentication errors are never a success. */
export const cursorModelsAnswer: ProbeAnswer = (output) => {
  const plain = stripVTControlCharacters(output);
  return /^Available models\s*$/m.test(plain) &&
    /^Tip: use --model <id> .* to switch\.[^\n]*\n/m.test(plain);
};

/** Preserve natural exits and capture limits. At the configured deadline,
 * complete stdout may succeed if the leader still runs; terminate its tree
 * through the runner's usual TERM/KILL path. Without a format marker, both
 * streams must reach EOF and stdout must be nonempty; silence is not EOF. */
export function runOutputProbe(
  command: string[],
  options: Omit<CapturedCommandOptions, "stdoutSink" | "outputComplete" | "stdinInput" | "stdinRepeats">,
  answer?: ProbeAnswer
) {
  const output = { stdout: "", stderr: "" };
  const ended = { stdout: false, stderr: false };
  return runCapturedCommand(command, {
    ...options,
    outputComplete: (stream, text, done) => {
      output[stream] = text;
      ended[stream] = done;
      if (answer) return answer(ended.stdout ? output.stdout : completeLines(output.stdout));
      return ended.stdout && ended.stderr && Boolean(output.stdout.trim());
    },
  });
}
