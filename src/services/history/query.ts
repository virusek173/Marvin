import Database from "better-sqlite3";
import { foldForSearch } from "./db.js";
import { cutText, mapGlobalNameNameToRealName } from "../../utils/helpers.js";
import { formatWarsaw, parseWarsaw, WARSAW_TZ } from "./time.js";
import { renderBody } from "./context.js";
import { PhraseCount, PhraseCounter } from "./phrases.js";

export const LIMITS = {
    searchDefault: 10,
    searchMax: 25,
    rangeDefault: 50,
    rangeMax: 100,
    aroundMax: 15,
    textChars: 500,
    totalChars: 45000,
    queryTokens: 8,
    statsDefault: 20,
    statsMax: 60,
    conversationDefault: 40,
    conversationGapDefault: 30,
    conversationGapMax: 240,
    conversationScan: 300,
};

export interface ConversationInfo {
    start: string;
    end: string;
    /** Size of the whole conversation, of which `messages` in the result may be only a window around the requested one. */
    messages: number;
    gapMinutes: number;
    /** True when the scan limit was hit, so the conversation is at least this long. */
    atLeast?: boolean;
}

export interface HistoryMessage {
    id: string;
    channel: string;
    author: string;
    time: string;
    text: string;
    /** Ready-to-paste Discord markdown link (`[dd.mm.yyyy hh:mm](<url>)`); absent without a server id. */
    cite?: string;
}

export interface QueryResult {
    timezone: string;
    count: number;
    truncated: boolean;
    messages: HistoryMessage[];
    note?: string;
}

export const STATS_GROUPS = ["author", "channel", "day", "month", "weekday", "hour"] as const;
export type StatsGroup = (typeof STATS_GROUPS)[number] | "none";

export interface StatsResult {
    timezone: string;
    /** Number of messages matching the filters (before grouping). */
    total: number;
    groupBy: StatsGroup;
    first?: string;
    last?: string;
    groups: { key: string; count: number; share: number }[];
    /** True when there were more groups than `limit`. */
    truncated: boolean;
    note?: string;
}

export interface PhrasesResult {
    words: PhraseCount[];
    pairs: PhraseCount[];
}

export interface PersonProfile {
    name: string;
    /** Generated, unofficial description based on the person's chat messages. */
    profile: string;
    basedOnMessages: number;
    /** Date of the last refresh (YYYY.MM.DD, Warsaw time). */
    updated: string;
}

export interface ProfilesResult {
    count: number;
    profiles: PersonProfile[];
    note?: string;
}

const WEEKDAYS = ["poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota", "niedziela"];

const timeBucket = (ms: number, groupBy: StatsGroup): string => {
    const [y, mo, d, hm] = formatWarsaw(ms).split(/[. ]/);
    if (groupBy === "month") return `${y}-${mo}`;
    if (groupBy === "hour") return `${hm.substring(0, 2)}:00`;
    if (groupBy === "weekday") return WEEKDAYS[(new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay() + 6) % 7];
    return `${y}-${mo}-${d}`;
};

export interface ChannelListing {
    id: string;
    name: string;
    parentName?: string;
    messages: number;
}

export interface QueryFilters {
    author?: string;
    channel?: string;
    from?: string;
    to?: string;
}

export interface HistoryQueryOptions {
    excludedChannelIds: string[];
    selfId?: string;
    /** Server id for building jump links; without it results carry no `cite`. */
    guildId?: () => string | undefined;
}

const clamp = (value: number | undefined, fallback: number, max: number): number => {
    const n = Number.isFinite(value) ? Math.floor(value as number) : fallback;
    return Math.min(Math.max(n, 1), max);
};

/** Real name → every username/global name that maps to it (case-insensitive); unknown names match themselves. */
const nameEntries = (): [string, string][] => Object.entries(mapGlobalNameNameToRealName) as [string, string][];

