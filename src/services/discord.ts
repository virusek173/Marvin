import dotenv from "dotenv";
import {
    exceptionHandler,
    mapGlobalNameNameToRealName,
} from "../utils/helpers.js";
import { ContentPart, Message, OpenAi } from "../services/openai.js";
import { DateService } from "./date.js";
import { ClientService } from "./client.js";
import { ContextService } from "./context.js";
import { Perplexity } from "./perplexity.js";
import { Grok } from "./grok.js";
import {
    DECIDER_SYSTEM_PROMPT,
    IMAGE_LAZY_REPLIES,
    getSpontaneousMotivationSystemPrompt,
    getShortReactionSystemPrompt,
    getFirstMotivionUserMessagePrompt,
    getMarvinMotivationSystemPrompt,
    getPerplexityToMarvinResponsePrompt
} from "../utils/prompts.js";
import { FIRST_MESSAGE_MODEL_NAME, SHORT_REACTION_MODEL_NAME, SPONTANEOUS_MODEL_NAME } from "../utils/consts.js";
import { extractUrls, scrapeUrl } from "./scraper.js";

dotenv.config();
const {
    DISCORD_CLIENT_TOKEN,
    CHANNEL_ID,
    MARVIN_ID,
    MARVIN_USERNAME,
    HOMAR_ID,
    JACEK_ID,
    DOMIN_ID,
    MARIUSZ_ID,
    WIKTOR_ID,
    MADZIA_ID,
    MASON_ID,
    PODSUMOWUS_ID
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
}

const DEFAULT_QUOTE = "Co żyje to żyje";
const openai = new OpenAi();
const grok = new Grok();
const decider = new OpenAi();
const perplexity = new Perplexity();
const MODEL = openai;
const SPONTANEOUS_CHANCE = 0.01;
const SPONTANEOUS_COOLDOWN = 60;
let spontaneousCooldownCounter = 0;
const SHORT_REACTION_CHANCE = 0.02;
const SHORT_REACTION_COOLDOWN = 30;
let shortReactionCooldownCounter = 0;
const botExchangeCounters = new Map<string, number>();
const BOT_EXCHANGE_LIMIT = 2;
const BOT_EXHAUSTED_REPLY = "Mam Cię dość. Nie pisz do mnie więcej.";

