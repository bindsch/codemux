import { calendarValid } from "./calendar.js";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Validate the calendar fields before Date can normalize them. Keep the
 * legacy English and numeric date spellings alongside ISO cutoffs. */
export function parseCutoffDate(value: string): Date | null {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  let fields: string[] | undefined;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?=$|[T\s])/.exec(value);
  const numeric = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?=$|\s)/.exec(value);
  const monthFirst = /\b([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/.exec(value);
  const dayFirst = /\b(\d{1,2})[ -]([A-Za-z]+)[ -](\d{4})\b/.exec(value);
  if (iso) fields = [iso[1]!, iso[2]!, iso[3]!];
  else if (numeric) fields = [numeric[3]!, numeric[1]!, numeric[2]!];
  else if (monthFirst || dayFirst) {
    const match = (monthFirst ?? dayFirst)!;
    const month = MONTHS.indexOf(match[monthFirst ? 1 : 2]!.slice(0, 3).toLowerCase()) + 1;
    fields = [match[3]!, String(month), match[monthFirst ? 2 : 1]!];
  }
  if (!fields) return null;
  const date = fields.map((field, index) => field.padStart(index === 0 ? 4 : 2, "0")).join("-");
  const clock = /(?:T|\s)(\d{2}:\d{2})(?::(\d{2}))?/.exec(value);
  return calendarValid(`${date}T${clock ? `${clock[1]}:${clock[2] ?? "00"}` : "00:00:00"}`) ? parsed : null;
}