const authorNamesFor = (input: string): string[] => {
    const wanted = input.trim().toLowerCase();
    const names = new Set<string>([input.trim()]);
    for (const [username, realName] of nameEntries()) {
        if (realName.toLowerCase() === wanted || username.toLowerCase() === wanted) {
            names.add(username);
            for (const [other, real] of nameEntries()) {
                if (real === realName) names.add(other);
            }
        }
    }
    return [...names];
};

const searchTokens = (text: string): string[] =>
    foldForSearch(text)
        .split(/[^\p{L}\p{N}]+/u)
        .filter(t => t.length > 0)
        .slice(0, LIMITS.queryTokens);

/** Turns free text into a safe FTS5 query: every word becomes a quoted prefix term, all must match. */
export const buildFtsQuery = (text: string, join: "AND" | "OR" = "AND"): string | null => {
    const tokens = searchTokens(text);
    return tokens.length ? tokens.map(t => `"${t}"*`).join(join === "OR" ? " OR " : " ") : null;
};

/** Lowercase, diacritics-free copy of the text with exactly the same length, for locating search terms. */
const foldSameLength = (text: string): string =>
    Array.from(text, c => (c.normalize("NFD").replace(/\p{M}/gu, "")[0] ?? c).toLowerCase().replace("ł", "l")[0] ?? c).join("");

/** Shortens a message to `textChars`; when `terms` are given and the first hit lies beyond the beginning, keeps the hit visible. */
const clip = (text: string, terms: string[]): string => {
    if (text.length <= LIMITS.textChars) return text;
    const folded = foldSameLength(text);
    const hits = terms.map(t => folded.indexOf(foldSameLength(t))).filter(i => i >= 0);
    const first = hits.length ? Math.min(...hits) : 0;
    if (first < LIMITS.textChars - 80) return `${cutText(text, LIMITS.textChars)}…`;
    let start = Math.max(0, first - 150);
    if (/[\uDC00-\uDFFF]/.test(text[start] ?? "")) start++;
    const end = start + LIMITS.textChars;
    return `…${cutText(text.substring(start), LIMITS.textChars)}${end < text.length ? "…" : ""}`;
};

/**
 * Read-only access to the message archive for the model's tools. Opens its own `readonly` connection, runs only
 * parameterized SELECTs, caps result sizes and always hides excluded channels.
 */
export class HistoryQuery {
    private db: Database.Database;
    private excluded: string[];
    private selfId?: string;
    private guildId?: () => string | undefined;
    /** Messages with an id at or above this are hidden (the question being answered and anything newer). */
    private cutoffId?: bigint;

    constructor(file: string, options: HistoryQueryOptions) {
        this.guildId = options.guildId;
        this.db = new Database(file, { readonly: true, fileMustExist: true });
        this.db.pragma("query_only = ON");
        this.db.pragma("busy_timeout = 5000");
        this.excluded = options.excludedChannelIds;
        this.selfId = options.selfId;
    }

    close(): void {
        this.db.close();
    }

    /**
     * A view over the same connection that hides the given message and everything newer (Discord ids grow with time).
     * The model already sees the question in its context; archived copies would only pollute search hits, links and counts.
     */
    scoped(beforeMessageId: string): HistoryQuery {
        if (!/^\d+$/.test(beforeMessageId)) return this;
        return Object.create(this, { cutoffId: { value: BigInt(beforeMessageId) } }) as HistoryQuery;
    }

