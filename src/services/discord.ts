import {
    getFirstMotivionUserMessage,
    getMotivationSystemContext,
} from "../openai.js";

import dotenv from "dotenv";
import {
    exceptionHandler,
    loadContextFromFile,
    mapGlobalNameNameToRealName,
    messageResponseFactory,
    saveContextToFile,
} from "../helpers.js";
import { DeepSeek } from "../services/deepseek.js";
import { OpenAi } from "../services/openai.js";
import { DateService } from "./date.js";
import { ClientService } from "./client.js";
import { ContextService } from "./context.js";

dotenv.config();
const { MARVIN_ID, CLIENT_TOKEN, CHANNEL_ID } = process.env;

const DEFAULT_QUOTE = "Co żyje to żyje";
const deepseek = new DeepSeek();
const openai = new OpenAi();


export class DiscordServce {
    private date: string;
    constructor(_quote: string | undefined,
        withInitMessage: boolean = true) {
        const contextService = new ContextService([])

        const clientService = new ClientService();
        const client = clientService.getClient();

        const date = new DateService();
        this.date = date.getFormattedDate();

        const quote = _quote ? _quote : DEFAULT_QUOTE;
        console.log("Today's quote: ", quote);

        client.on("ready", async () => {
            console.log(`Logged in as ${client.user.tag}!`);

            const savedContext = loadContextFromFile("context.json");

            const systemContext = getMotivationSystemContext(this.date, MARVIN_ID);
            const firstUserMessage = getFirstMotivionUserMessage(quote);

            const channel = client.channels.cache.get(CHANNEL_ID);
            if (!withInitMessage) {
                channel.send(`Nie było mnie, ale wstałem z... Dockera.`);

                return;
            }
            try {
                const context = [
                    ...systemContext,
                    ...savedContext,
                    ...firstUserMessage,
                ];
                contextService.setContext(context);
                const message = await openai.contextInteract(context);

                contextService.pushWithLimit(message);
                channel.send(message.content);
            } catch (error: any) {
                return exceptionHandler(error, channel)
            };
        });

        client.on("messageCreate", async (msg: any) => {
            if (
                msg.content.includes(MARVIN_ID) ||
                msg.mentions?.repliedUser?.username === "Marvin"
            ) {
                if (msg.author.username !== "Marvin") {
                    msg.channel.sendTyping();

                    const realName = mapGlobalNameNameToRealName[msg.author.globalName];
                    const modifiedUserResponseContent = `${realName}: ${msg.content}`;
                    const deepseekModel = msg.content.toLowerCase().includes("!ds")
                    const modelFunction = deepseekModel ? deepseek.interact : openai.contextInteract;
                    const messageAddition = deepseekModel ? `Z wyrazami szacunku,\nTwój model DeepSeek.` : '';
                    const userResponse = messageResponseFactory(
                        modifiedUserResponseContent
                    );

                    contextService.pushWithLimit(userResponse);
                    const systemContext = getMotivationSystemContext(this.date, MARVIN_ID);
                    try {
                        msg.channel.sendTyping();
                        const assResponse = await modelFunction([
                            ...systemContext,
                            ...contextService.getContext(),
                        ]);
                        if (assResponse) {
                            contextService.pushWithLimit(assResponse);
                        }
                        const responseContent = `${assResponse.content}\n\n${messageAddition}`;
                        msg.reply(
                            responseContent.length < 2000
                                ? responseContent
                                : `${responseContent.substring(0, 1950)}...\n\n${messageAddition}`
                        );

                        saveContextToFile("context.json", contextService.getContext());
                    } catch (error: any) {
                        return exceptionHandler(error, msg)
                    };
                }
            }
        });

        client.login(CLIENT_TOKEN);
    }
}
