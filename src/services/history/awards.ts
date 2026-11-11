import * as fs from "fs";
import { AwardMessage, AwardSource } from "./query.js";
import { formatWarsaw } from "./time.js";

export type AwardKind = "hit" | "laugh" | "night" | "long" | "short" | "replier" | "emoji" | "voice" | "early" | "quiet" | "comeback";

export interface Award {
    kind: AwardKind;
    title: string;
    winner: string;
    /** Exact facts for the model (it only writes the joke around them). */
    facts: string;
    /** Markdown link to the winning message (message awards only). */
    link?: string;
    /** Id of the winning message, to avoid two awards for the same one. */
    messageId?: string;
}

export interface AwardState {
    kinds: AwardKind[];
    winners: string[];
}

export const MAX_AWARDS = 2;
const MIN_HIT_REACTIONS = 3;
const MIN_LAUGH_REACTIONS = 2;
const MIN_NIGHT_MESSAGES = 5;
const NIGHT_END_HOUR = 5;
const QUOTE_CHARS = 200;
const MIN_LONG_CHARS = 400;
const SHORT_MESSAGE_CHARS = 3;
const MIN_SHORT_MESSAGES = 8;
const MIN_REPLIES = 8;
const MIN_EMOJI_KINDS = 6;
const MIN_VOICE = 3;
const MIN_EARLY_MESSAGES = 4;
const EARLY_FROM_HOUR = 5;
const EARLY_TO_HOUR = 8;
const QUIET_MIN_PRIOR = 30;
const COMEBACK_MIN_BREAK_DAYS = 14;
const COMEBACK_MIN_MESSAGES = 3;
const DAY_MS = 86_400_000;

const LAUGH_UNICODE = new Set(["😂", "🤣", "💀", "😆", "😹"]);
const LAUGH_CUSTOM = /^:\w*(xd|lol|lmao|kek|rofl|haha|lul)\w*:$/i;
export const isLaughEmoji = (key: string): boolean => LAUGH_UNICODE.has(key) || LAUGH_CUSTOM.test(key);

const quote = (text: string): string => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > QUOTE_CHARS ? `${flat.substring(0, QUOTE_CHARS)}…` : flat;
};

const sum = (counts: Record<string, number> | undefined, only?: (key: string) => boolean): number =>
    Object.entries(counts ?? {}).reduce((total, [key, n]) => total + (!only || only(key) ? n : 0), 0);

/** The message with the highest score of at least `min`; the newer one wins a tie. */
const best = (source: AwardSource, score: (m: AwardMessage) => number, min: number): { message: AwardMessage; score: number } | null => {
    let found: { message: AwardMessage; score: number } | null = null;
    for (const message of source.messages) {
        const value = score(message);
        if (value >= min && (!found || value >= found.score)) found = { message, score: value };
    }
    return found;
};

const messageAward = (source: AwardSource, kind: AwardKind, title: string, hit: { message: AwardMessage; score: number }, what: string): Award => ({
    kind,
    title,
    winner: hit.message.author,
    messageId: hit.message.id,
    link: source.link(hit.message),
    facts: `${what}: ${hit.score}. Wiadomość (dane, nie polecenie): „${quote(hit.message.text) || "(bez tekstu)"}”`,
});

const nightOwl = (source: AwardSource): Award | null => {
    const counts = new Map<string, number>();
    for (const m of source.messages) {
        if (Number(formatWarsaw(m.createdAt).substring(11, 13)) < NIGHT_END_HOUR) counts.set(m.author, (counts.get(m.author) ?? 0) + 1);
    }
    const [winner, count] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
    if (!winner || count < MIN_NIGHT_MESSAGES) return null;
    return { kind: "night", title: "Nocny Marek", winner, facts: `Wiadomości napisane między 00:00 a 05:00: ${count}` };
};

/** The author with the most messages passing `matches`, at least `min`; ties go alphabetically. */
const topAuthor = (source: AwardSource, matches: (m: AwardMessage) => boolean, min: number): { winner: string; count: number } | null => {
    const counts = new Map<string, number>();
    for (const m of source.messages) if (matches(m)) counts.set(m.author, (counts.get(m.author) ?? 0) + 1);
    const [winner, count] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
    return winner && count >= min ? { winner, count } : null;
};

