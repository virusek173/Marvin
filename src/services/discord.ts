import dotenv from "dotenv";
import {
    exceptionHandler,
    loadContextFromFile,
    mapGlobalNameNameToRealName,
    saveContextToFile,
} from "../utils/helpers.js";
import { DeepSeek } from "../services/deepseek.js";
import { Message, OpenAi } from "../services/openai.js";
import { DateService } from "./date.js";
import { ClientService } from "./client.js";
import { ContextService } from "./context.js";
import { Perplexity } from "./perplexity.js";
import {
    DECIDER_SYSTEM_PROMPT,
    getFirstMotivionUserMessagePrompt,
    getMarvinMotivationSystemPrompt,
    getPerplexityToMarvinResponsePrompt
} from "../utils/prompts.js";

dotenv.config();
const { MARVIN_ID, DISCORD_CLIENT_TOKEN, CHANNEL_ID } = process.env;

const DEFAULT_QUOTE = "Co żyje to żyje";
const deepseek = new DeepSeek();
const openai = new OpenAi();
const decider = new OpenAi();
const perplexity = new Perplexity();

export class DiscordServce {
    private client: any;
    private date: string;
    private systemContext: Message;
    constructor(_quote: string | undefined,
        withInitMessage: boolean = true) {
        const contextService = new ContextService([])

        const clientService = new ClientService();
        this.client = clientService.getClient();

        const date = new DateService();
        this.date = date.getFormattedDate();
        this.systemContext = openai.messageFactory(getMarvinMotivationSystemPrompt(this.date, MARVIN_ID), 'system');

        const quote = _quote ? _quote : DEFAULT_QUOTE;
        console.log("Today's quote: ", quote);

        this.client.on("ready", async () => {
            const channel = this.client.channels.cache.get(CHANNEL_ID);
            try {
                console.log(`Logged in as ${this.client.user.tag}!`);

                const context = loadContextFromFile("context.json");
                const firstUserMessage = openai.messageFactory(getFirstMotivionUserMessagePrompt(quote));

                contextService.setContext(context);
                if (!withInitMessage) {
                    channel.send(`Nie było mnie, ale wstałem z... Dockera.`);

                    return;
                }
                contextService.pushWithLimit(firstUserMessage);
                const message = await openai.contextInteract([this.systemContext, ...context]);

                contextService.pushWithLimit(message);
                channel.send(message.content);
            } catch (error: any) {
                return exceptionHandler(error, channel)
            };
        });

        this.client.on("messageCreate", async (message: any) => {
            if (
                message.content.includes(MARVIN_ID) ||
                message.mentions?.repliedUser?.username === "Marvin"
            ) {
                if (message.author.username !== "Marvin") {
                    try {
                        let { interact, messageAddition } = this.getResponseModelFunction(message)
                        const userResponse = this.userResponseFactory(message)
                        let assResponse = null;

                        contextService.pushWithLimit(userResponse);
                        const deciderResponse = await decider.contextInteract([
                            openai.messageFactory(DECIDER_SYSTEM_PROMPT, 'system'),
                            ...contextService.getContext(),
                        ])

                        if (deciderResponse.content.includes('PERPLEXITY')) {
                            message.reply(`To pytanie mnie przerosło. \nZaglądam do Internetu. 🌐`);
                            const { message: perplexityResponse } = await perplexity.interact(userResponse.content);
                            console.log(`perplexityResponse: ${perplexityResponse.content}`);
                            message.channel.sendTyping();

                            const userRequest = openai.messageFactory(getPerplexityToMarvinResponsePrompt(perplexityResponse.content));

                            assResponse = await interact([
                                this.systemContext,
                                ...contextService.getContext(),
                                userRequest,
                            ]);
                        } else {
                            message.channel.sendTyping();
                            assResponse = await interact([
                                this.systemContext,
                                ...contextService.getContext(),
                            ]);
                        }

                        assResponse && contextService.pushWithLimit(assResponse);

                        const responseContent = `${assResponse.content.substring(0, 1950)}\n\n${messageAddition}`;
                        message.reply(responseContent);

                        saveContextToFile("context.json", contextService.getContext());
                    } catch (error: any) {
                        return exceptionHandler(error, message)
                    };
                }
            }
        });

        this.client.login(DISCORD_CLIENT_TOKEN);
    }

    getResponseModelFunction(message: any) {
        const deepseekModel = message.content.toLowerCase().includes("!ds")
        const interact = deepseekModel ? deepseek.interact : openai.contextInteract;
        const messageAddition = deepseekModel ? `Z wyrazami szacunku,\nTwój model DeepSeek.` : '';

        return { interact, messageAddition }
    }

    userResponseFactory(message: any) {
        const realName = mapGlobalNameNameToRealName[message.author.globalName];
        const modifiedUserResponseContent = `${realName}: ${message.content}`;
        return openai.messageFactory(modifiedUserResponseContent)
    }

    destroy() {
        this.client.destroy();
    }
}
