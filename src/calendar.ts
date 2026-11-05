/**
 * Calendar-date validation for timestamp strings that reach recorded
 * evidence. Date.parse normalizes a nonexistent date (2026-02-30 reads as
 * March 2), so any code that records a parsed timestamp under its own
 * clock must reject what JavaScript silently normalizes (review rounds 59
 * and 64).
 */

/** A timestamp that names second 60 with that second replaced by 59, or
 * null when the seconds field is not 60. JavaScript's Date rejects a leap
 * second, so the readers below work on the second before it. */
const beforeLeapSecond = (value: string): string | null => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:)60(.*)$/.exec(value);
  return match === null ? null : `${match[1]}59${match[2]}`;
};

/** Milliseconds since the epoch for an RFC 3339 timestamp, or NaN. A leap
 * second reads as the instant one second after 23:59:59 (review round
 * 133); every other value is what Date.parse answers. */
export const timestampMs = (value: string): number => {
  const before = beforeLeapSecond(value);
  if (before === null) return Date.parse(value);
  const instant = Date.parse(before);
  return Number.isFinite(instant) ? instant + 1_000 : NaN;
};

/** The UTC dates whose last second was a leap second: every one inserted
 * since 1972 (IERS Bulletin C). None has been scheduled since 2016; one
 * announced after this list was written reads as malformed until its
 * date is added here. */
const LEAP_SECOND_DATES: ReadonlySet<string> = new Set([
  "1972-06-30", "1972-12-31", "1973-12-31", "1974-12-31", "1975-12-31", "1976-12-31", "1977-12-31",
  "1978-12-31", "1979-12-31", "1981-06-30", "1982-06-30", "1983-06-30", "1985-06-30", "1987-12-31",
  "1989-12-31", "1990-12-31", "1992-06-30", "1993-06-30", "1994-06-30", "1995-12-31", "1997-06-30",
  "1998-12-31", "2005-12-31", "2008-12-31", "2012-06-30", "2015-06-30", "2016-12-31",
]);

/** Whether `value` names a leap second that happened: the second before
 * it must be 23:59:59 UTC, whatever offset the text carries, on one of
 * the dates above. Second 60 at any other instant never existed, so it
 * is not a timestamp (review rounds 133 and 134). */
export const leapSecondValid = (value: string): boolean => {
  const before = beforeLeapSecond(value);
  if (before === null || !calendarValid(before)) return false;
  const instant = Date.parse(before);
  if (!Number.isFinite(instant)) return false;
  const utc = new Date(instant).toISOString();
  return utc.slice(11, 19) === "23:59:59" && LEAP_SECOND_DATES.has(utc.slice(0, 10));
};

/** Whether `value` names a real calendar date and time: the date and clock
 * fields must round-trip through Date.UTC exactly. The prefix shape is
 * checked first, so a timestamp without leading calendar fields answers
 * false rather than matching partially. */
export const calendarValid = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  // setUTCFullYear, not Date.UTC: Date.UTC reads years 0 to 99 as 1900 to
  // 1999 and would reject valid early timestamps (review round 61).
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day &&
    date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
};

/** The RFC 3339 timestamp shape: a calendar date, `T`, a clock time with
 * an optional fraction, and `Z` or a numeric offset. One definition for
 * every timestamp the tree reads on the wire. */
export const RFC3339_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Whether `value` is an RFC 3339 timestamp that names a real instant:
 * the shape above, a real calendar date (Date.parse normalizes a
 * nonexistent one away), and — for second 60 — a leap second that
 * happened. One rule decides timestamps in the tree (review round 151):
 * the usage protocol's fields (usage-protocol.ts requireTimestamp) and
 * the call ledger's `ts` (call-log-reader.ts) both delegate here. */
export const timestampValid = (value: string): boolean =>
  RFC3339_TIMESTAMP.test(value) &&
  (leapSecondValid(value) || (Number.isFinite(timestampMs(value)) && calendarValid(value)));