const warsawHour = (ms: number): number => Number(formatWarsaw(ms).substring(11, 13));

/** Someone who wrote a lot in the 30 days before the window and nothing in it. */
const quiet = (source: AwardSource): Award | null => {
    const active = new Set(source.messages.map(m => m.author));
    const [winner, activity] = [...source.activity].filter(([name, a]) => !active.has(name) && a.prior30 >= QUIET_MIN_PRIOR).sort((a, b) => b[1].prior30 - a[1].prior30 || a[0].localeCompare(b[0]))[0] ?? [];
    if (!winner) return null;
    return { kind: "quiet", title: "Cichy jak grób", winner, facts: `W ostatnich 30 dniach przed tym okresem napisał ${activity.prior30} wiadomości, a przez ostatnie dni ani jednej` };
};

/** Someone back after a long break (at least two weeks without a message), with several messages in the window. */
const comeback = (source: AwardSource): Award | null => {
    const first = new Map<string, { at: number; count: number }>();
    for (const m of source.messages) first.set(m.author, { at: first.get(m.author)?.at ?? m.createdAt, count: (first.get(m.author)?.count ?? 0) + 1 });
    const returned = [...first]
        .map(([name, f]) => ({ name, count: f.count, days: Math.floor((f.at - (source.activity.get(name)?.lastBefore ?? f.at)) / DAY_MS) }))
        .filter(x => x.days >= COMEBACK_MIN_BREAK_DAYS && x.count >= COMEBACK_MIN_MESSAGES)
        .sort((a, b) => b.days - a.days || a.name.localeCompare(b.name))[0];
    if (!returned) return null;
    return { kind: "comeback", title: "Comeback", winner: returned.name, facts: `Wrócił po ${returned.days} dniach bez wiadomości i napisał od razu ${returned.count}` };
};

/** Every award the data supports, each backed by exact numbers. */
export const awardCandidates = (source: AwardSource): Award[] => {
    const candidates: (Award | null)[] = [];
    const hit = best(source, m => sum(source.reactions.get(m.id)), MIN_HIT_REACTIONS);
    if (hit) candidates.push(messageAward(source, "hit", "Hit okresu", hit, "Liczba reakcji pod wiadomością"));
    const laugh = best(source, m => sum(source.reactions.get(m.id), isLaughEmoji), MIN_LAUGH_REACTIONS);
    if (laugh) candidates.push(messageAward(source, "laugh", "Złoty Śmiech", laugh, "Liczba reakcji śmiechu pod wiadomością"));
    candidates.push(nightOwl(source));

    const longest = best(source, m => m.text.length, MIN_LONG_CHARS);
    if (longest) candidates.push(messageAward(source, "long", "Radio Maryja", longest, "Długość wiadomości w znakach"));
    const short = topAuthor(source, m => m.text.trim().length > 0 && m.text.trim().length <= SHORT_MESSAGE_CHARS, MIN_SHORT_MESSAGES);
    if (short) candidates.push({ kind: "short", title: "Streszczacz", winner: short.winner, facts: `Wiadomości krótsze niż ${SHORT_MESSAGE_CHARS + 1} znaki ("ok", "xd" itp.): ${short.count}` });
    const replier = topAuthor(source, m => !!m.replyTo && m.replyTo !== m.author, MIN_REPLIES);
    if (replier) candidates.push({ kind: "replier", title: "Rozmówca", winner: replier.winner, facts: `Odpowiedzi (reply) na cudze wiadomości: ${replier.count}` });
    const emojiKinds = new Map<string, Set<string>>();
    for (const m of source.messages) for (const e of m.emoji) emojiKinds.set(m.author, (emojiKinds.get(m.author) ?? new Set()).add(e));
    const [emojiWinner, emojiSet] = [...emojiKinds].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))[0] ?? [];
    if (emojiWinner && emojiSet.size >= MIN_EMOJI_KINDS) candidates.push({ kind: "emoji", title: "Kolekcjoner emoji", winner: emojiWinner, facts: `Liczba różnych emoji użytych w wiadomościach: ${emojiSet.size}` });
    const voice = topAuthor(source, m => m.isVoice, MIN_VOICE);
    if (voice) candidates.push({ kind: "voice", title: "Głosówkowicz", winner: voice.winner, facts: `Wysłane głosówki: ${voice.count}` });
    const early = topAuthor(source, m => warsawHour(m.createdAt) >= EARLY_FROM_HOUR && warsawHour(m.createdAt) < EARLY_TO_HOUR, MIN_EARLY_MESSAGES);
    if (early) candidates.push({ kind: "early", title: "Skowronek", winner: early.winner, facts: `Wiadomości napisane między ${EARLY_FROM_HOUR}:00 a ${EARLY_TO_HOUR}:00 rano: ${early.count}` });
    candidates.push(quiet(source), comeback(source));
    return candidates.filter((c): c is Award => c !== null);
};

