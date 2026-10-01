import dotenv from "dotenv";
import {
    exceptionHandler,
    mapGlobalNameNameToRealName,
    stripImages,
    stripLeadingTimestampPrefix,
    parseContextTimestamp,
} from "../utils/helpers.js";
import { Message, OpenAi } from "../services/openai.js";
import { DateService } from "./date.js";
import { ClientService } from "./client.js";
import { ContextService } from "./context.js";
import { Perplexity } from "./perplexity.js";
import { Grok } from "./grok.js";
import {
    DECIDER_SYSTEM_PROMPT,
    IMAGE_LAZY_REPLIES,
    getServerSummarySystemPrompt,
    getBotExchangeExhaustedSystemPrompt,
    getShortReactionSystemPrompt,
    getMarvinMotivationSystemPrompt,
    getPerplexityToMarvinResponsePrompt,
    WAKE_UP_MESSAGE_PROMPT
} from "../utils/prompts.js";
import { DECIDER_MODEL_NAME, SHORT_REACTION_MODEL_NAME, SERVER_SUMMARY_MODEL_NAME } from "../utils/consts.js";
import { extractUrls, scrapeUrl } from "./scraper.js";
import { MessageArchive, getExcludedChannelIds } from "./history/archive.js";
import { formatImageDescriptions } from "./history/mapper.js";
import { INTERNET_NOTICE, linksNotice } from "./history/technical.js";
import { HistorySync } from "./history/sync.js";
import { DiscordJsSource } from "./history/discordSource.js";
import { historyLog } from "./history/log.js";

dotenv.config();
const {
    DISCORD_CLIENT_TOKEN,
    CHANNEL_ID,
    BOTS_CHANNEL_ID,
    MARVIN_ID,
    MARVIN_USERNAME,
    HOMAR_ID,
    JACEK_ID,
    DOMIN_ID,
    MARIUSZ_ID,
    WIKTOR_ID,
    MADZIA_ID,
    MASON_ID,
    PODSUMOWUS_ID,
    MUGDA_ID,
    WIBOT_ID
} = process.env;

const peopleMap = {
    "MarvinId": MARVIN_ID || '',
    "HomarId": HOMAR_ID || '',
    "JacekId": JACEK_ID || '',
    "DominId": DOMIN_ID || '',
    "MariuszId": MARIUSZ_ID || '',
    "WiktorId": WIKTOR_ID || '',
    "MadziaId": MADZIA_ID || '',
    "MasonId": MASON_ID || '',
    "PodsumowusId": PODSUMOWUS_ID || '',
    "MugdaId": MUGDA_ID || '',
    "WibotId": WIBOT_ID || '',
}

const EXCLUDED_CHANNEL_IDS = getExcludedChannelIds();
const openai = new OpenAi();
const grok = new Grok();
const decider = new OpenAi();
const perplexity = new Perplexity();
const MODEL = openai;
const SHORT_REACTION_CHANCE = 0.01;
const SHORT_REACTION_COOLDOWN = 30;
let shortReactionCooldownCounter = 0;
const botExchangeCounters = new Map<string, number>();
const BOT_EXCHANGE_LIMIT = 2;
const BOT_EXHAUSTED_REPLY = "Mam Cię dość. Nie pisz do mnie więcej.";

/**
 * Main Discord bot service. Handles:
 * - Bot initialization and login
 * - Sending a short wake-up message on "ready"
 * - Routing incoming messages to the appropriate AI service (MARVIN or PERPLEXITY)
 *
 * Message routing logic:
 * 1. All non-bot messages are stored in context (ContextService)
 * 2. If the message mentions Marvin (@Marvin or reply), the decider model classifies it
 * 3. PERPLEXITY: fetches web data first, then asks MODEL to rephrase the result
 * 4. MARVIN: answers directly using conversation context + system prompt
 */
export class DiscordServce {
    private client: any;
    private contextService: ContextService;
    private archive: MessageArchive;
    private historySync: HistorySync | null = null;