    /** Words must all match; if nothing matches, falls back to any of the words. Bot messages are skipped unless an author is given or `includeBots` is set. */
    search(args: QueryFilters & { query: string; limit?: number; includeBots?: boolean }): QueryResult {
        const fts = buildFtsQuery(args.query ?? "");
        if (!fts) return this.empty("Puste zapytanie — podaj co najmniej jedno słowo do wyszukania.");
        const limit = clamp(args.limit, LIMITS.searchDefault, LIMITS.searchMax);
        const filter = this.filters(args, "m");
        if (typeof filter === "string") return this.empty(filter);
        const skipBots = !args.includeBots && !args.author?.trim() ? " AND m.is_bot = 0" : "";
        const run = (match: string) => this.db
            .prepare(`SELECT m.* FROM messages_fts f JOIN messages m ON m.seq = f.rowid
                WHERE messages_fts MATCH ? ${filter.sql}${skipBots}
                ORDER BY bm25(messages_fts), m.created_at DESC LIMIT ?`)
            .all(match, ...filter.params, limit + 1) as any[];
        const terms = searchTokens(args.query);
        let rows = run(fts);
        let note: string | undefined;
        if (rows.length === 0 && terms.length > 1) {
            rows = run(buildFtsQuery(args.query, "OR")!);
            if (rows.length > 0) note = "Żadna wiadomość nie zawiera wszystkich słów naraz — pokazuję wiadomości z którymkolwiek ze słów, najlepiej dopasowane najpierw.";
        }
        const result = this.render(rows, limit, terms);
        return note ? { ...result, note } : result;
    }

    /** Messages in a time range (Warsaw time), shown oldest first; when the range holds more than `limit`: the earliest ones, or with `newest` the latest ones. */
    range(args: QueryFilters & { limit?: number; newest?: boolean }): QueryResult {
        const limit = clamp(args.limit, LIMITS.rangeDefault, LIMITS.rangeMax);
        const filter = this.filters(args, "m");
        if (typeof filter === "string") return this.empty(filter);
        const direction = args.newest ? "DESC" : "ASC";
        const rows = this.db
            .prepare(`SELECT m.* FROM messages m WHERE 1 = 1 ${filter.sql}
                ORDER BY m.created_at ${direction}, CAST(m.id AS INTEGER) ${direction} LIMIT ?`)
            .all(...filter.params, limit + 1);
        const result = this.render(rows as any[], limit);
        if (args.newest) {
            // Older messages beyond the limit are expected here; flag only a cut caused by the size budget.
            result.truncated = result.count < Math.min(rows.length, limit);
            result.messages.reverse();
        }
        return result;
    }

    /** `before` messages preceding and `after` following the given message in its channel, plus the message itself. */
    around(args: { messageId: string; before?: number; after?: number }): QueryResult {
        const before = Math.min(Math.max(Math.floor(args.before ?? 5), 0), LIMITS.aroundMax);
        const after = Math.min(Math.max(Math.floor(args.after ?? 5), 0), LIMITS.aroundMax);
        const hidden = this.excludedClause("m");
        const anchor = this.db
            .prepare(`SELECT m.* FROM messages m WHERE m.id = ? ${hidden.sql}`)
            .get(String(args.messageId), ...hidden.params) as any;
        if (!anchor) return this.empty("Nie znaleziono wiadomości o takim identyfikatorze.");
        const order = "ORDER BY m.created_at, CAST(m.id AS INTEGER)";
        const key = "(m.created_at < @t OR (m.created_at = @t AND CAST(m.id AS INTEGER) < @n))";
        const keyAfter = "(m.created_at > @t OR (m.created_at = @t AND CAST(m.id AS INTEGER) > @n))";
        const bind: Record<string, unknown> = { t: anchor.created_at, n: BigInt(anchor.id), c: anchor.channel_id };
        const cut = this.cutoffSql(bind);
        const prior = this.db
            .prepare(`SELECT * FROM (SELECT m.* FROM messages m WHERE m.channel_id = @c AND m.is_technical = 0 AND ${key} ${cut}
                ORDER BY m.created_at DESC, CAST(m.id AS INTEGER) DESC LIMIT ${before}) m ${order}`)
            .all(bind);
        const next = this.db
            .prepare(`SELECT m.* FROM messages m WHERE m.channel_id = @c AND m.is_technical = 0 AND ${keyAfter} ${cut}
                ${order} LIMIT ${after}`)
            .all(bind);
        return this.render([...prior, anchor, ...next] as any[], before + after + 1);
    }

