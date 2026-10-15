import { HistoryDb } from "./db.js";
import { formatVoiceTranscripts, isVoiceAttachment } from "./mapper.js";
import { historyLog } from "./log.js";
import { isPermanentError, describeError } from "./sync.js";
import { transcribeVoiceAttachment, Transcribe, Download } from "../voice.js";

/** Fetch-only access to one Discord message (the stored attachment links expire, so the message is read again for a fresh one). */
export interface MessageFetcher {
    fetchMessage(channelId: string, messageId: string): Promise<any>;
}

export interface VoiceBackfillOptions {
    excludedChannelIds: string[];
    /** Messages handled per run; the rest waits for the next run. */
    perRun?: number;
    /** Transient failures of one message before it gets a final "could not transcribe" marker. */
    maxAttempts?: number;
    download?: Download;
    sleep?: (ms: number) => Promise<void>;
    pauseMs?: number;
}

export interface VoiceBackfillSummary {
    found: number;
    transcribed: number;
    final: number;
    retryLater: number;
}

const FAILED_TEXT = formatVoiceTranscripts(["[nie udało się przepisać]"]);
const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Transcribes voice messages that were archived without a transcript (history backfill, or the feature was off when they
 * were sent). Sequential and paced; stored rows are rewritten in place, so a finished message is never picked again.
 */
export class VoiceBackfill {
    private running = false;
    private timer: NodeJS.Timeout | null = null;
    private readonly attempts = new Map<string, number>();
    private readonly perRun: number;
    private readonly maxAttempts: number;
    private readonly pauseMs: number;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(private db: HistoryDb, private source: MessageFetcher, private transcribe: Transcribe, private options: VoiceBackfillOptions) {
        this.perRun = options.perRun ?? 300;
        this.maxAttempts = options.maxAttempts ?? 3;
        this.pauseMs = options.pauseMs ?? 500;
        this.sleep = options.sleep ?? defaultSleep;
    }

    /** First run after `delayMs` (the history sync is busy at startup), then hourly. */
    start(delayMs: number = 2 * 60 * 1000, intervalMs: number = 60 * 60 * 1000): void {
        setTimeout(() => void this.runOnce(), delayMs).unref?.();
        this.timer = setInterval(() => void this.runOnce(), intervalMs);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    async runOnce(): Promise<VoiceBackfillSummary> {
        const summary: VoiceBackfillSummary = { found: 0, transcribed: 0, final: 0, retryLater: 0 };
        if (this.running) return summary;
        this.running = true;
        try {
            let afterSeq = 0;
            while (summary.found < this.perRun) {
                const batch = this.db.listUntranscribedVoice(afterSeq, Math.min(50, this.perRun - summary.found), this.options.excludedChannelIds);
                if (batch.length === 0) break;
                for (const row of batch) {
                    afterSeq = row.seq;
                    summary.found++;
                    const outcome = await this.handle(row.id, row.channelId);
                    summary[outcome]++;
                    await this.sleep(this.pauseMs);
                }
            }
            if (summary.found > 0) {
                historyLog.info(`głosówki z historii: przepisane ${summary.transcribed}, zamknięte bez przepisu ${summary.final}, do ponowienia ${summary.retryLater}`);
            }
        } catch (error: any) {
            historyLog.error("przepisywanie głosówek z historii nie powiodło się", describeError(error), error?.stack);
        } finally {
            this.running = false;
        }
        return summary;
    }

    private async handle(id: string, channelId: string): Promise<"transcribed" | "final" | "retryLater"> {
        let message: any;
        try {
            message = await this.source.fetchMessage(channelId, id);
        } catch (error: any) {
            if (isPermanentError(error)) {
                this.db.setVoiceTranscript(id, FAILED_TEXT);
                return "final";
            }
            historyLog.warn(`głosówka ${id}: nie udało się pobrać wiadomości (${describeError(error)})`);
            return this.failedAttempt(id);
        }

        const voices = [...(message?.attachments?.values() ?? [])].filter(isVoiceAttachment);
        if (voices.length === 0) {
            this.db.setVoiceTranscript(id, FAILED_TEXT);
            return "final";
        }
        const texts: string[] = [];
        for (const att of voices) {
            const outcome = await transcribeVoiceAttachment(att, this.transcribe, this.options.download);
            if (outcome.transient) return this.failedAttempt(id);
            texts.push(outcome.text);
        }
        this.attempts.delete(id);
        this.db.setVoiceTranscript(id, formatVoiceTranscripts(texts));
        return "transcribed";
    }

    private failedAttempt(id: string): "final" | "retryLater" {
        const attempts = (this.attempts.get(id) ?? 0) + 1;
        if (attempts < this.maxAttempts) {
            this.attempts.set(id, attempts);
            return "retryLater";
        }
        this.attempts.delete(id);
        this.db.setVoiceTranscript(id, FAILED_TEXT);
        return "final";
    }
}