    constructor() {
        const contextService = new ContextService({})
        this.contextService = contextService;
        this.archive = MessageArchive.open({
            selfId: MARVIN_ID,
            selfUsername: MARVIN_USERNAME,
            excludedChannelIds: EXCLUDED_CHANNEL_IDS,
        });

        const clientService = new ClientService();
        this.client = clientService.getClient();

        this.client.on("ready", async () => {
            const channel = this.client.channels.cache.get(CHANNEL_ID);
            try {
                console.log(`Logged in as ${this.client.user.tag}!`);

                contextService.loadContextFromFile("data/context.json");
                this.startHistorySync();

                const wakeUpMessage = await MODEL.interact(WAKE_UP_MESSAGE_PROMPT);
                channel.send(wakeUpMessage?.content ?? "Wstałem.");
            } catch (error: any) {
                return exceptionHandler(error, channel)
            };
        });

        this.client.on("messageCreate", async (message: any) => {
            if (message.author.username === MARVIN_USERNAME) {
                this.archive.archive(message);
                return;
            }

            const channelId = message?.channelId;
            const imageDescriptions = await this.describeImages(message);
            this.archive.archive(message, imageDescriptions);
            const userResponse = await this.userResponseFactory(message, imageDescriptions);
            contextService.pushWithLimit(userResponse, channelId);

            const isMentioned = message.content.includes(MARVIN_ID) ||
                message.mentions?.repliedUser?.username === MARVIN_USERNAME;

            if (message.author.bot) {
                if (isMentioned) await this.handleBotMessage(message, contextService);
                return;
            }

            botExchangeCounters.delete(channelId);

            if (shortReactionCooldownCounter > 0) shortReactionCooldownCounter -= 1;

            const shortReactionRoll = !isMentioned && Math.random() < SHORT_REACTION_CHANCE;

            if (shortReactionRoll && shortReactionCooldownCounter === 0) {
                shortReactionCooldownCounter = SHORT_REACTION_COOLDOWN;
                await this.handleShortReaction(message, contextService);
            } else if (isMentioned) {
                await this.handleMentioned(message, contextService);
            }
        });

        this.client.login(DISCORD_CLIENT_TOKEN);
    }

    /** Backfill/catch-up reads the whole server history, so it is opt-in via HISTORY_SYNC_ENABLED=true. */
    private startHistorySync() {
        const db = this.archive.database;
        if (!db) return;
        if (process.env.HISTORY_SYNC_ENABLED !== "true") {
            historyLog.info("synchronizacja historii wyłączona (ustaw HISTORY_SYNC_ENABLED=true, żeby włączyć)");
            return;
        }
        this.historySync = new HistorySync(db, new DiscordJsSource(this.client), {
            excludedChannelIds: EXCLUDED_CHANNEL_IDS,
            selfId: MARVIN_ID,
            selfUsername: MARVIN_USERNAME,
        });
        this.historySync.start();
    }

    /**
     * Converts a Discord message into a context-ready Message object.
     * Prepends the sender's real name (from mapGlobalNameNameToRealName) to the content.
     * Example: "zoltymason: hej co słychać" → {role: 'user', content: 'Mason: hej co słychać'}
     */
    async userResponseFactory(message: any, imageDescriptions?: string[]) {
        const realName = mapGlobalNameNameToRealName[message.author.globalName];
        const timestamp = new DateService(message.createdAt).getFormattedDateTime();
        const textContent = `[${timestamp}] ${realName}: ${message.content}`;

        const descriptions = imageDescriptions ?? await this.describeImages(message);
        if (descriptions.length > 0) {
            return MODEL.messageFactory(`${textContent} ${formatImageDescriptions(descriptions)}`);
        }

        return MODEL.messageFactory(textContent);
    }

    /** One text description per image attachment (vision model); empty array when there are no images. */
    async describeImages(message: any): Promise<string[]> {
        const imageAttachments = [...(message.attachments?.values() ?? [])].filter(
            (att: any) => att.contentType?.startsWith('image/')
        );
        return Promise.all(imageAttachments.map((att: any) => MODEL.describeImage(att.url)));
    }

    /** Built per request so the date in the prompt is never stale. */
    getSystemContext(): Message {
        const date = new DateService().getFormattedDate();
        return MODEL.messageFactory(getMarvinMotivationSystemPrompt(date, peopleMap), 'system');
    }

    marvinResponseFactory(content: string) {
        const timestamp = new DateService().getFormattedDateTime();
        return MODEL.messageFactory(`[${timestamp}] Marvin: ${content}`, 'assistant');
    }

    /** Handles a message from another bot. Responds up to BOT_EXCHANGE_LIMIT times per channel, then sends a generated closing line and goes silent until a human resets the counter. */
    async handleBotMessage(message: any, contextService: ContextService) {
        const { channelId } = message;
        const count = botExchangeCounters.get(channelId) ?? 0;
        if (count >= BOT_EXCHANGE_LIMIT) return;

        botExchangeCounters.set(channelId, count + 1);
        if (count + 1 === BOT_EXCHANGE_LIMIT) {
            let content = BOT_EXHAUSTED_REPLY;
            try {
                const response = await MODEL.contextInteract([
                    MODEL.messageFactory(getBotExchangeExhaustedSystemPrompt(), 'system'),
                    ...stripImages(contextService.getContext(channelId)),
                ], SHORT_REACTION_MODEL_NAME);
                if (response) content = stripLeadingTimestampPrefix(response.content);
            } catch (error: any) {
                console.log("err: ", error?.message);
            }
            message.reply(content.substring(0, 1950));
            contextService.pushWithLimit(this.marvinResponseFactory(content), channelId);
            contextService.saveContextToFile("data/context.json");
            return;
        }

        await this.handleMentioned(message, contextService);
    }

