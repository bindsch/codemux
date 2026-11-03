// Locale-digit machinery for spill messages: how this runtime's locales
// print counts, so a message's digits can be read whatever script printed
// them. src/experiment-spill.ts owns the spill comparison; this module
// holds only the number-format reading.
// Unicode encodes every decimal-digit set (Nd) as a complete, ordered run of
// ten code points, so a digit's value is its position within the run of
// consecutive Nd code points it belongs to, modulo ten.
let digitValues: Map<number, number> | undefined;
function digitValue(codePoint: number): number | undefined {
  if (!digitValues) {
    digitValues = new Map();
    let run = 0;
    for (let cp = 0; cp <= 0x1ffff; cp++) {
      if (/\p{Nd}/u.test(String.fromCodePoint(cp))) digitValues.set(cp, run++ % 10);
      else run = 0;
    }
  }
  return digitValues.get(codePoint);
}
// A count is digits, or digits grouped by a locale's mark in a locale's
// shape: groups of three, or the Indian shape of a final group of three
// behind groups of two; no leading zero. Which marks, shapes, numeral sets,
// and minimum groupings go together is not written down here: it is read
// from this runtime's own locale data, once per process, as the set of
// locale signatures below, and a message's counts must all fit one of them.
export type GroupingStyle = "western" | "indian";
export type LocaleSignature = { mark: string; style: GroupingStyle; ungroupedMax: number; zero: number };
let signatures: LocaleSignature[] | undefined;
/** The number formats this runtime's locales print: grouping mark, grouping
 * style, the longest integer left ungrouped, and the numeral set's zero. */
