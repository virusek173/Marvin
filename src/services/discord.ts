import dotenv from "dotenv";
import {
    exceptionHandler,
    mapGlobalNameNameToRealName,
    stripImages,
    stripLeadingTimestampPrefix,
    parseContextTimestamp,
    splitForDiscord,
    moveCitesToLineStart,
} from "../utils/helpers.js";
import { Message, OpenAi, ToolSpec } from "../services/openai.js";
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
    getMarvinMotivationSystemPrompt,
    getPerplexityToMarvinResponsePrompt,
    getProfileSystemPrompt,
    getAuthorProfilePrompt,
    getMonthlyReportSystemPrompt,
    WAKE_UP_MESSAGE_PROMPT,
    HISTORY_TOOLS_PROMPT,
    getArchiveRangePrompt
} from "../utils/prompts.js";
import { CustomEmoji, getEmojiReactionSystemPrompt, isReactable, parseEmojiChoice, shouldRollReaction, isMissingPermission, addReaction } from "../utils/emojiReaction.js";
import { DECIDER_MODEL_NAME, SHORT_REACTION_MODEL_NAME, SERVER_SUMMARY_MODEL_NAME, PROFILE_MODEL_NAME } from "../utils/consts.js";
import { extractUrls, scrapeUrl } from "./scraper.js";
import { MessageArchive, getExcludedChannelIds, HISTORY_DB_FILE } from "./history/archive.js";
import { HistoryQuery } from "./history/query.js";
import { buildHistoryTools } from "./history/tools.js";
import { formatImageDescriptions, collectReactions } from "./history/mapper.js";
import { INTERNET_NOTICE, isTechnicalMarvinContent } from "./history/technical.js";
import { HistoryContext, renderLine } from "./history/context.js";
import { HistorySync } from "./history/sync.js";
import { ProfileService } from "./history/profiles.js";
import { ReportMonth, REPORT_MIN_MESSAGES, collectMonthlyReport, parseMonthKey, renderReportBlock, reportFacts } from "./history/report.js";
import { DiscordJsSource } from "./history/discordSource.js";
import { historyLog } from "./history/log.js";

dotenv.config();
const {
    DISCORD_CLIENT_TOKEN,
    CHANNEL_ID,
    BOTS_CHANNEL_ID,
    MARVIN_ID,
    MARVIN_USERNAME,
    TEST_WEBHOOK_AS_HUMAN,
    HOMAR_ID,
    JACEK_ID,
    DOMIN_ID,
    MARIUSZ_ID,
    WIKTOR_ID,
    MADZIA_ID,
    MASON_ID,
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
    "MugdaId": MUGDA_ID || '',
    "WibotId": WIBOT_ID || '',
}

const EXCLUDED_CHANNEL_IDS = getExcludedChannelIds();
const openai = new OpenAi();
const grok = new Grok();
const decider = new OpenAi();
const perplexity = new Perplexity();
const MODEL = openai;
const botExchangeCounters = new Map<string, number>();
const BOT_EXCHANGE_LIMIT = 2;
const SERVER_SUMMARY_FALLBACK_DAYS = 3;
const SERVER_SUMMARY_MAX_MESSAGES = 1500;
const BOT_EXHAUSTED_REPLY = "Mam Cię dość. Nie pisz do mnie więcej.";

/**
 * Main Discord bot service. Handles:
 * - Bot initialization and login
 * - Sending a short wake-up message on "ready"
 * - Routing incoming messages to the appropriate AI service (MARVIN or PERPLEXITY)
 *
 * Message routing logic:
 * 1. Every message is archived in the SQLite history; the context is read back from it (ContextService is only an in-memory fallback)
 * 2. If the message mentions Marvin (@Marvin or reply), the decider model classifies it
 * 3. PERPLEXITY: fetches web data first, then asks MODEL to rephrase the result
 * 4. MARVIN: answers directly using conversation context + system prompt
 */
export class DiscordServce {
    private client: any;
    private fallbackContext: ContextService;
    private historyContext: HistoryContext;
    private archive: MessageArchive;
    private historySync: HistorySync | null = null;
    private historyQuery: HistoryQuery | null = null;
    private historyTools: ToolSpec[] = [];
    private profilesRunning = false;
    private emojiReactionsDisabled = false;

