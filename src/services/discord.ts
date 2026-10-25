import dotenv from "dotenv";
import {
    exceptionHandler,
    mapGlobalNameNameToRealName,
    stripImages,
    stripLeadingTimestampPrefix,
    parseContextTimestamp,
    splitForDiscord,
    moveCitesToLineStart,
    shortenWebCitations,
    stripSystemIcons,
} from "../utils/helpers.js";
import type { PeopleMap } from "../utils/types.js";
import { Message, OpenAi, ToolSpec } from "../services/openai.js";
import { DateService } from "./date.js";
import { ClientService } from "./client.js";
import { ContextService } from "./context.js";
import {
    IMAGE_LAZY_REPLIES,
    getServerSummarySystemPrompt,
    getBotExchangeExhaustedSystemPrompt,
    getMarvinMotivationSystemPrompt,
    getProfileSystemPrompt,
    getAuthorProfilePrompt,
    getMonthlyReportSystemPrompt,
    getAirAlertSystemPrompt,
    WAKE_UP_MESSAGE_PROMPT,
    HISTORY_TOOLS_PROMPT,
    WEB_SEARCH_PROMPT,
    AIR_QUALITY_PROMPT,
    getArchiveRangePrompt,
    getReminderPrompt,
    getReminderCommentSystemPrompt,
    PromptProfile
} from "../utils/prompts.js";
import { CustomEmoji, getEmojiReactionSystemPrompt, isReactable, parseEmojiChoice, shouldRollReaction, isMissingPermission, addReaction } from "../utils/emojiReaction.js";
import { SHORT_REACTION_MODEL_NAME, SERVER_SUMMARY_MODEL_NAME, PROFILE_MODEL_NAME } from "../utils/consts.js";
import { buildWebTools } from "./webTools.js";
import { createAirQuality, translateLevel, type AirReading } from "./airQuality.js";
import { airSeverity, evaluateAirAlert, formatAirAlert, readAirAlertState, writeAirAlertState, type AirAlertAction } from "./airAlert.js";
import { RemindersDb, ReminderService, buildReminderTools, buildCommentInput, cleanReminderComment, reminderCalendar, formatWarsaw } from "./reminders.js";
import { extractUrls } from "./scraper.js";
import { MessageArchive, getExcludedChannelIds, HISTORY_DB_FILE } from "./history/archive.js";
import { HistoryQuery } from "./history/query.js";
import { buildHistoryTools } from "./history/tools.js";
import { formatImageDescriptions, formatVoiceTranscripts, collectReactions } from "./history/mapper.js";
import { transcribeVoiceMessages } from "./voice.js";
import { isTechnicalMarvinContent } from "./history/technical.js";
import { HistoryContext, renderLine } from "./history/context.js";
import { HistorySync } from "./history/sync.js";
import { VoiceBackfill } from "./history/voiceBackfill.js";
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
    VOICE_TRANSCRIPTION_ENABLED,
    VOICE_BACKFILL_ENABLED,
    AIR_QUALITY_ALERT_ENABLED,
    AIR_ALERT_CHANNEL_ID,
    AIR_QUALITY_ALERT_FORCE_LEVEL
} = process.env;

const PERSON_IDS_TTL_MS = 10 * 60 * 1000;

const EXCLUDED_CHANNEL_IDS = getExcludedChannelIds();
const openai = new OpenAi();
const MODEL = openai;
const airQualityTools = process.env.AIR_QUALITY_PAGE_URL ? createAirQuality(process.env.AIR_QUALITY_PAGE_URL) : null;
const botExchangeCounters = new Map<string, number>();
const BOT_EXCHANGE_LIMIT = 2;
const SERVER_SUMMARY_FALLBACK_DAYS = 3;
const SERVER_SUMMARY_MAX_MESSAGES = 1500;
const AIR_NO_DATA_LOG_AFTER_MS = 3 * 60 * 60 * 1000;
const BOT_EXHAUSTED_REPLY = "Mam Cię dość. Nie pisz do mnie więcej.";
const WEB_ANSWER_ICON = "🌐";
const LINK_ANSWER_ICON = "🔗";
const AIR_ANSWER_ICON = "📦";