    /**
     * The conversation a message belongs to: neighbouring messages of the same channel with no gap longer than `gapMinutes`.
     * When the conversation exceeds `limit`, a window centred on the message is returned; `conversation` always describes the whole thing.
     */
    conversation(args: { messageId: string; gapMinutes?: number; limit?: number }): QueryResult & { conversation?: ConversationInfo } {
        const gapMs = clamp(args.gapMinutes, LIMITS.conversationGapDefault, LIMITS.conversationGapMax) * 60_000;
        const limit = clamp(args.limit, LIMITS.conversationDefault, LIMITS.rangeMax);
        const hidden = this.excludedClause("m");
        const anchor = this.db.prepare(`SELECT m.* FROM messages m WHERE m.id = ? ${hidden.sql}`).get(String(args.messageId), ...hidden.params) as any;
        if (!anchor) return this.empty("Nie znaleziono wiadomości o takim identyfikatorze.");

        const bind: Record<string, unknown> = { t: anchor.created_at, n: BigInt(anchor.id), c: anchor.channel_id, cap: LIMITS.conversationScan };
        const cut = this.cutoffSql(bind);
        const side = (before: boolean): any[] => {
            const cmp = before ? "<" : ">";
            const dir = before ? "DESC" : "ASC";
            const rows = this.db
                .prepare(`SELECT m.* FROM messages m WHERE m.channel_id = @c AND m.is_technical = 0
                    AND (m.created_at ${cmp} @t OR (m.created_at = @t AND CAST(m.id AS INTEGER) ${cmp} @n)) ${cut}
                    ORDER BY m.created_at ${dir}, CAST(m.id AS INTEGER) ${dir} LIMIT @cap`)
                .all(bind) as any[];
            const kept: any[] = [];
            let prev = anchor.created_at;
            for (const r of rows) {
                if (Math.abs(r.created_at - prev) > gapMs) break;
                kept.push(r);
                prev = r.created_at;
            }
            return kept;
        };
        const prior = side(true);
        const next = side(false);

        const total = prior.length + 1 + next.length;
        let before = prior.length;
        let after = next.length;
        if (total > limit) {
            const others = limit - 1;
            before = Math.min(prior.length, Math.floor(others / 2));
            after = Math.min(next.length, others - before);
            before = Math.min(prior.length, others - after);
        }
        const first = prior.length ? prior[prior.length - 1] : anchor;
        const last = next.length ? next[next.length - 1] : anchor;
        const shown = [...prior.slice(0, before).reverse(), anchor, ...next.slice(0, after)];
        const result = this.render(shown, shown.length);
        const scanCut = prior.length >= LIMITS.conversationScan || next.length >= LIMITS.conversationScan;
        return {
            ...result,
            truncated: result.truncated || total > limit,
            conversation: { start: formatWarsaw(first.created_at), end: formatWarsaw(last.created_at), messages: total, gapMinutes: gapMs / 60_000, ...(scanCut ? { atLeast: true } : null) },
        };
    }

