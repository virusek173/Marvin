import { HistoryDb } from "./db.js";
import { buildArchiveRow } from "./mapper.js";
import { historyLog } from "./log.js";

export const HISTORY_DB_FILE = "data/history.db";

const splitIds = (value: string | undefined): string[] =>
    (value ?? "").split(",").map(id => id.trim()).filter(Boolean);

/** EXCLUDED_CHANNEL_IDS, plus the legacy SUMMARY_EXCLUDED_CHANNEL_IDS until it is removed from .env. */
export const getExcludedChannelIds = (env: NodeJS.ProcessEnv = process.env): string[] =>
    [...new Set([...splitIds(env.EXCLUDED_CHANNEL_IDS), ...splitIds(env.SUMMARY_EXCLUDED_CHANNEL_IDS)])];

export interface ArchiveOptions {
    selfId?: string;
    selfUsername?: string;
    excludedChannelIds: string[];
}

/** Live write path: stores every incoming message. Never throws, so a DB failure cannot block replies. */
export class MessageArchive {
    private excluded: Set<string>;

    constructor(private db: HistoryDb | null, private options: ArchiveOptions) {
        this.excluded = new Set(options.excludedChannelIds);
    }

    static open(options: ArchiveOptions, file: string = HISTORY_DB_FILE): MessageArchive {
        try {
            const db = new HistoryDb(file);
            const purged = db.purgeChannels(options.excludedChannelIds);
            historyLog.info(`baza otwarta: ${file}, wiadomości: ${db.countMessages()}, wykluczone kanały: ${options.excludedChannelIds.length}` +
                (purged > 0 ? `, usunięto z bazy ${purged} wiadomości z wykluczonych kanałów` : ""));
            return new MessageArchive(db, options);
        } catch (error: any) {
            historyLog.error(`nie udało się otworzyć bazy ${file} — archiwum wyłączone`, error);
            return new MessageArchive(null, options);
        }
    }

    get database(): HistoryDb | null {
        return this.db;
    }

    isExcluded(channelId: string, parentId?: string | null): boolean {
        return this.excluded.has(channelId) || (!!parentId && this.excluded.has(parentId));
    }

    archive(message: any, imageDescriptions?: string[]): void {
        if (!this.db) return;
        try {
            const row = buildArchiveRow(message, { ...this.options, imageDescriptions });
            if (this.isExcluded(row.channelId, row.parentId)) return;
            this.db.insertLive(row);
            this.db.upsertChannel(row.channelId, message.channel?.name ?? null, row.parentId);
        } catch (error: any) {
            historyLog.error(`zapis wiadomości ${message?.id} (kanał ${message?.channelId}) nie powiódł się`, error);
        }
    }
}