/**
 * Main Discord bot service. Handles:
 * - Bot initialization and login
 * - Sending a short wake-up message on "ready"
 * - Answering mentions with one tool loop (archive tools + web search)
 *
 * Message routing logic:
 * 1. Every message is archived in the SQLite history; the context is read back from it (ContextService is only an in-memory fallback)
 * 2. If the message mentions Marvin (@Marvin or reply), MODEL answers from the context and calls the archive tools or web search when it needs them
 */
export class DiscordServce {
    private client: any;
    private fallbackContext: ContextService;
    private historyContext: HistoryContext;
    private archive: MessageArchive;
    private historySync: HistorySync | null = null;
    private voiceBackfill: VoiceBackfill | null = null;
    private historyQuery: HistoryQuery | null = null;
    private personIds: { ids: PeopleMap; at: number } | null = null;
    private historyTools: ToolSpec[] = [];
    private remindersDb: RemindersDb | null = null;
    private reminderService: ReminderService | null = null;
    private profilesRunning = false;
    private emojiReactionsDisabled = false;
    private airNoDataSince: number | null = null;
    private airNoDataLogged = false;

    constructor() {
        this.fallbackContext = new ContextService({});
        this.archive = MessageArchive.open({
            selfId: MARVIN_ID,
            selfUsername: MARVIN_USERNAME,
            excludedChannelIds: EXCLUDED_CHANNEL_IDS,
        });
        this.historyContext = new HistoryContext(this.archive.database, this.fallbackContext, EXCLUDED_CHANNEL_IDS, MARVIN_ID);
        this.openHistoryTools();
        this.openReminders();

        const clientService = new ClientService();
        this.client = clientService.getClient();

        this.client.on("ready", async () => {
            const channel = this.client.channels.cache.get(CHANNEL_ID);
            try {
                console.log(`Logged in as ${this.client.user.tag}!`);

                this.startHistorySync();
                this.startVoiceBackfill();
                void this.checkReminders();
                void this.updateProfiles();
                const forcedMonth = parseMonthKey(process.env.MONTHLY_REPORT_FORCE_MONTH ?? "");
                if (forcedMonth) void this.sendMonthlyReport(forcedMonth);
                if (AIR_QUALITY_ALERT_FORCE_LEVEL) void this.sendForcedAirAlert(AIR_QUALITY_ALERT_FORCE_LEVEL);

                const wakeUpMessage = await MODEL.interact(WAKE_UP_MESSAGE_PROMPT, undefined, false, "wake-up");
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
            const prepared = Promise.all([this.describeImages(message), this.transcribeVoices(message)]).then(([descriptions, transcripts]) => {
                this.archive.archive(message, descriptions, transcripts);
                return { descriptions, transcripts };
            });
            this.trackPendingArchive(channelId, prepared);
            const { descriptions: imageDescriptions, transcripts: voiceTranscripts } = await prepared;
            const userResponse = await this.userResponseFactory(message, imageDescriptions, voiceTranscripts);
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

    private pendingArchives = new Map<string, Set<Promise<unknown>>>();

    private trackPendingArchive(channelId: string, work: Promise<unknown>): void {
        let set = this.pendingArchives.get(channelId);
        if (!set) set = new Set<Promise<unknown>>();
        const settled = work.then(() => undefined, () => undefined).finally(() => {
            set.delete(settled);
            if (set.size === 0) this.pendingArchives.delete(channelId);
        });
        set.add(settled);
        this.pendingArchives.set(channelId, set);
    }

    /** A message with an image reaches the archive only after its description is ready; a question asked right after it must not build its context before that. */
    private async waitForPendingArchives(channelId: string): Promise<void> {
        const set = this.pendingArchives.get(channelId);
        if (set?.size) await Promise.all([...set]);
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

    /** Reminders live in their own SQLite file; without it Marvin simply has no reminder tools. */
    private openReminders() {
        try {
            this.remindersDb = new RemindersDb();
            this.reminderService = new ReminderService({
                db: this.remindersDb,
                log: message => console.log(`[reminders] ${message}`),
                send: async (channelId, content, userIds) => {
                    const channel = this.client.channels.cache.get(channelId) ?? await this.client.channels.fetch(channelId);
                    if (!channel?.send) throw new Error(`kanał ${channelId} niedostępny`);
                    await channel.send({ content, allowedMentions: { parse: [], users: userIds } });
                },
                comment: async (reminder, late) => {
                    const response = await MODEL.contextInteract([
                        MODEL.messageFactory(getReminderCommentSystemPrompt(), 'system'),
                        MODEL.messageFactory(buildCommentInput(reminder, late, Date.now())),
                    ], SERVER_SUMMARY_MODEL_NAME, false, "reminder");
                    return typeof response?.content === "string" ? cleanReminderComment(response.content) : null;
                },
            });
            this.reminderService.recover();
        } catch (error: any) {
            this.remindersDb = null;
            this.reminderService = null;
            console.error("[reminders] nie udało się otworzyć bazy przypomnień — Marvin bez przypomnień:", error?.message);
        }
    }

    /** Delivers the reminders that are due. Called every minute from index.ts; does nothing before the Discord client is ready. Never throws. */
    async checkReminders() {
        if (!this.reminderService || !this.client.isReady?.()) return;
        try {
            await this.reminderService.processDue();
        } catch (error: any) {
            console.error("[reminders] błąd przetwarzania:", error?.message);
        }
    }

    /** Reminder tools for one question, or none: no database, a bot author or an excluded channel (nothing from there is stored). */
    private buildReminderToolsFor(message: any): ToolSpec[] {
        if (!this.remindersDb) return [];
        const isTestWebhook = TEST_WEBHOOK_AS_HUMAN === "true" && !!message.webhookId;
        if (message.author?.bot && !isTestWebhook) return [];
        if (this.archive.isExcluded(message.channelId, message.channel?.parentId)) return [];
        return buildReminderTools({
            db: this.remindersDb,
            authorId: message.author.id,
            authorName: mapGlobalNameNameToRealName[message.author.globalName],
            channelId: message.channelId,
            sourceMessageId: message.id,
            personIds: () => this.getPersonIds(),
        });
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
                    ], PROFILE_MODEL_NAME, false, "profile");
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

    /** Transcribes voice messages already in the archive (costs API calls for the whole backlog), so it needs its own opt-in on top of VOICE_TRANSCRIPTION_ENABLED. */
    private startVoiceBackfill() {
        const db = this.archive.database;
        if (!db || VOICE_TRANSCRIPTION_ENABLED !== "true" || VOICE_BACKFILL_ENABLED !== "true") return;
        this.voiceBackfill = new VoiceBackfill(db, new DiscordJsSource(this.client), (audio, name, type) => MODEL.transcribeAudio(audio, name, type), {
            excludedChannelIds: EXCLUDED_CHANNEL_IDS,
        });
        this.voiceBackfill.start();
    }

    /**
     * Converts a Discord message into a context-ready Message object.
     * Prepends the sender's real name (from mapGlobalNameNameToRealName) to the content.
     * Example: "ewanick: hej co słychać" → {role: 'user', content: 'Ewa: hej co słychać'}
     */
    async userResponseFactory(message: any, imageDescriptions?: string[], voiceTranscripts: string[] = []) {
        const realName = mapGlobalNameNameToRealName[message.author.globalName];
        const timestamp = new DateService(message.createdAt).getFormattedDateTime();
        const textContent = `${realName} (${timestamp}): ${message.content}`;

        const descriptions = imageDescriptions ?? await this.describeImages(message);
        const attachmentsText = [
            descriptions.length > 0 ? formatImageDescriptions(descriptions) : "",
            voiceTranscripts.length > 0 ? formatVoiceTranscripts(voiceTranscripts) : "",
        ].filter(Boolean).join(" ");

        return MODEL.messageFactory(attachmentsText ? `${textContent} ${attachmentsText}` : textContent);
    }

    /** One text description per image attachment (vision model); empty array when there are no images. */
    async describeImages(message: any): Promise<string[]> {
        const imageAttachments = [...(message.attachments?.values() ?? [])].filter(
            (att: any) => att.contentType?.startsWith('image/')
        );
        return Promise.all(imageAttachments.map((att: any) => MODEL.describeImage(att.url)));
    }

    /** Transcripts of the message's voice attachments; opt-in, humans only, never for excluded channels (the audio would leave the server). */
    async transcribeVoices(message: any): Promise<string[]> {
        if (VOICE_TRANSCRIPTION_ENABLED !== "true" || message.author?.bot || this.archive.isExcluded(message.channelId, message.channel?.parentId)) return [];
        return transcribeVoiceMessages(message, (audio, name, type) => MODEL.transcribeAudio(audio, name, type));
    }

    /** Built per request so the date in the prompt is never stale. */
    getSystemContext(withHistoryTools: boolean = false, authorProfile: string = '', extraPrompt: string = ''): Message {
        const date = new DateService().getFormattedDate();
        const prompt = getMarvinMotivationSystemPrompt(date, MARVIN_ID, this.getPersonIds(), this.getKnownProfiles()) + WEB_SEARCH_PROMPT + (airQualityTools ? AIR_QUALITY_PROMPT : '') + (withHistoryTools ? HISTORY_TOOLS_PROMPT + this.getArchiveRangePrompt() : '') + extraPrompt + authorProfile;
        return MODEL.messageFactory(prompt, 'system');
    }

    /** Discord ids of people and bots by first name, read from the archive (cached; the query scans the author table). */
    private getPersonIds(): PeopleMap {
        if (this.personIds && Date.now() - this.personIds.at < PERSON_IDS_TTL_MS) return this.personIds.ids;
        try {
            const ids = this.historyQuery?.personIds() ?? {};
            this.personIds = { ids, at: Date.now() };
            return ids;
        } catch (error: any) {
            console.log("err (id osób): ", error?.message);
            return this.personIds?.ids ?? {};
        }
    }

    /** Generated profiles of everyone profiled so far (empty when profiles are off or the archive is unavailable). */
    private getKnownProfiles(): PromptProfile[] {
        try {
            return this.historyQuery?.profiles().profiles.map(p => ({ name: p.name, profile: p.profile })) ?? [];
        } catch (error: any) {
            console.log("err (profile osób): ", error?.message);
            return [];
        }
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
            ], SHORT_REACTION_MODEL_NAME, false, "reaction");
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
                ], undefined, false, "bot-exchange");
                if (response) content = stripLeadingTimestampPrefix(response.content);
            } catch (error: any) {
                console.log("err: ", error?.message);
            }
            message.reply(content.substring(0, 1950));
            return;
        }

        await this.handleMentioned(message);
    }

    /**
     * Cron (every 30 minutes, see index.ts): reads the air sensor and posts an alert to AIR_ALERT_CHANNEL_ID when the level is
     * BAD / VERY_BAD, and a note when it is back to normal (rules in airAlert.ts). No data means no post, only a log line after 3 h.
     */
    async checkAirAlert() {
        if (AIR_QUALITY_ALERT_ENABLED !== "true" || !airQualityTools || !AIR_ALERT_CHANNEL_ID) return;
        let current: AirReading;
        try {
            current = await airQualityTools.read();
            this.airNoDataSince = null;
            this.airNoDataLogged = false;
        } catch (error: any) {
            this.airNoDataSince ??= Date.now();
            if (!this.airNoDataLogged && Date.now() - this.airNoDataSince >= AIR_NO_DATA_LOG_AFTER_MS) {
                this.airNoDataLogged = true;
                console.log(`[powietrze] czujnik bez danych od ponad 3 godzin (${error?.message})`);
            }
            return;
        }
        try {
            const { state, action } = evaluateAirAlert(readAirAlertState(), current.levelCode, new Date());
            if (action && !(await this.postAirAlert(action, current))) return;
            writeAirAlertState(state);
        } catch (error: any) {
            console.log("err (alert powietrza): ", error?.message);
        }
    }

    /** Staging test (AIR_QUALITY_ALERT_FORCE_LEVEL): posts one alert (or "back to normal") with the real reading but the given level, ignoring state and hours. */
    private async sendForcedAirAlert(level: string) {
        if (!airQualityTools || !AIR_ALERT_CHANNEL_ID) return;
        try {
            const current = await airQualityTools.read();
            const levelCode = level.toUpperCase();
            const forced: AirReading = { levelCode, reading: { ...current.reading, airQualityLevel: translateLevel(levelCode) ?? levelCode } };
            await this.postAirAlert(airSeverity(levelCode) > 0 ? "alert" : "recovery", forced);
        } catch (error: any) {
            console.log("err (wymuszony alert powietrza): ", error?.message);
        }
    }

    /** Fixed text plus one sentence from Marvin (left out when the model fails). Returns false when nothing was posted. */
    private async postAirAlert(kind: Exclude<AirAlertAction, null>, current: AirReading): Promise<boolean> {
        const channel = this.client.channels.cache.get(AIR_ALERT_CHANNEL_ID);
        if (!channel) {
            console.log("[powietrze] nie widzę kanału AIR_ALERT_CHANNEL_ID — pomijam alert");
            return false;
        }
        const text = formatAirAlert(kind, current);
        let comment = "";
        try {
            const response = await MODEL.contextInteract([
                MODEL.messageFactory(getAirAlertSystemPrompt(kind), "system"),
                MODEL.messageFactory(text),
            ], SERVER_SUMMARY_MODEL_NAME, false, "alert");
            if (typeof response?.content === "string") comment = stripLeadingTimestampPrefix(response.content).trim().replace(/\s+/g, " ");
        } catch (error: any) {
            console.log("err (komentarz do alertu powietrza): ", error?.message);
        }
        await channel.send(comment ? `${text}\n\n${comment}` : text);
        console.log(`[powietrze] wysłano ${kind === "alert" ? "alert" : "wiadomość o powrocie do normy"} (${current.levelCode})`);
        return true;
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
            ], SERVER_SUMMARY_MODEL_NAME, false, "summary");

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
            ], SERVER_SUMMARY_MODEL_NAME, false, "report");
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

    /** Handles a message that directly mentions or replies to Marvin: one tool loop with the archive tools and web search. */
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

            await this.waitForPendingArchives(message.channelId);

            const context = stripImages(await this.getContext(message));

            const authorProfile = this.getAuthorProfile(message);

            let fetchedPage = false;
            let airData = false;
            const reminderTools = this.buildReminderToolsFor(message);
            const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
            try {
                const historyTools = this.historyQuery && this.historyTools.length > 0 ? this.historyQuery.scoped(message.id) : null;
                assResponse = await MODEL.contextInteractWithTools(
                    [this.getSystemContext(!!historyTools, authorProfile, reminderTools.length ? getReminderPrompt() : ''), ...context, MODEL.messageFactory(reminderTools.length ? reminderCalendar(Date.now()) : `Teraz jest ${formatWarsaw(Date.now())} (czas Warszawy).`, 'system')],
                    [...(historyTools ? buildHistoryTools(historyTools) : []), ...buildWebTools(() => { fetchedPage = true; }), ...(airQualityTools ? airQualityTools(() => { airData = true; }) : []), ...reminderTools],
                    { webSearch: true, kind: "question", requireTool: extractUrls(message.content ?? "").length > 0 ? "fetch_url" : undefined, onRound: () => message.channel.sendTyping() }
                );
                if (assResponse && historyTools) assResponse = { ...assResponse, content: historyTools.expandCites(assResponse.content ?? "") };
            } finally {
                clearInterval(typing);
            }

            if (assResponse) {
                const content = stripSystemIcons(stripLeadingTimestampPrefix(assResponse.content ?? ""));
                if (!content.trim()) throw new Error("Model zwrócił pustą odpowiedź");
                const icons = [assResponse.webSearch && WEB_ANSWER_ICON, fetchedPage && LINK_ANSWER_ICON, airData && AIR_ANSWER_ICON].filter(Boolean).join(" ");
                const body = shortenWebCitations(moveCitesToLineStart(content));
                const [first, ...rest] = splitForDiscord(icons ? `${icons} ${body}` : body);
                await message.reply(first);
                for (const part of rest) await message.channel.send(part);
            }
        } catch (error: any) {
            return exceptionHandler(error, message);
        }
    }

    destroy() {
        this.historySync?.stop();
        this.voiceBackfill?.stop();
        this.historyQuery?.close();
        this.remindersDb?.close();
        this.client.destroy();
    }
}