    /**
     * Message counts grouped by author, channel or Warsaw-time bucket. Counts only human messages unless `includeBots`
     * is set (or an author filter is given), and respects the same filters and hidden channels as the other queries.
     */
    stats(args: QueryFilters & { groupBy?: string; query?: string; includeBots?: boolean; sort?: string; limit?: number }): StatsResult {
        const groupBy = (STATS_GROUPS as readonly string[]).includes(args.groupBy ?? "") ? (args.groupBy as StatsGroup) : "none";
        const limit = clamp(args.limit, LIMITS.statsDefault, LIMITS.statsMax);
        const filter = this.filters(args, "m");
        if (typeof filter === "string") return { timezone: WARSAW_TZ, total: 0, groupBy, groups: [], truncated: false, note: filter };

        let from = "messages m";
        const params: (string | number | bigint)[] = [];
        let match = "";
        if (args.query?.trim()) {
            const fts = buildFtsQuery(args.query);
            if (!fts) return { timezone: WARSAW_TZ, total: 0, groupBy, groups: [], truncated: false, note: "Puste zapytanie — podaj co najmniej jedno słowo albo pomiń query." };
            from = "messages_fts f JOIN messages m ON m.seq = f.rowid";
            match = "AND messages_fts MATCH ?";
            params.push(fts);
        }
        const skipBots = !args.includeBots && !args.author?.trim() ? " AND m.is_bot = 0" : "";
        const where = `WHERE 1 = 1 ${match} ${filter.sql}${skipBots}`;
        params.push(...filter.params);

        const totals = this.db.prepare(`SELECT COUNT(*) AS n, MIN(m.created_at) AS first, MAX(m.created_at) AS last FROM ${from} ${where}`).get(...params) as { n: number; first: number | null; last: number | null };
        const base = { timezone: WARSAW_TZ, total: totals.n, groupBy, ...(totals.n > 0 ? { first: formatWarsaw(totals.first!), last: formatWarsaw(totals.last!) } : null) };
        if (groupBy === "none" || totals.n === 0) return { ...base, groups: [], truncated: false };

        const counts = new Map<string, number>();
        const add = (key: string, n: number) => counts.set(key, (counts.get(key) ?? 0) + n);

        if (groupBy === "author") {
            const rows = this.db.prepare(`SELECT m.author_id AS id, MAX(m.author_name) AS name, COUNT(*) AS n FROM ${from} ${where} GROUP BY m.author_id`).all(...params) as { id: string; name: string; n: number }[];
            for (const r of rows) add(r.id === this.selfId ? "Marvin" : mapGlobalNameNameToRealName[r.name], r.n);
        } else if (groupBy === "channel") {
            const rows = this.db.prepare(`SELECT m.channel_id AS id, COUNT(*) AS n FROM ${from} ${where} GROUP BY m.channel_id`).all(...params) as { id: string; n: number }[];
            const named = this.db.prepare("SELECT c.name, p.name AS parent FROM channels c LEFT JOIN channels p ON p.id = c.parent_id WHERE c.id = ?");
            for (const r of rows) {
                const c = named.get(r.id) as { name: string | null; parent: string | null } | undefined;
                add(c?.parent ? `${c.name ?? r.id} (wątek w #${c.parent})` : (c?.name ?? r.id), r.n);
            }
        } else {
            // Buckets are whole UTC hours (Warsaw offsets are whole hours), then folded into Warsaw-time days/months/etc.
            const rows = this.db.prepare(`SELECT m.created_at / 3600000 AS h, COUNT(*) AS n FROM ${from} ${where} GROUP BY h`).all(...params) as { h: number; n: number }[];
            for (const r of rows) add(timeBucket(r.h * 3600000, groupBy), r.n);
        }

        const sortBy = args.sort === "count" || args.sort === "key" ? args.sort : (["month", "weekday", "hour"].includes(groupBy) ? "key" : "count");
        let groups = [...counts].map(([key, count]) => ({ key, count, share: Math.round((count / totals.n) * 1000) / 10 }));
        if (sortBy === "key") {
            groups.sort(groupBy === "weekday" ? (a, b) => WEEKDAYS.indexOf(a.key) - WEEKDAYS.indexOf(b.key) : (a, b) => a.key.localeCompare(b.key));
        } else {
            groups.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
        }
        const truncated = groups.length > limit;
        groups = groups.slice(0, limit);
        return { ...base, groups, truncated };
    }

    /** Most common words and word pairs in human messages matching the filters (links, mentions and filler words ignored). */
    phrases(args: QueryFilters & { words?: number; pairs?: number }): PhrasesResult {
        const filter = this.filters(args, "m");
        if (typeof filter === "string") return { words: [], pairs: [] };
        const counter = new PhraseCounter();
        const rows = this.db.prepare(`SELECT m.content FROM messages m WHERE m.is_bot = 0 ${filter.sql}`).iterate(...filter.params) as IterableIterator<{ content: string }>;
        for (const r of rows) counter.add(r.content);
        return { words: counter.top("words", args.words ?? 10, 3), pairs: counter.top("pairs", args.pairs ?? 5, 3) };
    }