/**
 * Main Discord bot service. Handles:
 * - Bot initialization and login
 * - Sending a morning motivational message on "ready" (if withInitMessage=true)
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
    private date: string;
    private systemContext: Message;
    /**
     * @param _quote - Motivational quote for today's greeting message
     * @param withInitMessage - If false, bot starts silently (no morning message). Default: true.
     */
    constructor(_quote: string | undefined,
        withInitMessage: boolean = true) {
        const contextService = new ContextService({})

        const clientService = new ClientService();
        this.client = clientService.getClient();

        const date = new DateService();
        this.date = date.getFormattedDate();
        this.systemContext = MODEL.messageFactory(getMarvinMotivationSystemPrompt(this.date, peopleMap), 'system');

        const quote = _quote ? _quote : DEFAULT_QUOTE;
        console.log("Today's quote: ", quote);

        this.client.on("ready", async () => {
            const channel = this.client.channels.cache.get(CHANNEL_ID);
            try {
                console.log(`Logged in as ${this.client.user.tag}!`);

                contextService.loadContextFromFile("context.json");
                const firstUserMessage = MODEL.messageFactory(getFirstMotivionUserMessagePrompt(quote));

                if (!withInitMessage) {
                    channel.send(`Nie było mnie, ale wstałem z... Dockera. Działam na modelu: ${MODEL.getDefaultModelName()}.`);

                    return;
                }
                contextService.pushWithLimit(firstUserMessage, CHANNEL_ID);
                const context = contextService.getContext(CHANNEL_ID);
                const message = await MODEL.contextInteract([this.systemContext, ...context], FIRST_MESSAGE_MODEL_NAME);

                contextService.pushWithLimit(this.marvinResponseFactory(message.content), CHANNEL_ID);
                channel.send(message.content);
            } catch (error: any) {
                return exceptionHandler(error, channel)
            };
        });

        this.client.on("messageCreate", async (message: any) => {
            if (message.author.username === MARVIN_USERNAME) return;

            const channelId = message?.channelId;
            const userResponse = this.userResponseFactory(message);
            contextService.pushWithLimit(userResponse, channelId);

            const isMentioned = message.content.includes(MARVIN_ID) ||
                message.mentions?.repliedUser?.username === MARVIN_USERNAME;

            if (message.author.bot) {
                if (isMentioned) await this.handleBotMessage(message, contextService);
                return;
            }

            botExchangeCounters.delete(channelId);

            if (spontaneousCooldownCounter > 0) spontaneousCooldownCounter -= 1;
            if (shortReactionCooldownCounter > 0) shortReactionCooldownCounter -= 1;

            const fullMotivationRoll = !isMentioned && Math.random() < SPONTANEOUS_CHANCE;
            const shortReactionRoll = !isMentioned && !fullMotivationRoll && Math.random() < SHORT_REACTION_CHANCE;

            if (fullMotivationRoll && spontaneousCooldownCounter === 0) {
                spontaneousCooldownCounter = SPONTANEOUS_COOLDOWN;
                await this.handleSpontaneousMotivation(message, contextService);
            } else if (shortReactionRoll && shortReactionCooldownCounter === 0) {
                shortReactionCooldownCounter = SHORT_REACTION_COOLDOWN;
                await this.handleShortReaction(message, contextService);
            } else if (isMentioned) {
                await this.handleMentioned(message, contextService);
            }
        });

        this.client.login(DISCORD_CLIENT_TOKEN);
    }

    /**
     * Converts a Discord message into a context-ready Message object.
     * Prepends the sender's real name (from mapGlobalNameNameToRealName) to the content.
     * Example: "zoltymason: hej co słychać" → {role: 'user', content: 'Mason: hej co słychać'}
     */
    userResponseFactory(message: any) {
        const realName = mapGlobalNameNameToRealName[message.author.globalName];
        const timestamp = new DateService(message.createdAt).getFormattedDateTime();
        const textContent = `[${timestamp}] ${realName}: ${message.content}`;

        const imageAttachments = [...(message.attachments?.values() ?? [])].filter(
            (att: any) => att.contentType?.startsWith('image/')
        );

        if (imageAttachments.length > 0) {
            const parts: ContentPart[] = [
                { type: "text", text: textContent },
                ...imageAttachments.map((att: any) => ({
                    type: "image_url" as const,
                    image_url: { url: att.url },
                })),
            ];
            return MODEL.messageFactory(parts);
        }

        return MODEL.messageFactory(textContent);
    }

    marvinResponseFactory(content: string) {
        const timestamp = new DateService().getFormattedDateTime();
        return MODEL.messageFactory(`[${timestamp}] Marvin: ${content}`, 'assistant');
    }

    /** Handles a message from another bot. Responds up to BOT_EXCHANGE_LIMIT times per channel, then replies once with BOT_EXHAUSTED_REPLY and goes silent until a human resets the counter. */
    async handleBotMessage(message: any, contextService: ContextService) {
        const { channelId } = message;
        const count = botExchangeCounters.get(channelId) ?? 0;
        if (count >= BOT_EXCHANGE_LIMIT) return;

        botExchangeCounters.set(channelId, count + 1);
        if (count + 1 === BOT_EXCHANGE_LIMIT) {
            message.reply(BOT_EXHAUSTED_REPLY);
            contextService.pushWithLimit(this.marvinResponseFactory(BOT_EXHAUSTED_REPLY), channelId);
            contextService.saveContextToFile("context.json");
            return;
        }

        await this.handleMentioned(message, contextService);
    }

    /** Responds spontaneously (1% chance) to an unprompted message, motivating the sender based on context. */
    async handleSpontaneousMotivation(message: any, contextService: ContextService) {
        try {
            message.channel.sendTyping();
            const mess = getSpontaneousMotivationSystemPrompt()
            console.log('mess: ', mess)
            const response = await MODEL.contextInteract([
                MODEL.messageFactory(mess, 'system'),
                ...contextService.getContext(message.channelId),
            ], SPONTANEOUS_MODEL_NAME);
            if (response) {
                contextService.pushWithLimit(this.marvinResponseFactory(response.content), message.channelId);
                message.reply(response.content.substring(0, 1950));
                contextService.saveContextToFile("context.json");
            }
        } catch (error: any) {
            return exceptionHandler(error, message);
        }
    }

    /** Responds with a short (≤4 word) AI-generated reaction based on the last message in context. */
    async handleShortReaction(message: any, contextService: ContextService) {
        try {
            message.channel.sendTyping();
            const response = await MODEL.contextInteract([
                MODEL.messageFactory(getShortReactionSystemPrompt(), 'system'),
                ...contextService.getContext(message.channelId),
            ], SHORT_REACTION_MODEL_NAME);
            if (response) {
                contextService.pushWithLimit(this.marvinResponseFactory(response.content), message.channelId);
                message.reply(response.content.substring(0, 1950));
                contextService.saveContextToFile("context.json");
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

            const urls = extractUrls(message.content);
            const scrapedParts = (await Promise.all(urls.map(scrapeUrl))).filter(Boolean) as string[];
            const scrapedContext: Message[] = scrapedParts.length > 0
                ? [MODEL.messageFactory(`Zawartość stron z wiadomości użytkownika:\n${scrapedParts.join('\n\n---\n\n')}`)]
                : [];

            const deciderResponse = await decider.contextInteract([
                MODEL.messageFactory(DECIDER_SYSTEM_PROMPT, 'system'),
                ...contextService.getContext(channelId),
            ]);

            if (deciderResponse.content.includes('PERPLEXITY')) {
                message.reply(`To pytanie mnie przerosło. \nZaglądam do Internetu. 🌐`);
                const { message: perplexityResponse } = await perplexity.contextInteract(contextService.getContext(channelId));
                console.log(`perplexityResponse: ${perplexityResponse.content}`);
                message.channel.sendTyping();

                const userRequest = MODEL.messageFactory(getPerplexityToMarvinResponsePrompt(perplexityResponse.content));
                assResponse = await MODEL.contextInteract([
                    this.systemContext,
                    ...contextService.getContext(channelId),
                    ...scrapedContext,
                    userRequest,
                ]);
            } else {
                assResponse = await MODEL.contextInteract([
                    this.systemContext,
                    ...contextService.getContext(channelId),
                    ...scrapedContext,
                ]);
            }

            assResponse && contextService.pushWithLimit(this.marvinResponseFactory(assResponse.content), channelId);
            message.reply(assResponse.content.substring(0, 1950));
            contextService.saveContextToFile("context.json");
        } catch (error: any) {
            return exceptionHandler(error, message);
        }
    }

    destroy() {
        this.client.destroy();
    }
}
