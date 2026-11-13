// Usage: node scripts/usage-compare.mjs [file|-] <YYYY-MM-DD> [days]    (in Docker: make usage-compare SINCE=YYYY-MM-DD)
// Compares token usage before and after a change deployed on the given day (that day itself is left out, it is mixed):
// up to `days` days before (default 14) against every day after. Per kind and in total: input per call, cache share,
// uncached input per call and per day. "Input equivalent" counts a cached token as 0.1 of a normal one (OpenAI's usual
// cache discount; the code does not know the real prices), so it approximates the input cost.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const source = args[0] === "-" || (args[0] && !/^\d{4}-\d{2}-\d{2}$/.test(args[0])) ? args.shift() : process.stdin.isTTY ? "data/usage.json" : "-";
const [since, daysArg = "14"] = args;
if (!/^\d{4}-\d{2}-\d{2}$/.test(since ?? "")) {
    console.error("Podaj dzień zmiany: node scripts/usage-compare.mjs [plik|-] RRRR-MM-DD [dni]");
    process.exit(1);
}
const data = JSON.parse(readFileSync(source === "-" ? 0 : source, "utf8"));
const all = Object.keys(data).sort();
const before = all.filter(d => d < since).slice(-Number(daysArg));
const after = all.filter(d => d > since);

const zero = () => ({ calls: 0, input: 0, cached: 0, output: 0 });
const collect = days => {
    const kinds = {};
    const total = zero();
    for (const day of days) {
        for (const [kind, models] of Object.entries(data[day])) {
            for (const u of Object.values(models)) {
                const k = (kinds[kind] ??= zero());
                for (const t of [k, total]) {
                    t.calls += u.calls; t.input += u.input; t.cached += u.cached; t.output += u.output;
                }
            }
        }
    }
    return { kinds, total, days: days.length };
};

const fmt = n => Math.round(n).toLocaleString("pl-PL");
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");
const equiv = u => u.input - u.cached + 0.1 * u.cached;
const change = (a, b) => (a ? `${b >= a ? "+" : ""}${Math.round((100 * (b - a)) / a)}%` : "-");

const describe = (u, days) => ({
    "wywołań / dzień": u.calls / days,
    "wejście / wywołanie": u.calls ? u.input / u.calls : 0,
    "cache": u.input ? (100 * u.cached) / u.input : 0,
    "wejście bez cache / wywołanie": u.calls ? (u.input - u.cached) / u.calls : 0,
    "ekwiwalent wejścia / dzień": equiv(u) / days,
    "wyjście / dzień": u.output / days,
});

const b = collect(before);
const a = collect(after);
console.log(`Zmiana: ${since}. Przed: ${before[0] ?? "-"}…${before.at(-1) ?? "-"} (${b.days} dni). Po: ${after[0] ?? "-"}…${after.at(-1) ?? "-"} (${a.days} dni).`);
if (!a.days || !b.days) {
    console.log("Za mało danych do porównania (potrzebny co najmniej jeden pełny dzień przed i po zmianie).");
    process.exit(0);
}
const table = (label, ub, ua) => {
    console.log(`\n${label}`);
    const db = describe(ub, b.days);
    const da = describe(ua, a.days);
    for (const key of Object.keys(db)) {
        const show = v => (key === "cache" ? `${Math.round(v)}%` : fmt(v));
        console.log(`  ${key.padEnd(32)}${show(db[key]).padStart(12)}${show(da[key]).padStart(12)}${(key === "cache" ? `${Math.round(da[key] - db[key])} pp` : change(db[key], da[key])).padStart(10)}`);
    }
};
console.log(`${"".padEnd(34)}${"przed".padStart(12)}${"po".padStart(12)}${"zmiana".padStart(10)}`);
table("Pytania (question)", b.kinds.question ?? zero(), a.kinds.question ?? zero());
table("Wszystko razem", b.total, a.total);
console.log(`\nCache wg rodzaju: ${[...new Set([...Object.keys(b.kinds), ...Object.keys(a.kinds)])].map(k => `${k} ${pct(b.kinds[k]?.cached ?? 0, b.kinds[k]?.input ?? 0)}→${pct(a.kinds[k]?.cached ?? 0, a.kinds[k]?.input ?? 0)}`).join(", ")}`);
console.log("Ekwiwalent wejścia: token z cache liczony jako 0,1 zwykłego (przybliżenie kosztu wejścia).");
