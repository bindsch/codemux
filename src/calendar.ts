/**
 * Calendar-date validation for timestamp strings that reach recorded
 * evidence. Date.parse normalizes a nonexistent date (2026-02-30 reads as
 * March 2), so any code that records a parsed timestamp under its own
 * clock must reject what JavaScript silently normalizes (review rounds 59
 * and 64).
 */

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
