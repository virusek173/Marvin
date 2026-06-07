import { Message, ContentPart } from "./openai";
import * as fs from "fs";

type Messages = Array<Message>;
type ContextMap = Record<string, Messages>;

/**
 * Manages per-channel conversation history for the Discord bot.
 * Each channel has an independent message array (max 30 messages by default, FIFO).
 * Context is persisted to disk via `saveContextToFile` and restored on bot startup via `loadContextFromFile`.
 */
export class ContextService {
    private contextMap: ContextMap;

    constructor(initContextMap: ContextMap) {
        this.contextMap = initContextMap;
    }

    /** Returns 'global' if channelId is falsy — used as a fallback key in contextMap. */
    ensureProperChannel(channelId?: string) {
        if (!channelId) {
            return 'global'
        }
        return channelId;
    }

    /** Initializes an empty message array for a channel if it doesn't exist yet. */
    ensureChannelExists(channelId: string) {
        if (!this.contextMap[channelId]) {
            this.contextMap[channelId] = [];
        }
    }

    /**
     * Appends a message to a channel's context, removing the oldest if at capacity.
     * Default limit is 30 messages (higher than the global pushWithLimit default of 10).
     *
     * @param message - The message object to store (OpenAI format: {role, content})
     * @param _channelId - Discord channel ID; falls back to 'global' if undefined
     * @param limit - Max messages to keep per channel (default: 30)
     */
    pushWithLimit(message: any, _channelId?: string, limit: number = 30) {
        const channelId = this.ensureProperChannel(_channelId);
        this.ensureChannelExists(channelId);
        const context = this.contextMap[channelId];
        if (context.length >= limit) {
            context.shift();
        }

        context.push(message);

        this.contextMap[channelId] = context;
    }

    setContext(contextMap: any, _channelId?: string) {
        const channelId = this.ensureProperChannel(_channelId);
        this.ensureChannelExists(channelId);
        this.contextMap[channelId] = contextMap;
    }

    getContext(_channelId?: string) {
        const channelId = this.ensureProperChannel(_channelId);
        this.ensureChannelExists(channelId);
        return this.contextMap[channelId];
    }

    loadContextFromFile = (fileName: string) => {
        try {
            if (fs.existsSync(fileName)) {
                const contextData = fs.readFileSync(fileName, "utf8");
                const contextMap = JSON.parse(contextData);

                this.setContextMap(contextMap);
            } else {
                this.setContextMap({});
            }
        } catch (error) {
            console.error("Error reading context file:", error);
            this.setContextMap({});
        }
    };

    private sanitizeForPersistence(message: Message): Message {
        if (!Array.isArray(message.content)) return message;
        const parts = message.content as ContentPart[];
        const textParts = parts.filter(p => p.type === 'text').map(p => (p as any).text as string);
        const imageCount = parts.filter(p => p.type === 'image_url').length;
        const imageNote = imageCount > 0 ? (imageCount > 1 ? ` [${imageCount} obrazy]` : ' [obraz]') : '';
        return { ...message, content: textParts.join(' ') + imageNote };
    }

    saveContextToFile = (
        fileName: string,
    ): void => {
        try {
            const sanitized: Record<string, Message[]> = {};
            for (const [channelId, messages] of Object.entries(this.contextMap)) {
                sanitized[channelId] = messages.map(m => this.sanitizeForPersistence(m));
            }
            const contextJson = JSON.stringify(sanitized, null, 2);
            fs.writeFileSync(fileName, contextJson);
        } catch (error) {
            console.error("Error writing context file:", error);
        }
    };

    getContextMap() {
        return this.contextMap;
    }

    setContextMap(contextMap: any) {
        this.contextMap = contextMap;
    }
}