    constructor() {
        this.fallbackContext = new ContextService({});
        this.archive = MessageArchive.open({
            selfId: MARVIN_ID,
            selfUsername: MARVIN_USERNAME,
            excludedChannelIds: EXCLUDED_CHANNEL_IDS,
        });
        this.historyContext = new HistoryContext(this.archive.database, this.fallbackContext, EXCLUDED_CHANNEL_IDS, MARVIN_ID);
        this.openHistoryTools();

        const clientService = new ClientService();
        this.client = clientService.getClient();

        this.client.on("ready", async () => {
            const channel = this.client.channels.cache.get(CHANNEL_ID);
            try {
                console.log(`Logged in as ${this.client.user.tag}!`);

                this.startHistorySync();
                void this.updateProfiles();
                const forcedMonth = parseMonthKey(process.env.MONTHLY_REPORT_FORCE_MONTH ?? "");
                if (forcedMonth) void this.sendMonthlyReport(forcedMonth);

                const wakeUpMessage = await MODEL.interact(WAKE_UP_MESSAGE_PROMPT);
                channel.send(wakeUpMessage?.content ?? "Wstałem.");
            } catch (error: any) {
                return exceptionHandler(error, channel)
            };
        });

        this.client.on("messageCreate", async (message: any) => {
            if (message.author.username === MARVIN_USERNAME) {
                this.archive.archive(message);
                this.pushMarvinToFallback(message);
                return;
            }

            const channelId = message?.channelId;
            const imageDescriptions = await this.describeImages(message);
            this.archive.archive(message, imageDescriptions);
            const userResponse = await this.userResponseFactory(message, imageDescriptions);
            this.fallbackContext.pushWithLimit(userResponse, channelId);

            const isMentioned = message.content.includes(MARVIN_ID) ||
                message.mentions?.repliedUser?.username === MARVIN_USERNAME;

            // Staging only: lets scripts/staging-ask.mjs (a channel webhook) test the full human flow.
            const isTestWebhook = TEST_WEBHOOK_AS_HUMAN === "true" && !!message.webhookId;
            if (message.author.bot && !isTestWebhook) {
                if (isMentioned) await this.handleBotMessage(message);
                return;
            }

            botExchangeCounters.delete(channelId);

            if (isMentioned) await this.handleMentioned(message);
            else void this.maybeReactWithEmoji(message);
        });

        for (const event of ["messageReactionAdd", "messageReactionRemove", "messageReactionRemoveEmoji"]) {
            this.client.on(event, (reaction: any) => void this.refreshReactions(reaction?.message));
        }
        this.client.on("messageReactionRemoveAll", (message: any) => void this.refreshReactions(message));

        this.client.login(DISCORD_CLIENT_TOKEN);
    }

    /** Re-reads the reactions of an archived message after someone added or removed one. Messages not in the archive are skipped; the backfill brings their reactions. */
    private async refreshReactions(message: any): Promise<void> {
        const db = this.archive.database;
        if (!db || !message?.id || !db.hasMessage(message.id)) return;
        try {
            const full = message.partial ? await message.fetch() : message;
            const reactions = collectReactions(full);
            if (reactions) db.setReactions(full.id, reactions);
        } catch (error: any) {
            historyLog.warn(`reakcje wiadomości ${message.id} nie zaktualizowane: ${error?.message}`);
        }
    }

    /** Gives the model read-only history tools over a separate readonly connection; without an archive Marvin simply has no tools. */
    private openHistoryTools() {
        if (!this.archive.database) return;
        try {
            this.historyQuery = new HistoryQuery(HISTORY_DB_FILE, {
                excludedChannelIds: EXCLUDED_CHANNEL_IDS,
                selfId: MARVIN_ID,
                guildId: () => this.client.guilds.cache.first()?.id,
            });
            this.historyTools = buildHistoryTools(this.historyQuery);
        } catch (error: any) {
            historyLog.error("nie udało się otworzyć połączenia do odczytu historii — Marvin bez narzędzi historii", error);
        }
    }

