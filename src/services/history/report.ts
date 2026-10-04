import { HistoryQuery } from "./query.js";
import { formatWarsaw } from "./time.js";

export const REPORT_MIN_MESSAGES = 20;

const MONTH_NAMES = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"];
const BAR_WIDTH = 12;
const BAR_CHAR = "█";

export interface ReportMonth {
    /** "YYYY-MM" */
    key: string;
    /** "wrzesień 2026" */
    label: string;
    /** First and last day of the month, "YYYY-MM-DD" (Warsaw time). */
    from: string;
    to: string;
}

export interface Counted {
    name: string;
    count: number;
}

export interface MonthlyReportData {
    month: ReportMonth;
    total: number;
    authors: Counted[];
    loudestDays: Counted[];
    hours: Counted[];
    weekdays: Counted[];
    channels: Counted[];
    words: Counted[];
    pairs: Counted[];
}

const two = (n: number) => String(n).padStart(2, "0");

export const monthOf = (year: number, month: number): ReportMonth => {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return {
        key: `${year}-${two(month)}`,
        label: `${MONTH_NAMES[month - 1]} ${year}`,
        from: `${year}-${two(month)}-01`,
        to: `${year}-${two(month)}-${two(lastDay)}`,
    };
};

/** The calendar month before the one `now` falls in (Warsaw time). */
export const previousMonth = (now: number): ReportMonth => {
    const [year, month] = formatWarsaw(now).split(/[. ]/).map(Number);
    return month === 1 ? monthOf(year - 1, 12) : monthOf(year, month - 1);
};

/** "YYYY-MM" → ReportMonth, or null when it is not a valid month. */
export const parseMonthKey = (text: string): ReportMonth | null => {
    const m = text.trim().match(/^(\d{4})-(\d{2})$/);
    if (!m || +m[2] < 1 || +m[2] > 12) return null;
    return monthOf(+m[1], +m[2]);
};

/** Day of the month in Warsaw time. */
export const warsawDayOfMonth = (now: number): number => Number(formatWarsaw(now).split(/[. ]/)[2]);

/** Exact numbers for one month, computed with SQL aggregates and word counting — nothing here is written by the model. */
export const collectMonthlyReport = (query: HistoryQuery, month: ReportMonth): MonthlyReportData => {
    const range = { from: month.from, to: month.to };
    const groups = (groupBy: string, limit: number, sort?: string): { total: number; list: Counted[] } => {
        const r = query.stats({ ...range, groupBy, limit, sort });
        return { total: r.total, list: r.groups.map(g => ({ name: g.key, count: g.count })) };
    };
    const authors = groups("author", 5);
    const phrases = query.phrases({ ...range, words: 10, pairs: 5 });
    return {
        month,
        total: authors.total,
        authors: authors.list,
        loudestDays: groups("day", 3, "count").list,
        hours: groups("hour", 24, "key").list,
        weekdays: groups("weekday", 7, "key").list,
        channels: groups("channel", 3).list,
        words: phrases.words.map(w => ({ name: w.phrase, count: w.count })),
        pairs: phrases.pairs.map(w => ({ name: w.phrase, count: w.count })),
    };
};

const topOf = (items: Counted[]): Counted | undefined => items.reduce<Counted | undefined>((best, x) => (!best || x.count > best.count ? x : best), undefined);

const bars = (items: Counted[]): string => {
    const max = Math.max(...items.map(i => i.count));
    const nameWidth = Math.max(...items.map(i => [...i.name].length));
    return items
        .map(i => `${i.name}${" ".repeat(nameWidth - [...i.name].length)} ${BAR_CHAR.repeat(Math.max(1, Math.round((i.count / max) * BAR_WIDTH)))} ${i.count}`)
        .join("\n");
};

const shortDay = (day: string): string => {
    const [, m, d] = day.split("-");
    return `${d}.${m}`;
};

/** Facts for the model: it comments on them, but the numbers shown to people come from `renderReportBlock`. */
export const reportFacts = (data: MonthlyReportData): string => {
    const hour = topOf(data.hours);
    const weekday = topOf(data.weekdays);
    return [
        `Miesiąc: ${data.month.label}`,
        `Najaktywniejsi (liczba wiadomości): ${data.authors.map(a => `${a.name} ${a.count}`).join(", ") || "brak"}`,
        `Najgłośniejsze dni: ${data.loudestDays.map(d => `${shortDay(d.name)} (${d.count})`).join(", ") || "brak"}`,
        `Najruchliwsza godzina: ${hour ? `${hour.name} (${hour.count})` : "brak"}`,
        `Najruchliwszy dzień tygodnia: ${weekday ? `${weekday.name} (${weekday.count})` : "brak"}`,
        `Najpopularniejsze kanały: ${data.channels.map(c => `${c.name} (${c.count})`).join(", ") || "brak"}`,
        `Najczęstsze słowa: ${data.words.map(w => `${w.name} (${w.count})`).join(", ") || "brak"}`,
        `Najczęstsze pary słów: ${data.pairs.map(w => `${w.name} (${w.count})`).join(", ") || "brak"}`,
    ].join("\n");
};

/** The numeric part of the report: bar charts in code blocks, built from the data only. */
export const renderReportBlock = (data: MonthlyReportData): string => {
    const sections: string[] = [];
    const block = (title: string, body: string) => sections.push(`**${title}**\n\`\`\`\n${body}\n\`\`\``);

    if (data.authors.length) block("Najaktywniejsi", bars(data.authors));
    if (data.loudestDays.length) block("Najgłośniejsze dni", bars(data.loudestDays.map(d => ({ name: shortDay(d.name), count: d.count }))));

    const hour = topOf(data.hours);
    const weekday = topOf(data.weekdays);
    const habits: string[] = [];
    if (hour) habits.push(`Najwięcej pisania w godzinie ${hour.name} (wiadomości: ${hour.count}).`);
    if (weekday) habits.push(`Najgadatliwszy dzień tygodnia: ${weekday.name} (${weekday.count}).`);
    if (habits.length) sections.push(`**Rytm serwera**\n${habits.join("\n")}`);

    if (data.channels.length) block("Kanały", bars(data.channels));
    if (data.words.length) block("Najczęstsze słowa", bars(data.words.slice(0, 8)));
    if (data.pairs.length) sections.push(`**Najczęstsze zwroty**\n${data.pairs.map(p => `„${p.name}” ×${p.count}`).join(" · ")}`);

    return sections.join("\n\n");
};
