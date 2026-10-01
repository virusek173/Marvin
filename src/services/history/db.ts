import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { ArchiveRow } from "./mapper.js";

/** SQLite's unicode61 folds diacritics but not "ł", so it is folded by hand on both the index and query side. */
export const foldForSearch = (text: string): string => text.replace(/ł/g, "l").replace(/Ł/g, "L");

const FTS_BODY = `replace(replace(trim(new.content || ' ' || new.embeds_text || ' ' || new.attachments_text), 'ł', 'l'), 'Ł', 'L')`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    channel_id TEXT NOT NULL,
    parent_id TEXT,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    is_bot INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL DEFAULT '',
    embeds_text TEXT NOT NULL DEFAULT '',
    attachments_text TEXT NOT NULL DEFAULT '',
    reply_to_id TEXT,
    type INTEGER NOT NULL DEFAULT 0,
    is_technical INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_author_time ON messages(author_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(created_at);

CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT,
    parent_id TEXT,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
    channel_id TEXT PRIMARY KEY,
    cursor TEXT,
    last_attempt_at INTEGER,
    last_success_at INTEGER,
    last_error TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(body, tokenize = 'unicode61 remove_diacritics 2');

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, body) VALUES (new.seq, ${FTS_BODY});
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.seq;
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.seq;
    INSERT INTO messages_fts(rowid, body) VALUES (new.seq, ${FTS_BODY});
