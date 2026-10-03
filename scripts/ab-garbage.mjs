// Runs INSIDE the staging container (copied to /usr/src/app/ab-garbage.mjs): node ab-garbage.mjs [runsPerCell]
// A/B test of first-round replies of the tool loop; counts empty / leaked / gibberish answers per variant.
import OpenAI from "openai";
import { HistoryDb } from "./dest/src/services/history/db.js";
import { HistoryQuery } from "./dest/src/services/history/query.js";
import { buildHistoryTools } from "./dest/src/services/history/tools.js";
import { toContextMessage, renderBody } from "./dest/src/services/history/context.js";
import { formatWarsaw } from "./dest/src/services/history/time.js";
import { getMarvinMotivationSystemPrompt, HISTORY_TOOLS_PROMPT } from "./dest/src/utils/prompts.js";
import { mapGlobalNameNameToRealName } from "./dest/src/utils/helpers.js";

const RUNS = Number(process.argv[2] ?? 10);
const MODEL = "gpt-5.6-terra";
const LEAKED = /\bto=functions\.|<\|(?:call|channel|start|end|message)\|>|^\s*\[tool\]|weighted tokens left|[぀-ヿ㐀-鿿가-힯Ⴀ-ჿ]|\bWe need (?:to )?respond|^\s*\[assistant\b/i;

const env = process.env;
const peopleMap = {
    MarvinId: env.MARVIN_ID || "", HomarId: env.HOMAR_ID || "", JacekId: env.JACEK_ID || "", DominId: env.DOMIN_ID || "",
    MariuszId: env.MARIUSZ_ID || "", WiktorId: env.WIKTOR_ID || "", MadziaId: env.MADZIA_ID || "", MasonId: env.MASON_ID || "",
    PodsumowusId: env.PODSUMOWUS_ID || "", MugdaId: env.MUGDA_ID || "", WibotId: env.WIBOT_ID || "",
};
const date = new Date().toISOString().slice(0, 10);
const system = getMarvinMotivationSystemPrompt(date, peopleMap) + HISTORY_TOOLS_PROMPT;

const db = new HistoryDb("data/history.db");
const raw = new (await import("better-sqlite3")).default("data/history.db", { readonly: true });
const channelId = raw.prepare("SELECT channel_id FROM messages ORDER BY CAST(id AS INTEGER) DESC LIMIT 1").get().channel_id;
const recent = db.getRecentForContext(channelId, 30);
const selfId = env.MARVIN_ID;

const query = new HistoryQuery("data/history.db", { excludedChannelIds: [], selfId, guildId: () => "1" });
const tools = buildHistoryTools(query).map(t => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }));

const asks = ["Hej", "Co tam?", "Ile wiadomości napisał Jack w tym roku?"];
const lineBracket = m => `[${formatWarsaw(m.createdAt)}] ${m.authorId === selfId ? "Marvin" : mapGlobalNameNameToRealName[m.authorName]}: ${renderBody(m)}`;
const lineParen = m => `${m.authorId === selfId ? "Marvin" : mapGlobalNameNameToRealName[m.authorName]} (${formatWarsaw(m.createdAt)}): ${renderBody(m)}`;

const buildInput = (ask, line) => {
    const history = recent.slice(0, -1).map(m => ({ role: m.authorId === selfId ? "assistant" : "user", content: line(m) }));
    const last = { ...recent[recent.length - 1], authorId: "x", authorName: "Jack", content: `<@${selfId}> ${ask}`, embedsText: "", attachmentsText: "" };
    return [{ role: "system", content: system }, ...history, { role: "user", content: line(last) }];
};

const lineNoTime = m => `${m.authorId === selfId ? "Marvin" : mapGlobalNameNameToRealName[m.authorName]}: ${renderBody(m)}`;
const variants = {
    "low+tools (obecnie)": { effort: "low", tools: true, line: lineBracket },
    "low+tools+format (data)": { effort: "low", tools: true, line: lineParen },
    "low+tools+bez czasu": { effort: "low", tools: true, line: lineNoTime },
};

const client = new OpenAI();
const classify = r => {
    const calls = r.output.filter(i => i.type === "function_call");
    if (calls.length) return "ok";
    const text = (r.output_text ?? "").trim();
    if (!text) return "pusta";
    if (LEAKED.test(text)) return "wyciek";
    return "ok";
};

const pool = async (jobs, n) => {
    const out = [];
    let i = 0;
    await Promise.all(Array.from({ length: n }, async () => {
        while (i < jobs.length) { const job = jobs[i++]; out.push(await job()); }
    }));
    return out;
};

const jobs = [];
for (const [name, v] of Object.entries(variants)) {
    for (const ask of asks) {
        for (let k = 0; k < RUNS; k++) {
            jobs.push(async () => {
                try {
                    const r = await client.responses.create({
                        model: MODEL, input: buildInput(ask, v.line),
                        ...(v.tools ? { tools, tool_choice: "auto" } : {}),
                        reasoning: { effort: v.effort }, max_output_tokens: 4000,
                    });
                    return { name, ask, result: classify(r) };
                } catch (e) {
                    return { name, ask, result: "błąd API: " + String(e.message).slice(0, 60) };
                }
            });
        }
    }
}
const results = await pool(jobs, 6);
for (const name of Object.keys(variants)) {
    const mine = results.filter(r => r.name === name);
    const tally = {};
    for (const r of mine) tally[r.result] = (tally[r.result] ?? 0) + 1;
    const bad = mine.filter(r => r.result !== "ok").length;
    console.log(`${name.padEnd(28)} złych: ${bad}/${mine.length}  ${JSON.stringify(tally)}`);
}