    /**
     * Writes/refreshes the generated person profiles (opt-in via PROFILES_ENABLED=true). Safe to call often: people whose
     * profile is younger than a week or who wrote too little since are skipped. Never throws.
     */
    async updateProfiles() {
        const db = this.archive.database;
        if (!db || process.env.PROFILES_ENABLED !== "true" || this.profilesRunning) return;
        this.profilesRunning = true;
        try {
            const service = new ProfileService(db, {
                excludedChannelIds: EXCLUDED_CHANNEL_IDS,
                selfId: MARVIN_ID,
                systemPrompt: getProfileSystemPrompt(),
                ask: async (system, user) => {
                    const response = await MODEL.contextInteract([
                        MODEL.messageFactory(system, 'system'),
                        MODEL.messageFactory(user),
                    ], PROFILE_MODEL_NAME);
                    return typeof response?.content === "string" ? response.content : null;
                },
            });
            await service.updateAll();
        } catch (error: any) {
            historyLog.error("aktualizacja profili osób nie powiodła się", error);
        } finally {
            this.profilesRunning = false;
        }
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
        const textContent = `${realName} (${timestamp}): ${message.content}`;

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
    getSystemContext(withHistoryTools: boolean = false, authorProfile: string = ''): Message {
        const date = new DateService().getFormattedDate();
        const prompt = getMarvinMotivationSystemPrompt(date, peopleMap) + (withHistoryTools ? HISTORY_TOOLS_PROMPT + this.getArchiveRangePrompt() : '') + authorProfile;
        return MODEL.messageFactory(prompt, 'system');
    }

    /** Prompt line with the date the archive starts, or '' when unknown (the model is then told to read it from get_stats). */
    private getArchiveRangePrompt(): string {
        try {
            const start = this.historyQuery?.archiveStart();
            return start ? getArchiveRangePrompt(start) : '';
        } catch (error: any) {
            console.log("err (początek archiwum): ", error?.message);
            return '';
        }
    }

    /** Prompt fragment with the generated profile of the message's author, or '' when there is none (profiles off, not yet generated). */
    private getAuthorProfile(message: any): string {
        try {
            if (!this.historyQuery) return '';
            const name = mapGlobalNameNameToRealName[message.author.globalName];
            const found = this.historyQuery.profiles(name).profiles[0];
            return found ? getAuthorProfilePrompt(found.name, found.profile) : '';
        } catch (error) {
            console.warn("Nie udało się wczytać profilu autora:", error);
            return '';
        }
    }

    /** Keeps the in-memory fallback context (used only when the archive is unavailable or the channel is excluded) in step. */
    private pushMarvinToFallback(message: any) {
        if (!message.content || isTechnicalMarvinContent(message.content)) return;
        const timestamp = new DateService(message.createdAt).getFormattedDateTime();
        this.fallbackContext.pushWithLimit(
            MODEL.messageFactory(`Marvin (${timestamp}): ${message.content}`, 'assistant'),
            message.channelId
        );
    }

    /** Context of the message's channel. Catches the archive up on the first use of a channel after startup. */
    private async getContext(message: any): Promise<Message[]> {
        const parentId = message.channel?.isThread?.() ? message.channel.parentId : null;
        await this.historySync?.ensureChannelFresh(message.channelId, parentId);
        return this.historyContext.getContext(message.channelId, parentId, message.id);
    }

    /** Rarely (EMOJI_REACTION_CHANCE) adds one emoji reaction to a human message, judged from that single message. Never throws into the message flow. */
    private async maybeReactWithEmoji(message: any) {
        if (this.emojiReactionsDisabled || !shouldRollReaction() || !isReactable(message.content)) return;
        try {
            const customEmojis: CustomEmoji[] = [...(message.guild?.emojis?.cache?.values() ?? [])]
                .filter((emoji: any) => emoji.available !== false)
                .map((emoji: any) => ({ id: emoji.id, name: emoji.name }));
            const response = await MODEL.contextInteract([
                MODEL.messageFactory(getEmojiReactionSystemPrompt(customEmojis), "system"),
                MODEL.messageFactory(`${mapGlobalNameNameToRealName[message.author.globalName]}: ${message.content}`),
            ], SHORT_REACTION_MODEL_NAME);
            const emoji = parseEmojiChoice(response?.content, customEmojis);
            if (emoji) await addReaction(message, emoji);
        } catch (error: any) {
            if (isMissingPermission(error)) {
                this.emojiReactionsDisabled = true;
                console.log("Brak uprawnienia Add Reactions — reakcje emoji wyłączone do restartu.");
                return;
            }
            console.log("err (reakcja emoji): ", error?.message);
        }
    }

    /** Handles a message from another bot. Responds up to BOT_EXCHANGE_LIMIT times per channel, then sends a generated closing line and goes silent until a human resets the counter. */
    async handleBotMessage(message: any) {
        const { channelId } = message;
        const count = botExchangeCounters.get(channelId) ?? 0;
        if (count >= BOT_EXCHANGE_LIMIT) return;

        botExchangeCounters.set(channelId, count + 1);
        if (count + 1 === BOT_EXCHANGE_LIMIT) {
            let content = BOT_EXHAUSTED_REPLY;
            try {
                const response = await MODEL.contextInteract([
                    MODEL.messageFactory(getBotExchangeExhaustedSystemPrompt(), 'system'),
                    ...stripImages(await this.getContext(message)),
                ], SHORT_REACTION_MODEL_NAME);
                if (response) content = stripLeadingTimestampPrefix(response.content);
            } catch (error: any) {
                console.log("err: ", error?.message);
            }
            message.reply(content.substring(0, 1950));
            return;
        }

        await this.handleMentioned(message);
    }

    /** Posts a digest of recent activity across all tracked channels to the bots channel. Triggered on a cron schedule (see index.ts), not by individual messages. */
    async sendServerSummary(since?: Date) {
        const channel = this.client.channels.cache.get(BOTS_CHANNEL_ID);
        if (!channel) return;

        try {
            const combinedText = this.collectSummaryText(since);
            if (!combinedText) return;

            channel.sendTyping();
            const response = await MODEL.contextInteract([
                MODEL.messageFactory(getServerSummarySystemPrompt(), 'system'),
                MODEL.messageFactory(`Historia ostatnich wiadomości z serwera:\n${combinedText}`),
            ], SERVER_SUMMARY_MODEL_NAME);

            if (response) {
                const content = stripLeadingTimestampPrefix(response.content);
                for (const part of splitForDiscord(content)) await channel.send(part);
            }
        } catch (error: any) {
            return exceptionHandler(error, channel);
        }
    }

    /**
     * Posts the statistics report for one calendar month to the bots channel: Marvin's commentary (model) followed by
     * bar charts built from exact counts. Returns true when something was posted; a month with too few messages is skipped.
     */
    async sendMonthlyReport(month: ReportMonth): Promise<boolean> {
        const channel = this.client.channels.cache.get(BOTS_CHANNEL_ID);
        if (!channel || !this.historyQuery) return false;

        try {
            const data = collectMonthlyReport(this.historyQuery, month);
            if (data.total < REPORT_MIN_MESSAGES) {
                historyLog.info(`raport ${month.key}: tylko ${data.total} wiadomości — pomijam`);
                return false;
            }

            channel.sendTyping();
            const response = await MODEL.contextInteract([
                MODEL.messageFactory(getMonthlyReportSystemPrompt(), 'system'),
                MODEL.messageFactory(reportFacts(data)),
            ], SERVER_SUMMARY_MODEL_NAME);
            const commentary = typeof response?.content === "string" ? stripLeadingTimestampPrefix(response.content).trim() : "";

            const text = [`📊 **Statystyki serwera — ${month.label}**`, commentary, renderReportBlock(data)].filter(Boolean).join("\n\n");
            for (const part of splitForDiscord(text)) await channel.send(part);
            historyLog.info(`raport ${month.key}: wysłano (${data.total} wiadomości)`);
            return true;
        } catch (error: any) {
            exceptionHandler(error, channel);
            return false;
        }
    }

    /** Messages since `since` (default: the last SERVER_SUMMARY_FALLBACK_DAYS days), grouped per channel, one line each. */
    private collectSummaryText(since?: Date): string {
        const sinceMs = Math.floor((since?.getTime() ?? Date.now() - SERVER_SUMMARY_FALLBACK_DAYS * 86_400_000) / 60000) * 60000;
        const db = this.archive.database;
        if (db) {
            try {
                const byChannel = new Map<string, string[]>();
                for (const m of db.getSince(sinceMs, EXCLUDED_CHANNEL_IDS, SERVER_SUMMARY_MAX_MESSAGES)) {
                    byChannel.set(m.channelId, [...(byChannel.get(m.channelId) ?? []), renderLine(m, MARVIN_ID)]);
                }
                return [...byChannel.values()].flat().join('\n');
            } catch (error: any) {
                historyLog.error("odczyt wiadomości do podsumowania z bazy nie powiódł się — używam pamięci", error);
            }
        }
        return Object.entries(this.fallbackContext.getContextMap())
            .filter(([channelId]) => !EXCLUDED_CHANNEL_IDS.includes(channelId))
            .flatMap(([, messages]) => stripImages(messages))
            .map(m => (typeof m.content === 'string' ? m.content : ''))
            .filter(text => {
                const sentAt = parseContextTimestamp(text);
                return !!sentAt && sentAt.getTime() > sinceMs;
            })
            .join('\n');
    }

    /** Handles a message that directly mentions or replies to Marvin. Routes to MARVIN or PERPLEXITY. */
    async handleMentioned(message: any) {
        try {
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
            const context = stripImages(await this.getContext(message));
            const historyUrls = context.flatMap(msg =>
                typeof msg.content === 'string' ? extractUrls(msg.content) : []
            );
            const urls = [...new Set([...currentUrls, ...historyUrls])].slice(0, 5);
            const scrapedParts = (await Promise.all(urls.map(scrapeUrl))).filter(Boolean) as string[];
            const scrapedContext: Message[] = scrapedParts.length > 0
                ? [MODEL.messageFactory(`Zawartość stron z wiadomości użytkownika:\n${scrapedParts.join('\n\n---\n\n')}`)]
                : [];

            const authorProfile = this.getAuthorProfile(message);

            const deciderResponse = await decider.contextInteract([
                MODEL.messageFactory(DECIDER_SYSTEM_PROMPT, 'system'),
                ...context,
            ], DECIDER_MODEL_NAME);

            if (deciderResponse.content.includes('PERPLEXITY')) {
                message.reply(INTERNET_NOTICE);
                const { message: perplexityResponse } = await perplexity.contextInteract(context);
                console.log(`perplexityResponse: ${perplexityResponse.content}`);
                message.channel.sendTyping();

                const userRequest = MODEL.messageFactory(getPerplexityToMarvinResponsePrompt(perplexityResponse.content));
                assResponse = await MODEL.contextInteract([
                    this.getSystemContext(false, authorProfile),
                    ...context,
                    ...scrapedContext,
                    userRequest,
                ]);
            } else {
                if (this.historyQuery && this.historyTools.length > 0) {
                    assResponse = await MODEL.contextInteractWithTools(
                        [this.getSystemContext(true, authorProfile), ...context, ...scrapedContext],
                        buildHistoryTools(this.historyQuery.scoped(message.id)),
                        { onRound: () => message.channel.sendTyping() }
                    );
                } else {
                    assResponse = await MODEL.contextInteract([
                        this.getSystemContext(false, authorProfile),
                        ...context,
                        ...scrapedContext,
                    ]);
                }
            }

            if (assResponse) {
                const content = stripLeadingTimestampPrefix(assResponse.content ?? "");
                if (!content.trim()) throw new Error("Model zwrócił pustą odpowiedź");
                const [first, ...rest] = splitForDiscord(moveCitesToLineStart(content));
                await message.reply(first);
                for (const part of rest) await message.channel.send(part);
            }
        } catch (error: any) {
            return exceptionHandler(error, message);
        }
    }

    destroy() {
        this.historySync?.stop();
        this.historyQuery?.close();
        this.client.destroy();
    }
}