export function localeSignatures(): LocaleSignature[] {
  if (signatures) return signatures;
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const bases: string[] = [];
  for (const a of letters) for (const b of letters) { bases.push(a + b); for (const c of letters) bases.push(a + b + c); }
  // Scripts that change a language's digits or marks (Adlam, Arabic, N'Ko,
  // ...), and regions that change its grouping.
  const scripts = ["Adlm", "Arab", "Latn", "Cyrl", "Deva", "Hans", "Hant", "Beng", "Tfng", "Vaii", "Mong", "Guru", "Thaa", "Olck", "Mtei", "Rohg",
    "Nkoo", "Hebr", "Grek", "Ethi", "Khmr", "Mymr", "Tibt", "Taml", "Telu", "Knda", "Mlym", "Sinh", "Thai", "Laoo", "Cakm", "Java", "Hmnp", "Yiii", "Cher", "Orya", "Gujr"];
  // A script variant counts only where it prints differently from its base:
  // the runtime resolves an unknown script tag to the base, so the base's
  // signature already covers it.
  const differing = (base: string) => scripts.map((script) => `${base}-${script}`)
    .filter((code) => { try { return (1234567).toLocaleString(code) !== (1234567).toLocaleString(base); } catch { return false; } });
  const codes = Intl.NumberFormat.supportedLocalesOf(bases).flatMap((base) => [base, ...differing(base)]);
  codes.push("en-IN", "hi-IN", "bn-IN", "ta-IN", "te-IN", "mr-IN", "gu-IN", "kn-IN", "ml-IN", "pa-IN", "de-CH", "fr-CH", "it-CH", "de-AT",
    "es-MX", "es-US", "es-419", "pt-PT", "pt-BR", "fr-CA", "en-ZA", "en-CA", "en-GB", "en-AU", "ar-EG", "ar-SA", "ar-MA", "fa-IR", "ur-PK",
    "zh-CN", "zh-TW", "ja-JP", "ko-KR", "ru-RU", "uk-UA", "tr-TR", "nl-BE", "nl-NL", "sv-SE", "nb-NO", "da-DK", "fi-FI", "pl-PL", "cs-CZ",
    "hu-HU", "el-GR", "he-IL", "en-US");
  const seen = new Set<string>();
  const found: LocaleSignature[] = [];
  const probes = [1000, 10000, 100000, 1000000, 10000000];
  for (const code of codes) {
    const printed = probes.map((n) => n.toLocaleString(code));
    const marks = new Set(printed.flatMap((text) => [...text].filter((char) => digitValue(char.codePointAt(0)!) === undefined)));
    if (marks.size !== 1) continue;
    const mark = [...marks][0]!;
    let ungroupedMax = 3;
    probes.forEach((n, index) => { if (!printed[index]!.includes(mark)) ungroupedMax = Math.max(ungroupedMax, String(n).length); });
    const groups = (123456789).toLocaleString(code).split(mark).map((group) => [...group].length);
    const style: GroupingStyle = groups.length > 2 && groups.slice(1, -1).every((length) => length === 2) && groups.at(-1) === 3 ? "indian" : "western";
    const zero = (0).toLocaleString(code).codePointAt(0)!;
    const key = `${mark}|${style}|${ungroupedMax}|${zero}`;
    if (!seen.has(key)) { seen.add(key); found.push({ mark, style, ungroupedMax, zero }); }
  }
  // Claude's bundled runtime may carry another CLDR release than this one:
  // Swiss German moved from the apostrophe to the right single quotation
  // mark, and French from the no-break space to the narrow one, so each
  // signature with one of those marks also stands with its counterpart.
  const twins: Record<string, string> = { "'": "\u2019", "\u2019": "'", "\u00A0": "\u202F", "\u202F": "\u00A0" };
  for (const locale of [...found]) {
    const twin = twins[locale.mark];
    if (twin === undefined) continue;
    const key = `${twin}|${locale.style}|${locale.ungroupedMax}|${locale.zero}`;
    if (!seen.has(key)) { seen.add(key); found.push({ ...locale, mark: twin }); }
  }
  return (signatures = found);
}
/** The grouping marks the runtime's locales print, as a regular-expression class. */
export function groupMarkClass(): string {
  return `[${[...new Set(localeSignatures().map((locale) => locale.mark))].map((mark) => mark.replace(/[\]\\^-]/g, "\\$&")).join("")}]`;
}
// The count's value is returned as its ASCII digits with the numeral set's
// zero (one locale prints every count in one set): a span derived from a
// huge passed-through read limit may exceed what a number holds exactly.
export type LocalizedCount = { digits: string; zero: number; mark?: string; styles?: GroupingStyle[] };
/** A count fits a locale when its numeral set is the locale's and it is grouped exactly where the locale groups. */
export function fitsLocale(count: LocalizedCount, locale: LocaleSignature): boolean {
  if (count.zero !== locale.zero) return false;
  if (count.mark === undefined) return count.digits.length <= locale.ungroupedMax;
  return count.mark === locale.mark && count.styles!.includes(locale.style) && count.digits.length > locale.ungroupedMax;
}
export function localizedDigits(text: string): LocalizedCount | undefined {
  const chars = [...text];
  const marks = new Set(chars.filter((char) => digitValue(char.codePointAt(0)!) === undefined));
  if (marks.size > 1) return undefined;
  const mark = [...marks][0];
  if (mark !== undefined && !localeSignatures().some((locale) => locale.mark === mark)) return undefined;
  if (chars.length > 1 && digitValue(chars[0]!.codePointAt(0)!) === 0) return undefined;
  // A grouped count's shape may fit one style or both ("57,000" is Western
  // and Indian alike); the message's counts must share one.
  let styles: GroupingStyle[] | undefined;
  if (mark !== undefined) {
    const groups = text.split(mark).map((group) => [...group].length);
    if (groups.some((length) => length === 0)) return undefined;
    const western = groups[0]! <= 3 && groups.slice(1).every((length) => length === 3);
    const indian = groups.length >= 2 && groups[0]! <= 2 && groups.slice(1, -1).every((length) => length === 2) && groups.at(-1) === 3;
    if (!western && !indian) return undefined;
    styles = [...(western ? ["western" as const] : []), ...(indian ? ["indian" as const] : [])];
  }
  let digits = "";
  let zero: number | undefined;
  for (const char of chars) {
    const codePoint = char.codePointAt(0)!;
    const value = digitValue(codePoint);
    if (value === undefined) continue;
    if (zero === undefined) zero = codePoint - value;
    else if (zero !== codePoint - value) return undefined;
    digits += value;
  }
  return zero === undefined ? undefined : { digits, zero, mark, styles };
}
// toLocaleString() prints a number's shortest round-trip digits, expanded with
// zeros past 1e21 where toString() switches to an exponent.
export function plainDigits(count: number): string {
  const text = count.toString();
  const exponent = /^(\d)(?:\.(\d+))?e\+(\d+)$/.exec(text);
  if (!exponent) return text;
  const mantissa = exponent[1]! + (exponent[2] ?? "");
  return mantissa.padEnd(Number(exponent[3]) + 1, "0");
}
