// Usage: node scripts/staging-ask.mjs "pytanie do Marvina"
// Posts to the staging channel through a webhook (URL in ~/.marvin-staging-webhook, or STAGING_WEBHOOK_FILE)
// as "Test Claude Bot", mentioning Marvin, then prints his reply from the staging archive. Needs TEST_WEBHOOK_AS_HUMAN=true in the staging env.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const CONTAINER = "marvin-marvin-staging-1";
const WAIT_MS = Number(process.env.STAGING_WAIT_MS ?? 90000);
const question = process.argv.slice(2).join(" ").trim();
if (!question) {
    console.error('Podaj treść: node scripts/staging-ask.mjs "pytanie"');
    process.exit(1);
}

const webhookUrl = readFileSync(process.env.STAGING_WEBHOOK_FILE ?? `${homedir()}/.marvin-staging-webhook`, "utf8").trim();
const marvinId = execFileSync("docker", ["exec", CONTAINER, "printenv", "MARVIN_ID"], { encoding: "utf8" }).trim();

const response = await fetch(`${webhookUrl}?wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "Test Claude Bot", content: `<@${marvinId}> ${question}`, allowed_mentions: { users: [marvinId] } }),
});
if (!response.ok) {
    console.error("Webhook error", response.status, await response.text());
    process.exit(1);
}
const posted = await response.json();
console.log("wysłano:", posted.id);

const readReplies = () => {
    const script = `
        const Database = require("better-sqlite3");
        const db = new Database("data/history.db", { readonly: true });
        const rows = db.prepare("SELECT content FROM messages WHERE channel_id = ? AND author_id = ? AND CAST(id AS INTEGER) > ? ORDER BY CAST(id AS INTEGER)").all(process.argv[1], process.argv[2], Number(process.argv[3]));
        console.log(JSON.stringify(rows.map(r => r.content)));`;
    const out = execFileSync("docker", ["exec", CONTAINER, "node", "-e", script, posted.channel_id, marvinId, posted.id], { encoding: "utf8" });
    return JSON.parse(out);
};

const deadline = Date.now() + WAIT_MS;
let replies = [];
let lastCount = 0;
let stableSince = Date.now();
while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    replies = readReplies();
    if (replies.length !== lastCount) {
        lastCount = replies.length;
        stableSince = Date.now();
    }
    if (replies.length && Date.now() - stableSince > 6000) break;
}

if (!replies.length) console.log("Brak odpowiedzi w", WAIT_MS / 1000, "s — sprawdź: make staging-logs");
else replies.forEach((text, index) => console.log(`\n--- Marvin (${index + 1}/${replies.length}) ---\n${text}`));
