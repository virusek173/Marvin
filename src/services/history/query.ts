import Database from "better-sqlite3";
import { foldForSearch } from "./db.js";
import { mapGlobalNameNameToRealName } from "../../utils/helpers.js";
import { formatWarsaw, parseWarsaw, WARSAW_TZ } from "./time.js";
import { renderBody } from "./context.js";

export const LIMITS = {
    searchDefault: 10,
    searchMax: 25,
    rangeDefault: 50,
    rangeMax: 100,
    aroundMax: 15,
    textChars: 500,
    totalChars: 30000,
    queryTokens: 8,
};

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
export const buildFtsQuery = (text: string): string | null => {
    const tokens = searchTokens(text);
    return tokens.length ? tokens.map(t => `"${t}"*`).join(" ") : null;
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
    if (first < LIMITS.textChars - 80) return `${text.substring(0, LIMITS.textChars)}…`;
    const start = Math.max(0, first - 150);
    const end = start + LIMITS.textChars;
    return `…${text.substring(start, end)}${end < text.length ? "…" : ""}`;
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

    search(args: QueryFilters & { query: string; limit?: number }): QueryResult {
        const fts = buildFtsQuery(args.query ?? "");
        if (!fts) return this.empty("Puste zapytanie — podaj co najmniej jedno słowo do wyszukania.");
        const limit = clamp(args.limit, LIMITS.searchDefault, LIMITS.searchMax);
        const filter = this.filters(args, "m");
        if (typeof filter === "string") return this.empty(filter);
        const rows = this.db
            .prepare(`SELECT m.* FROM messages_fts f JOIN messages m ON m.seq = f.rowid
                WHERE messages_fts MATCH ? ${filter.sql}
                ORDER BY bm25(messages_fts), m.created_at DESC LIMIT ?`)
            .all(fts, ...filter.params, limit + 1);
        return this.render(rows as any[], limit, searchTokens(args.query));
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
        const bind = { t: anchor.created_at, n: BigInt(anchor.id), c: anchor.channel_id };
        const prior = this.db
            .prepare(`SELECT * FROM (SELECT m.* FROM messages m WHERE m.channel_id = @c AND m.is_technical = 0 AND ${key}
                ORDER BY m.created_at DESC, CAST(m.id AS INTEGER) DESC LIMIT ${before}) m ${order}`)
            .all(bind);
        const next = this.db
            .prepare(`SELECT m.* FROM messages m WHERE m.channel_id = @c AND m.is_technical = 0 AND ${keyAfter}
                ${order} LIMIT ${after}`)
            .all(bind);
        return this.render([...prior, anchor, ...next] as any[], before + after + 1);
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
    private excludedClause(alias: string, idColumn = "channel_id"): { sql: string; params: string[] } {
        if (this.excluded.length === 0) return { sql: "", params: [] };
        const marks = this.excluded.map(() => "?").join(",");
        return {
            sql: `AND ${alias}.${idColumn} NOT IN (${marks}) AND (${alias}.parent_id IS NULL OR ${alias}.parent_id NOT IN (${marks}))`,
            params: [...this.excluded, ...this.excluded],
        };
    }

    /** WHERE fragment for author / channel / date filters; a string result is a message to show the model instead. */
    private filters(f: QueryFilters, alias: string): { sql: string; params: (string | number)[] } | string {
        const parts: string[] = [`${alias}.is_technical = 0`];
        const params: (string | number)[] = [];

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
