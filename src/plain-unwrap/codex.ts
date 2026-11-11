/** The codex plain-run escape hatch: the blended `tokens used` figure human
 * mode prints on stderr, recorded as the run's usage. src/plain-unwrap.ts
 * owns the public surface and the module overview. */
import { emptyUsage } from "../result-envelope.js";
import type { RunResult } from "../types.js";

// Codex's human exec mode prints its token figure on stderr as two lines
// after the run — "tokens used", then the total with locale digit
// separators (print_final_output, codex-rs's human event processor). The
// label is styled when the terminal supports it, so escape codes are
// stripped before matching; the scan runs from the end so harness chatter
// containing the phrase cannot shadow the real one. The number is blended:
// (input − cached) + output, which cannot be split back apart, so it lands
// in total_tokens alone.
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g;
// Locale digit separators the formatter can emit: comma, period,
// apostrophe (the right single quote in some locales), and the space-like
// characters — space, no-break space, and narrow no-break space.
const SEPARATOR_CLASS = "[.,'’\\u00a0\\u202f ]";
// One figure after the label, in one of three shapes a locale formatter
// emits, each with the SAME single separator throughout:
// - plain digits;
// - groups of three: one to three digits, then groups of exactly three
//   (`1,234,567`);
// - Indian grouping: one or two digits, then groups of two, then a last
//   group of three (`12,34,567`; review round 125).
// Anything else — a decimal fraction, doubled or mixed separators, a group
// of the wrong size, a leading or trailing separator — is not a figure
// codemux can read: rejected whole, never digit-stripped into a wrong
// total (review round 123).
const SEPARATED_FIGURE = new RegExp(
  "^(?:\\d+" +
    `|\\d{1,3}(${SEPARATOR_CLASS})\\d{3}(?:\\1\\d{3})*` +
    `|\\d{1,2}(${SEPARATOR_CLASS})(?:\\d{2}\\2)*\\d{3}` +
    ")$"
);

/**
 * Extracts codex's token total from a plain run's captured stderr, or null
 * when the figure is absent or is not a plain or properly grouped digit
 * figure (then no usage is recorded).
 */
export function parseCodexTokenTotal(stderr: string): number | null {
  const lines = stderr.replace(ANSI_ESCAPE, "").split(/\r?\n/);
  let label = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() === "tokens used") {
      label = i;
      break;
    }
  }
  if (label === -1) return null;
  for (let j = label + 1; j < lines.length; j++) {
    const line = lines[j]!.trim();
    if (line === "") continue;
    if (!SEPARATED_FIGURE.test(line)) return null;
    const value = Number(line.replace(/\D/g, ""));
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  return null;
}

/**
 * codex, escape-hatch shape: a plain run now launches `--json` and streams
 * through CodexPlainFold below, so this function is what a hatch run — a
 * binary that ignored the flag and printed human mode anyway — gets. Its
 * stdout passes through verbatim exactly as plain runs always did, and the
 * one blended `tokens used` figure human mode reports on stderr becomes
 * the run's usage, total_tokens alone with every other field null, because
 * it is (input − cached) + output and the parts cannot be recovered. A
 * stderr without the figure records no usage.
 */
export function codexPlainResult(result: RunResult): RunResult {
  result = { ...result, reply: "" };
  const total = parseCodexTokenTotal(result.stderr);
  if (total === null) return result;
  return {
    ...result,
    usage: { ...emptyUsage(), total_tokens: total },
    servedModel: null,
  };
}
