import { HistoryDb } from "./db.js";
import { buildArchiveRow } from "./mapper.js";
import { historyLog } from "./log.js";

export interface ChannelInfo {
    id: string;
    name: string;
    parentId: string | null;
    kind: string;
}

/** Everything the syncer needs from Discord. Fetch-only, so a fake can stand in for it in tests. */
export interface DiscordSource {
    listChannels(): Promise<ChannelInfo[]>;
    /** Messages in any order. With `after`: the oldest page newer than that id. Without it: the newest page. */
    fetchPage(channelId: string, options: { after?: string; limit: number }): Promise<any[]>;
}

export interface SyncOptions {
    excludedChannelIds: string[];
    selfId?: string;
    selfUsername?: string;
    pageSize?: number;
    maxRetries?: number;
    retryBaseMs?: number;
    onDemandMaxPages?: number;
    sleep?: (ms: number) => Promise<void>;
    yieldToEventLoop?: () => Promise<void>;
}

export interface SyncSummary {
    skipped: boolean;
    channels: number;
    ok: number;
    failed: number;
    inserted: number;
    durationMs: number;
}

const compareIds = (a: string, b: string): number => {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
};

const PERMANENT_STATUSES = new Set([403, 404]);
// 10003 Unknown Channel, 50001 Missing Access, 50013 Missing Permissions
const PERMANENT_CODES = new Set([10003, 50001, 50013]);

export const isPermanentError = (error: any): boolean =>
    PERMANENT_STATUSES.has(error?.status) || PERMANENT_CODES.has(error?.code);

export const describeError = (error: any): string =>
    `${error?.name ?? "Error"} status=${error?.status ?? "-"} code=${error?.code ?? "-"}: ${error?.message ?? error}`;

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const defaultYield = () => new Promise<void>(resolve => setImmediate(resolve));

export class HistorySync {
    private running = false;
    private timer: NodeJS.Timeout | null = null;
    private readonly excluded: Set<string>;
    private readonly freshChannels = new Set<string>();
    private readonly pageSize: number;
    private readonly maxRetries: number;
    private readonly retryBaseMs: number;
    private readonly onDemandMaxPages: number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly yieldToEventLoop: () => Promise<void>;

    constructor(private db: HistoryDb, private source: DiscordSource, private options: SyncOptions) {
        this.excluded = new Set(options.excludedChannelIds);
        this.pageSize = options.pageSize ?? 100;
        this.maxRetries = options.maxRetries ?? 4;
        this.retryBaseMs = options.retryBaseMs ?? 1000;
        this.onDemandMaxPages = options.onDemandMaxPages ?? 3;
        this.sleep = options.sleep ?? defaultSleep;
        this.yieldToEventLoop = options.yieldToEventLoop ?? defaultYield;
    }