    /** Generated profile of one person (real name or any of their usernames), or of everyone when no person is given. */
    profiles(person?: string): ProfilesResult {
        const rows = this.db.prepare("SELECT name, summary, message_count, updated_at FROM profiles ORDER BY message_count DESC").all() as any[];
        const all: PersonProfile[] = rows.map(r => ({ name: r.name, profile: r.summary, basedOnMessages: r.message_count, updated: formatWarsaw(r.updated_at).substring(0, 10) }));
        const wanted = person?.trim();
        if (!wanted) {
            return { count: all.length, profiles: all, ...(all.length === 0 ? { note: "Profile osób jeszcze nie zostały wygenerowane." } : null) };
        }
        const names = new Set([wanted, mapGlobalNameNameToRealName[wanted]].map(n => n.toLowerCase()));
        const found = all.filter(p => names.has(p.name.toLowerCase()));
        if (found.length > 0) return { count: found.length, profiles: found };
        return { count: 0, profiles: [], note: `Brak profilu dla "${wanted}". Profile mają: ${all.map(p => p.name).join(", ") || "nikt (jeszcze nie wygenerowano)"}.` };
    }

    listChannels(): ChannelListing[] {
        const hidden = this.excludedClause("c", "id");
        const rows = this.db
            .prepare(`SELECT c.id, c.name, p.name AS parent_name,
                    (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id) AS n
                FROM channels c LEFT JOIN channels p ON p.id = c.parent_id
                WHERE 1 = 1 ${hidden.sql}
                ORDER BY n DESC LIMIT 200`)
            .all(...hidden.params) as any[];
        return rows
            .filter(r => r.n > 0)
            .map(r => ({ id: r.id, name: r.name ?? r.id, ...(r.parent_name ? { parentName: r.parent_name } : {}), messages: r.n }));
    }

    private empty(note: string): QueryResult {
        return { timezone: WARSAW_TZ, count: 0, truncated: false, messages: [], note };
    }

    /** SQL fragment hiding excluded channels and threads of excluded channels. */
    private excludedClause(alias: string, idColumn = "channel_id"): { sql: string; params: (string | bigint)[] } {
        const sql: string[] = [];
        const params: (string | bigint)[] = [];
        if (this.excluded.length > 0) {
            const marks = this.excluded.map(() => "?").join(",");
            sql.push(`AND ${alias}.${idColumn} NOT IN (${marks}) AND (${alias}.parent_id IS NULL OR ${alias}.parent_id NOT IN (${marks}))`);
            params.push(...this.excluded, ...this.excluded);
        }
        if (this.cutoffId !== undefined && idColumn === "channel_id") {
            sql.push(`AND CAST(${alias}.id AS INTEGER) < ?`);
            params.push(this.cutoffId);
        }
        return { sql: sql.join(" "), params };
    }

    /** Extra condition (named parameter `@cut`) for queries that walk from an anchor message instead of using `excludedClause`. */
    private cutoffSql(bind: Record<string, unknown>, alias = "m"): string {
        if (this.cutoffId === undefined) return "";
        bind.cut = this.cutoffId;
        return `AND CAST(${alias}.id AS INTEGER) < @cut`;
    }

