/** Extra observations from the synthetic Aider process, never a real harness. */
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const settingsIndex = args.indexOf("--model-settings-file");
const settingsPath = settingsIndex === -1 ? null : args[settingsIndex + 1]!;
const state = process.env.FAKE_STATE_DIR!;
const record = (name: string, value: unknown) =>
  appendFileSync(join(state, name), JSON.stringify(value) + "\n");

record("parity.jsonl", {
  args,
  yesAlways: process.env.AIDER_YES_ALWAYS ?? null,
  settingsPath,
  settings: settingsPath === null ? null : JSON.parse(readFileSync(settingsPath, "utf8")),
  settingsMode: settingsPath === null ? null : statSync(settingsPath).mode & 0o777,
});
process.stdin.once("data", (chunk: Buffer | string) => {
  record("declines.jsonl", { input: chunk.toString() });
});