    /** Runs a full pass now, then repeats on an interval to heal events the gateway dropped. */
    start(intervalMs: number = 60 * 60 * 1000): void {
        void this.runAll("start");
        this.timer = setInterval(() => void this.runAll("cykliczne"), intervalMs);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private isExcluded(info: { id: string; parentId?: string | null }): boolean {
        return this.excluded.has(info.id) || (!!info.parentId && this.excluded.has(info.parentId));
    }

    /** One catch-up pass over every channel and thread. Overlapping runs are skipped. */
    async runAll(reason: string): Promise<SyncSummary> {
        const summary: SyncSummary = { skipped: false, channels: 0, ok: 0, failed: 0, inserted: 0, durationMs: 0 };
        if (this.running) {
            historyLog.warn(`synchronizacja (${reason}) pominięta: poprzednia jeszcze trwa`);
            return { ...summary, skipped: true };
        }
        this.running = true;
        const started = Date.now();
        try {
            historyLog.info(`synchronizacja start (${reason})`);
            let channels: ChannelInfo[];
            try {
                channels = await this.source.listChannels();
            } catch (error: any) {
                historyLog.error("nie udało się pobrać listy kanałów", describeError(error), error?.stack);
                return { ...summary, durationMs: Date.now() - started };
            }

            for (const info of channels) {
                if (this.isExcluded(info)) continue;
                summary.channels++;
                this.db.upsertChannel(info.id, info.name, info.parentId);
                try {
                    summary.inserted += await this.syncChannel(info);
                    summary.ok++;
                } catch (error: any) {
                    summary.failed++;
                    const state = this.db.getSyncState(info.id);
                    this.db.markError(info.id, describeError(error));
                    historyLog.error(
                        `kanał ${info.id} (#${info.name}) nie zsynchronizowany, kursor=${state?.cursor ?? "brak"}`,
                        describeError(error),
                        error?.stack
                    );
                }
            }
        } finally {
            this.running = false;
            summary.durationMs = Date.now() - started;
            historyLog.info(
                `synchronizacja koniec (${reason}): kanały=${summary.channels} ok=${summary.ok} błędy=${summary.failed} ` +
                `nowe wiadomości=${summary.inserted} czas=${summary.durationMs}ms`
            );
        }
        return summary;
    }

    /** Pages forward from the stored cursor. The cursor moves only together with a committed page. */
    private async syncChannel(info: { id: string; name?: string }, maxPages: number = Infinity): Promise<number> {
        const channelId = info.id;
        let cursor = this.db.getSyncState(channelId)?.cursor ?? "0";
        const firstImport = cursor === "0";
        this.db.markAttempt(channelId);

        let inserted = 0;
        let pages = 0;
        while (pages < maxPages) {
            const page = await this.fetchWithRetry(channelId, { after: cursor, limit: this.pageSize });
            if (page.length === 0) break;

            const sorted = [...page].sort((a, b) => compareIds(a.id, b.id));
            const rows = sorted.map(message => buildArchiveRow(message, this.options));
            const newest = sorted[sorted.length - 1].id;
            inserted += this.db.writePage(channelId, rows, newest);
            cursor = newest;
            pages++;

            if (pages % 10 === 0) {
                historyLog.info(`kanał ${channelId} (#${info.name ?? "?"}): ${pages} stron, +${inserted} wiadomości, kursor=${cursor}`);
            }
            await this.yieldToEventLoop();
        }

        this.db.markSuccess(channelId);
        if (inserted > 0 || firstImport) {
            historyLog.info(`kanał ${channelId} (#${info.name ?? "?"}): +${inserted} wiadomości, kursor=${cursor}`);
        }
        return inserted;
    }

    private async fetchWithRetry(channelId: string, options: { after?: string; limit: number }): Promise<any[]> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.source.fetchPage(channelId, options);
            } catch (error: any) {
                if (isPermanentError(error) || attempt >= this.maxRetries) throw error;
                const delay = this.retryBaseMs * 2 ** attempt;
                historyLog.warn(
                    `kanał ${channelId}: błąd przejściowy (${describeError(error)}), ponowienie ${attempt + 1}/${this.maxRetries} za ${delay}ms`
                );
                await this.sleep(delay);
            }
        }
    }

    /**
     * Called before Marvin first uses a channel after startup. Quickly catches the channel up; if the backfill has
     * not reached it yet, stores its newest messages without touching the cursor so the context is not empty.
     */
    async ensureChannelFresh(channelId: string, parentId?: string | null): Promise<void> {
        if (this.isExcluded({ id: channelId, parentId }) || this.freshChannels.has(channelId)) return;
        this.freshChannels.add(channelId);
        try {
            if (this.db.getSyncState(channelId)?.cursor) {
                await this.syncChannel({ id: channelId }, this.onDemandMaxPages);
            } else {
                const latest = await this.fetchWithRetry(channelId, { limit: this.pageSize });
                const inserted = this.db.writePage(channelId, latest.map(m => buildArchiveRow(m, this.options)), null);
                historyLog.info(`kanał ${channelId}: dogrywanie na żądanie bez kursora, +${inserted} najnowszych wiadomości`);
            }
        } catch (error: any) {
            this.freshChannels.delete(channelId);
            historyLog.error(`dogrywanie na żądanie kanału ${channelId} nie powiodło się`, describeError(error), error?.stack);
        }
    }
}