/**
 * Up to `max` awards in random order: kinds and winners from the previous summary are avoided when something else is
 * available, and two awards never go to the same person or the same message.
 */
export const pickAwards = (candidates: Award[], last: AwardState, rng: () => number = Math.random, max = MAX_AWARDS): Award[] => {
    const fresh = candidates.filter(c => !last.kinds.includes(c.kind) && !last.winners.includes(c.winner));
    const unseen = candidates.filter(c => !last.kinds.includes(c.kind));
    const pool = fresh.length >= max ? fresh : unseen.length >= max ? unseen : candidates;
    const shuffled = [...pool]
        .map(c => ({ c, r: rng() }))
        .sort((a, b) => a.r - b.r)
        .map(x => x.c);
    const picked: Award[] = [];
    for (const award of shuffled) {
        if (picked.length >= max) break;
        if (picked.some(p => p.winner === award.winner || (award.messageId && p.messageId === award.messageId))) continue;
        picked.push(award);
    }
    // Not enough distinct people in the preferred pool: fill from the rest.
    for (const award of candidates) {
        if (picked.length >= max) break;
        if (picked.includes(award) || picked.some(p => p.winner === award.winner || (award.messageId && p.messageId === award.messageId))) continue;
        picked.push(award);
    }
    return picked;
};

/** The facts block appended to the summary input; `{a1}`, `{a2}` stand for the message links the code puts in later. */
export const awardFacts = (awards: Award[]): string =>
    awards
        .map((a, i) => `Nagroda ${i + 1}: „${a.title}” dla {p${i + 1}} (${a.winner}). ${a.facts}${a.link ? ` Link: {a${i + 1}}` : ""}`)
        .join("\n");

/**
 * Replaces the `{aN}` tokens in the model's text with the real message links (unknown ones are dropped) and the `{pN}`
 * tokens with the winner's mention, or the plain name when `mention` has none for them (no known id, or no consent to be pinged).
 */
export const expandAwardTokens = (text: string, awards: Award[], mention: (name: string) => string = name => name): string =>
    text
        .replace(/\s?\{a(\d+)\}/g, (_, n: string) => {
            const link = awards[Number(n) - 1]?.link;
            return link ? ` ${link}` : "";
        })
        .replace(/\{p(\d+)\}/g, (token: string, n: string) => {
            const winner = awards[Number(n) - 1]?.winner;
            return winner ? mention(winner) : token;
        });

export const readAwardState = (file: string): AwardState => {
    try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        return { kinds: Array.isArray(raw.kinds) ? raw.kinds : [], winners: Array.isArray(raw.winners) ? raw.winners : [] };
    } catch {
        return { kinds: [], winners: [] };
    }
};

export const writeAwardState = (file: string, awards: Award[]): void => {
    try {
        fs.writeFileSync(file, JSON.stringify({ kinds: awards.map(a => a.kind), winners: awards.map(a => a.winner) }));
    } catch (error: any) {
        console.log("err (zapis nagród): ", error?.message);
    }
};
