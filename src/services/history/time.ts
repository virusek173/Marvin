export const WARSAW_TZ = "Europe/Warsaw";

const partsFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: WARSAW_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
});

const warsawParts = (ms: number) => {
    const p = Object.fromEntries(partsFormatter.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute };
};

/** "YYYY.MM.DD HH:MM" in Warsaw time, regardless of the process timezone. */
export const formatWarsaw = (ms: number): string => {
    const p = warsawParts(ms);
    const two = (n: number) => String(n).padStart(2, "0");
    return `${p.year}.${two(p.month)}.${two(p.day)} ${two(p.hour)}:${two(p.minute)}`;
};

const warsawOffsetMs = (ms: number): number => {
    const p = warsawParts(ms);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60000) * 60000;
};

/**
 * Parses "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" (also with a space) as Warsaw local time into UTC milliseconds.
 * A date without a time resolves to the start of that day; with `endOfDay` to the start of the next day,
 * so a [from, to) range with date-only bounds covers whole days. Returns null when the text is not a valid date.
 */
export const parseWarsaw = (text: string, endOfDay = false): number | null => {
    const m = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/);
    if (!m) return null;
    const [year, month, day] = [+m[1], +m[2], +m[3]];
    const hasTime = m[4] !== undefined;
    const naive = Date.UTC(year, month - 1, day, hasTime ? +m[4] : 0, hasTime ? +m[5] : 0);
    const check = new Date(naive);
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    if (hasTime && (+m[4] > 23 || +m[5] > 59)) return null;
    const shifted = naive + (endOfDay && !hasTime ? 86_400_000 : 0);
    let utc = shifted - warsawOffsetMs(shifted);
    utc = shifted - warsawOffsetMs(utc);
    return utc;
};
