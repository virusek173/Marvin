import dotenv from "dotenv";
import {
    exceptionHandler,
    mapGlobalNameNameToRealName,
} from "../utils/helpers.js";
import { Message, OpenAi } from "../services/openai.js";
import { DateService } from "./date.js";
import { ClientService } from "./client.js";
import { ContextService } from "./context.js";
import { Perplexity } from "./perplexity.js";
import { Grok } from "./grok.js";
import {
    DECIDER_SYSTEM_PROMPT,
    getFirstMotivionUserMessagePrompt,
    getMarvinMotivationSystemPrompt,
    getPerplexityToMarvinResponsePrompt
} from "../utils/prompts.js";

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

export class DiscordServce {
    private client: any;
    private date: string;
    private systemContext: Message;
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
                const message = await MODEL.contextInteract([this.systemContext, ...context]);

                contextService.pushWithLimit(message, CHANNEL_ID);
                channel.send(message.content);
            } catch (error: any) {
                return exceptionHandler(error, channel)
            };
        });

        this.client.on("messageCreate", async (message: any) => {
            if (message.author.username !== MARVIN_USERNAME) {
                const userResponse = this.userResponseFactory(message)
                const channelId = message?.channelId;

                contextService.pushWithLimit(userResponse, channelId);
                if (
                    message.content.includes(MARVIN_ID) ||
                    message.mentions?.repliedUser?.username === MARVIN_USERNAME
                ) {
                    try {
                        const { channelId } = message;
                        let assResponse = null;

                        const deciderResponse = await decider.contextInteract([
                            MODEL.messageFactory(DECIDER_SYSTEM_PROMPT, 'system'),
                            ...contextService.getContext(channelId),
                        ])

                        if (deciderResponse.content.includes('PERPLEXITY')) {
                            message.reply(`To pytanie mnie przerosło. \nZaglądam do Internetu. 🌐`);
                            const { message: perplexityResponse } = await perplexity.contextInteract(contextService.getContext(channelId));
                            console.log(`perplexityResponse: ${perplexityResponse.content}`);
                            message.channel.sendTyping();

                            const userRequest = MODEL.messageFactory(getPerplexityToMarvinResponsePrompt(perplexityResponse.content));

                            assResponse = await MODEL.contextInteract([
                                this.systemContext,
                                ...contextService.getContext(channelId),
                                userRequest,
                            ]);
                        } else {
                            message.channel.sendTyping();
                            assResponse = await MODEL.contextInteract([
                                this.systemContext,
                                ...contextService.getContext(channelId),
                            ]);
                        }

                        assResponse && contextService.pushWithLimit(assResponse, channelId);

                        const responseContent = `${assResponse.content.substring(0, 1950)}`;
                        message.reply(responseContent);

                        contextService.saveContextToFile("context.json");
                    } catch (error: any) {
                        return exceptionHandler(error, message)
                    };
                }
            }
        });

        this.client.login(DISCORD_CLIENT_TOKEN);
    }

    userResponseFactory(message: any) {
        const realName = mapGlobalNameNameToRealName[message.author.globalName];
        const modifiedUserResponseContent = `${realName}: ${message.content}`;
        return MODEL.messageFactory(modifiedUserResponseContent)
    }

    destroy() {
        this.client.destroy();
    }
}
