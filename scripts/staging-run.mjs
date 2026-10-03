// Usage: node scripts/staging-run.mjs [id|group ...]   (no args = all automatic cases; --list to list)
// Runs cases from scripts/staging-cases.json through scripts/staging-ask.mjs and prints what to verify for each.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(dir, "staging-cases.json"), "utf8"));
const args = process.argv.slice(2);

if (args.includes("--list")) {
    for (const c of cases) console.log(`${c.manual ? "[manual] " : ""}${c.group}/${c.id}: ${c.question}`);
    process.exit(0);
}

const selected = cases.filter(c => (args.length ? args.includes(c.id) || args.includes(c.group) : !c.manual));
for (const c of selected) {
    console.log(`\n==================== ${c.group}/${c.id}\nQuestion: ${c.question}\nCheck: ${c.expect}`);
    if (c.manual) continue;
    try {
        console.log(execFileSync("node", [join(dir, "staging-ask.mjs"), c.question], { encoding: "utf8" }));
    } catch (error) {
        console.log("ERROR:", error.stdout ?? "", error.stderr ?? error.message);
    }
}
