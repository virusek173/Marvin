import { HistoryDb, StoredMessage } from "./db.js";
import { ContextService } from "../context.js";
import { Message } from "../openai.js";
import { DateService } from "../date.js";
import { mapGlobalNameNameToRealName } from "../../utils/helpers.js";
import { historyLog } from "./log.js";

export const CONTEXT_LIMIT = 30;

/** Text body of a stored message: content, then embeds, then attachment descriptions. */
export const renderBody = (m: Pick<StoredMessage, "content" | "embedsText" | "attachmentsText">): string =>
    [m.content, m.embedsText, m.attachmentsText].filter(Boolean).join(" ");

/** "[YYYY.MM.DD HH:MM] Name: text" — the line format the model has always seen in its context. */
export const renderLine = (m: StoredMessage, selfId?: string): string => {
    const name = m.authorId === selfId ? "Marvin" : mapGlobalNameNameToRealName[m.authorName];
    return `[${new DateService(m.createdAt).getFormattedDateTime()}] ${name}: ${renderBody(m)}`;
};

export const toContextMessage = (m: StoredMessage, selfId?: string): Message => ({
    role: m.authorId === selfId ? "assistant" : "user",
    content: renderLine(m, selfId),
});

/**
 * Conversation context for the model. Reads the last messages of a channel from the archive; excluded channels
 * (never archived) and any database failure fall back to the in-memory FIFO.
 */
export class HistoryContext {
    private excluded: Set<string>;

    constructor(
        private db: HistoryDb | null,
        private fallback: ContextService,
        excludedChannelIds: string[],
        private selfId?: string,
        private limit: number = CONTEXT_LIMIT
    ) {
        this.excluded = new Set(excludedChannelIds);
    }

    /** `currentMessageId` must be in the archive, otherwise the archive write failed and the FIFO is used instead. */
    getContext(channelId: string, parentId?: string | null, currentMessageId?: string): Message[] {
        if (!this.db || this.excluded.has(channelId) || (!!parentId && this.excluded.has(parentId))) {
            return this.fallback.getContext(channelId);
        }
        try {
            if (currentMessageId && !this.db.hasMessage(currentMessageId)) {
                historyLog.error(`wiadomość ${currentMessageId} nie ma w bazie (kanał ${channelId}) — kontekst z pamięci`);
                return this.fallback.getContext(channelId);
            }
            return this.db.getRecentForContext(channelId, this.limit).map(m => toContextMessage(m, this.selfId));
        } catch (error: any) {
            historyLog.error(`odczyt kontekstu kanału ${channelId} nie powiódł się — kontekst z pamięci`, error);
            return this.fallback.getContext(channelId);
        }
    }
}