    /** WHERE fragment for author / channel / date filters; a string result is a message to show the model instead. */
    private filters(f: QueryFilters, alias: string): { sql: string; params: (string | number | bigint)[] } | string {
        const parts: string[] = [`${alias}.is_technical = 0`];
        const params: (string | number | bigint)[] = [];

        if (f.author?.trim()) {
            const names = authorNamesFor(f.author);
            parts.push(`${alias}.author_name COLLATE NOCASE IN (${names.map(() => "?").join(",")})`);
            params.push(...names);
        }
        if (f.channel?.trim()) {
            const wanted = f.channel.trim().replace(/^#/, "");
            const key = foldSameLength(wanted);
            const all = this.db.prepare("SELECT id, name, parent_id FROM channels").all() as { id: string; name: string | null; parent_id: string | null }[];
            const direct = new Set(all.filter(c => c.id === wanted || (c.name !== null && foldSameLength(c.name) === key)).map(c => c.id));
            const ids = all.filter(c => direct.has(c.id) || (c.parent_id !== null && direct.has(c.parent_id))).map(c => c.id);
            if (ids.length === 0) return `Nie znam kanału "${wanted}". Użyj listy kanałów.`;
            parts.push(`${alias}.channel_id IN (${ids.map(() => "?").join(",")})`);
            params.push(...ids);
        }
        if (f.from) {
            const from = parseWarsaw(f.from);
            if (from === null) return `Niepoprawna data "from": "${f.from}". Format: YYYY-MM-DD lub YYYY-MM-DDTHH:MM (czas warszawski).`;
            parts.push(`${alias}.created_at >= ?`);
            params.push(from);
        }
        if (f.to) {
            const to = parseWarsaw(f.to, true);
            if (to === null) return `Niepoprawna data "to": "${f.to}". Format: YYYY-MM-DD lub YYYY-MM-DDTHH:MM (czas warszawski).`;
            parts.push(`${alias}.created_at < ?`);
            params.push(to);
        }

        const hidden = this.excludedClause(alias);
        return { sql: `AND ${parts.join(" AND ")} ${hidden.sql}`, params: [...params, ...hidden.params] };
    }

    private render(rows: any[], limit: number, terms: string[] = []): QueryResult {
        const overLimit = rows.length > limit;
        const channelNames = new Map<string, string>();
        const nameOf = (id: string) => {
            if (!channelNames.has(id)) {
                const r = this.db.prepare("SELECT name FROM channels WHERE id = ?").get(id) as { name: string | null } | undefined;
                channelNames.set(id, r?.name ?? id);
            }
            return channelNames.get(id)!;
        };

        const guild = this.guildId?.();
        const messages: HistoryMessage[] = [];
        let chars = 0;
        let budgetHit = false;
        for (const r of rows.slice(0, limit)) {
            const text = this.cleanText(renderBody({ content: r.content, embedsText: r.embeds_text, attachmentsText: r.attachments_text }));
            const clipped = clip(text, terms);
            const time = formatWarsaw(r.created_at);
            const [y, mo, d, hm] = time.split(/[. ]/);
            const message: HistoryMessage = {
                id: r.id,
                channel: nameOf(r.channel_id),
                author: r.author_id === this.selfId ? "Marvin" : mapGlobalNameNameToRealName[r.author_name],
                time,
                text: clipped,
                ...(guild ? { cite: `[${d}.${mo}.${y} ${hm}](<https://discord.com/channels/${guild}/${r.channel_id}/${r.id}>)` } : null),
            };
            const size = JSON.stringify(message).length;
            if (chars + size > LIMITS.totalChars) { budgetHit = true; break; }
            chars += size;
            messages.push(message);
        }
        return { timezone: WARSAW_TZ, count: messages.length, truncated: overLimit || budgetHit, messages };
    }

    /** Replaces `<@id>` / `<@!id>` mentions with names and `<#id>` with channel names. */
    private cleanText(text: string): string {
        return text
            .replace(/<@!?(\d+)>/g, (_, id: string) => {
                if (id === this.selfId) return "@Marvin";
                const r = this.db.prepare("SELECT author_name FROM messages WHERE author_id = ? LIMIT 1").get(id) as { author_name: string } | undefined;
                return `@${r ? mapGlobalNameNameToRealName[r.author_name] : "ktoś"}`;
            })
            .replace(/<#(\d+)>/g, (_, id: string) => {
                const r = this.db.prepare("SELECT name FROM channels WHERE id = ?").get(id) as { name: string | null } | undefined;
                return `#${r?.name ?? "kanał"}`;
            });
    }
}