END;
`;

const toParams = (row: ArchiveRow) => ({
    id: row.id,
    channelId: row.channelId,
    parentId: row.parentId,
    authorId: row.authorId,
    authorName: row.authorName,
    isBot: row.isBot ? 1 : 0,
    content: row.content,
    embedsText: row.embedsText,
    attachmentsText: row.attachmentsText,
    replyToId: row.replyToId,
    type: row.type,
    isTechnical: row.isTechnical ? 1 : 0,
    createdAt: row.createdAt,
});

const INSERT_COLUMNS = `(id, channel_id, parent_id, author_id, author_name, is_bot, content, embeds_text,
    attachments_text, reply_to_id, type, is_technical, created_at)
    VALUES (@id, @channelId, @parentId, @authorId, @authorName, @isBot, @content, @embedsText,
    @attachmentsText, @replyToId, @type, @isTechnical, @createdAt)`;

export interface StoredMessage {
    id: string;
    channelId: string;
    authorId: string;
    authorName: string;
    isBot: boolean;
    content: string;
    embedsText: string;
    attachmentsText: string;
    createdAt: number;
}

const STORED_COLUMNS = `id, channel_id, author_id, author_name, is_bot, content, embeds_text, attachments_text, created_at`;
const HAS_TEXT = `(content != '' OR embeds_text != '' OR attachments_text != '')`;

const toStored = (r: any): StoredMessage => ({
    id: r.id,
    channelId: r.channel_id,
    authorId: r.author_id,
    authorName: r.author_name,
    isBot: !!r.is_bot,
    content: r.content,
    embedsText: r.embeds_text,
    attachmentsText: r.attachments_text,
    createdAt: r.created_at,
});

export interface SyncState {
    cursor: string | null;
    lastAttemptAt: number | null;
    lastSuccessAt: number | null;
    lastError: string | null;
}

export class HistoryDb {
    readonly db: Database.Database;
    private upsertLiveStmt: Database.Statement;
    private upsertChannelStmt: Database.Statement;
    private insertIgnoreStmt: Database.Statement;
    private upsertCursorStmt: Database.Statement;
    private writePageTx: (channelId: string, rows: ArchiveRow[], cursor: string | null) => number;

    constructor(file: string) {
        if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new Database(file);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = NORMAL");
        this.db.pragma("busy_timeout = 5000");
        this.db.exec(SCHEMA);

        // The live row is the richer one (image descriptions), so it overwrites a backfilled marker row.
        this.upsertLiveStmt = this.db.prepare(`
            INSERT INTO messages ${INSERT_COLUMNS}
            ON CONFLICT(id) DO UPDATE SET
                content = excluded.content,
                embeds_text = excluded.embeds_text,
                attachments_text = excluded.attachments_text,
                is_technical = excluded.is_technical`);
        this.upsertChannelStmt = this.db.prepare(`
            INSERT INTO channels (id, name, parent_id, updated_at) VALUES (@id, @name, @parentId, @updatedAt)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id,
                updated_at = excluded.updated_at`);
        this.insertIgnoreStmt = this.db.prepare(`INSERT OR IGNORE INTO messages ${INSERT_COLUMNS}`);
        this.upsertCursorStmt = this.db.prepare(`
            INSERT INTO sync_state (channel_id, cursor, last_attempt_at, last_success_at, last_error)
            VALUES (@channelId, @cursor, @now, @now, NULL)
            ON CONFLICT(channel_id) DO UPDATE SET cursor = excluded.cursor,
                last_success_at = excluded.last_success_at, last_error = NULL`);
        this.writePageTx = this.db.transaction((channelId: string, rows: ArchiveRow[], cursor: string | null) => {
            let inserted = 0;
            for (const row of rows) inserted += this.insertIgnoreStmt.run(toParams(row)).changes;
            if (cursor !== null) {
                const current = this.getSyncState(channelId)?.cursor;
                const furthest = current && BigInt(current) > BigInt(cursor) ? current : cursor;
                this.upsertCursorStmt.run({ channelId, cursor: furthest, now: Date.now() });
            }
            return inserted;
        });
    }

    /**
     * Inserts a page of fetched messages (existing ids are left untouched) and, when a cursor is given, advances
     * the channel's cursor in the same transaction. The cursor never moves backwards. Returns the new row count.
     */
    writePage(channelId: string, rows: ArchiveRow[], cursor: string | null): number {
        return this.writePageTx(channelId, rows, cursor);
    }

    getSyncState(channelId: string): SyncState | undefined {
        const r = this.db
            .prepare("SELECT cursor, last_attempt_at, last_success_at, last_error FROM sync_state WHERE channel_id = ?")
            .get(channelId) as any;
        return r && { cursor: r.cursor, lastAttemptAt: r.last_attempt_at, lastSuccessAt: r.last_success_at, lastError: r.last_error };
    }

    markAttempt(channelId: string): void {
        this.db.prepare(`INSERT INTO sync_state (channel_id, last_attempt_at) VALUES (?, ?)
            ON CONFLICT(channel_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at`).run(channelId, Date.now());
    }

    markSuccess(channelId: string): void {
        this.db.prepare(`INSERT INTO sync_state (channel_id, last_success_at) VALUES (?, ?)
            ON CONFLICT(channel_id) DO UPDATE SET last_success_at = excluded.last_success_at, last_error = NULL`)
            .run(channelId, Date.now());
    }

    markError(channelId: string, error: string): void {
        this.db.prepare(`INSERT INTO sync_state (channel_id, last_attempt_at, last_error) VALUES (?, ?, ?)
            ON CONFLICT(channel_id) DO UPDATE SET last_error = excluded.last_error`)
            .run(channelId, Date.now(), error.substring(0, 1000));
    }

    insertLive(row: ArchiveRow): void {
        this.upsertLiveStmt.run(toParams(row));
    }

    upsertChannel(id: string, name: string | null, parentId: string | null): void {
        this.upsertChannelStmt.run({ id, name, parentId, updatedAt: Date.now() });
    }

    hasMessage(id: string): boolean {
        return !!this.db.prepare("SELECT 1 FROM messages WHERE id = ?").get(id);
    }

    /** Newest `limit` non-technical messages of a channel, oldest first. */
    getRecentForContext(channelId: string, limit: number): StoredMessage[] {
        const rows = this.db
            .prepare(`SELECT ${STORED_COLUMNS} FROM messages
                WHERE channel_id = ? AND is_technical = 0 AND ${HAS_TEXT}
                ORDER BY created_at DESC, CAST(id AS INTEGER) DESC LIMIT ?`)
            .all(channelId, limit);
        return rows.map(toStored).reverse();
    }

    /** Newest `limit` non-technical messages newer than `sinceMs` outside the excluded channels, oldest first. */
    getSince(sinceMs: number, excludedChannelIds: string[], limit: number): StoredMessage[] {
        const marks = excludedChannelIds.map(() => "?").join(",");
        const notExcluded = excludedChannelIds.length
            ? `AND channel_id NOT IN (${marks}) AND (parent_id IS NULL OR parent_id NOT IN (${marks}))`
            : "";
        const rows = this.db
            .prepare(`SELECT ${STORED_COLUMNS} FROM messages
                WHERE created_at > ? AND is_technical = 0 AND ${HAS_TEXT} ${notExcluded}
                ORDER BY created_at DESC, CAST(id AS INTEGER) DESC LIMIT ?`)
            .all(sinceMs, ...excludedChannelIds, ...excludedChannelIds, limit);
        return rows.map(toStored).reverse();
    }

    countMessages(): number {
        return (this.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
    }

    /** Removes everything stored for the given channels and their threads. Returns the number of deleted messages. */
    purgeChannels(channelIds: string[]): number {
        if (channelIds.length === 0) return 0;
        const marks = channelIds.map(() => "?").join(",");
        const run = this.db.transaction(() => {
            const deleted = this.db
                .prepare(`DELETE FROM messages WHERE channel_id IN (${marks}) OR parent_id IN (${marks})`)
                .run(...channelIds, ...channelIds).changes;
            this.db.prepare(`DELETE FROM sync_state WHERE channel_id IN (SELECT id FROM channels WHERE parent_id IN (${marks}))`)
                .run(...channelIds);
            this.db.prepare(`DELETE FROM channels WHERE id IN (${marks}) OR parent_id IN (${marks})`)
                .run(...channelIds, ...channelIds);
            this.db.prepare(`DELETE FROM sync_state WHERE channel_id IN (${marks})`).run(...channelIds);
            return deleted;
        });
        return run();
    }

    close(): void {
        this.db.close();
    }
}