    /** Posts a digest of recent activity across all tracked channels to the bots channel. Triggered on a cron schedule (see index.ts), not by individual messages. */
    async sendServerSummary(since?: Date) {
        const channel = this.client.channels.cache.get(BOTS_CHANNEL_ID);
        if (!channel) return;

        try {
            const combinedText = Object.entries(this.contextService.getContextMap())
                .filter(([channelId]) => !EXCLUDED_CHANNEL_IDS.includes(channelId))
                .flatMap(([, messages]) => stripImages(messages))
                .map(m => (typeof m.content === 'string' ? m.content : ''))
                .filter(Boolean)
                .filter(text => {
                    if (!since) return true;
                    const sentAt = parseContextTimestamp(text);
                    const sinceMinute = Math.floor(since.getTime() / 60000) * 60000;
                    return !!sentAt && sentAt.getTime() > sinceMinute;
                })
                .join('\n');

            if (!combinedText) return;

            channel.sendTyping();
            const response = await MODEL.contextInteract([
                MODEL.messageFactory(getServerSummarySystemPrompt(), 'system'),
                MODEL.messageFactory(`Historia ostatnich wiadomości z serwera:\n${combinedText}`),
            ], SERVER_SUMMARY_MODEL_NAME);

            if (response) {
                const content = stripLeadingTimestampPrefix(response.content);
                this.contextService.pushWithLimit(this.marvinResponseFactory(content), BOTS_CHANNEL_ID);
                channel.send(content.substring(0, 1950));
                this.contextService.saveContextToFile("data/context.json");
            }
        } catch (error: any) {
            return exceptionHandler(error, channel);
        }
    }

    /** Responds with a short (≤4 word) AI-generated reaction based on the last message in context. */
    async handleShortReaction(message: any, contextService: ContextService) {
        try {
            message.channel.sendTyping();
            const response = await MODEL.contextInteract([
                MODEL.messageFactory(getShortReactionSystemPrompt(), 'system'),
                ...stripImages(contextService.getContext(message.channelId)),
            ], SHORT_REACTION_MODEL_NAME);
            if (response) {
                const content = stripLeadingTimestampPrefix(response.content);
                contextService.pushWithLimit(this.marvinResponseFactory(content), message.channelId);
                message.reply(content.substring(0, 1950));
                contextService.saveContextToFile("data/context.json");
            }
        } catch (error: any) {
            return exceptionHandler(error, message);
        }
    }

    /** Handles a message that directly mentions or replies to Marvin. Routes to MARVIN or PERPLEXITY. */
    async handleMentioned(message: any, contextService: ContextService) {
        try {
            const { channelId } = message;
            let assResponse = null;

            const hasImages = [...(message.attachments?.values() ?? [])].some(
                (att: any) => att.contentType?.startsWith('image/')
            );
            if (hasImages && Math.random() < 0.25) {
                const reply = IMAGE_LAZY_REPLIES[Math.floor(Math.random() * IMAGE_LAZY_REPLIES.length)];
                message.reply(reply);
                return;
            }

            message.channel.sendTyping();

            const currentUrls = extractUrls(message.content);
            const historyUrls = contextService.getContext(channelId).flatMap(msg =>
                typeof msg.content === 'string' ? extractUrls(msg.content) : []
            );
            const urls = [...new Set([...currentUrls, ...historyUrls])].slice(0, 5);
            const scrapedParts = (await Promise.all(urls.map(scrapeUrl))).filter(Boolean) as string[];
            if (scrapedParts.length > 0) {
                message.reply(linksNotice(scrapedParts.length));
                message.channel.sendTyping();
            }
            const scrapedContext: Message[] = scrapedParts.length > 0
                ? [MODEL.messageFactory(`Zawartość stron z wiadomości użytkownika:\n${scrapedParts.join('\n\n---\n\n')}`)]
                : [];

            const deciderResponse = await decider.contextInteract([
                MODEL.messageFactory(DECIDER_SYSTEM_PROMPT, 'system'),
                ...stripImages(contextService.getContext(channelId)),
            ], DECIDER_MODEL_NAME);

            if (deciderResponse.content.includes('PERPLEXITY')) {
                message.reply(INTERNET_NOTICE);
                const { message: perplexityResponse } = await perplexity.contextInteract(stripImages(contextService.getContext(channelId)));
                console.log(`perplexityResponse: ${perplexityResponse.content}`);
                message.channel.sendTyping();

                const userRequest = MODEL.messageFactory(getPerplexityToMarvinResponsePrompt(perplexityResponse.content));
                assResponse = await MODEL.contextInteract([
                    this.getSystemContext(),
                    ...stripImages(contextService.getContext(channelId)),
                    ...scrapedContext,
                    userRequest,
                ]);
            } else {
                assResponse = await MODEL.contextInteract([
                    this.getSystemContext(),
                    ...stripImages(contextService.getContext(channelId)),
                    ...scrapedContext,
                ]);
            }

            if (assResponse) {
                const content = stripLeadingTimestampPrefix(assResponse.content);
                contextService.pushWithLimit(this.marvinResponseFactory(content), channelId);
                message.reply(content.substring(0, 1950));
            }
            contextService.saveContextToFile("data/context.json");
        } catch (error: any) {
            return exceptionHandler(error, message);
        }
    }

    destroy() {
        this.historySync?.stop();
        this.client.destroy();
    }
}
