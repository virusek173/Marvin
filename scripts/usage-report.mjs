// Usage: node scripts/usage-report.mjs [file|-] [days]    (default file: stdin when piped, else data/usage.json; days: last N days, default 14)
// Prints token usage per day and per call kind/model from data/usage.json. In Docker: make usage / make usage-staging.
import { readFileSync } from "node:fs";

const [source = process.stdin.isTTY ? "data/usage.json" : "-", daysArg = "14"] = process.argv.slice(2);
const data = JSON.parse(readFileSync(source === "-" ? 0 : source, "utf8"));
const days = Object.keys(data).sort().slice(-Number(daysArg));

const fmt = n => n.toLocaleString("pl-PL");
const pad = (s, n) => String(s).padStart(n);
const sum = (a, b) => ({ calls: a.calls + b.calls, input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output, reasoning: a.reasoning + b.reasoning });
const zero = { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
const row = (label, u) => `${label.padEnd(34)}${pad(fmt(u.calls), 7)}${pad(fmt(u.input), 12)}${pad(u.input ? Math.round((100 * u.cached) / u.input) + "%" : "-", 7)}${pad(fmt(u.output), 10)}${pad(fmt(u.reasoning), 10)}`;
const header = `${"".padEnd(34)}${pad("calls", 7)}${pad("input", 12)}${pad("cache", 7)}${pad("output", 10)}${pad("reason.", 10)}`;

const perKind = {};
let grand = zero;
console.log(header);
for (const day of days) {
    let dayTotal = zero;
    const lines = [];
    for (const [kind, models] of Object.entries(data[day])) {
        for (const [model, u] of Object.entries(models)) {
            lines.push(row(`  ${kind} / ${model}`, u));
            dayTotal = sum(dayTotal, u);
            const key = `${kind} / ${model}`;
            perKind[key] = sum(perKind[key] ?? zero, u);
        }
    }
    grand = sum(grand, dayTotal);
    console.log(row(day, dayTotal));
    console.log(lines.join("\n"));
}
console.log(`\nRazem (${days.length} dni), wg rodzaju:`);
for (const [key, u] of Object.entries(perKind).sort((a, b) => b[1].input - a[1].input)) console.log(row(`  ${key}`, u));
console.log(row("RAZEM", grand));
