import dotenv from "dotenv";
import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { Message } from "./openai.js";

dotenv.config();
const { PERPLEXITY_KEY } = process.env;
if (!PERPLEXITY_KEY) console.error("PERPLEXITY_KEY environment variable is not set");

const Response = z.object({
    _toughts: z.string(),
    answer: z.string(),
});

function flattenContent(content: Message["content"]): string {
    if (typeof content === "string") return content;
    return content
        .filter((part) => part.type === "text")
        .map((part) => (part as { type: "text"; text: string }).text)
        .join(" ");
}

interface TextMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export class Perplexity {
    private perplexity: OpenAI;
    private systemContext: TextMessage;

    constructor(systemPrompt?: string) {
        this.perplexity = new OpenAI({
            baseURL: 'https://api.perplexity.ai',
            apiKey: PERPLEXITY_KEY
        });
        this.systemContext = {
            role: "system",
            content: systemPrompt || "Be precise and concise.",
        };
        this.interact = this.interact.bind(this);
    }

    async interact(userPrompt: string, model: string = "sonar", chainOfToughts: boolean = false): Promise<any> {
        try {
            const userContext: TextMessage = {
                role: "user",
                content: userPrompt,
            };
            const completion = await this.perplexity.chat.completions.create({
                model,
                messages: [this.systemContext, userContext],
                // search_recency_filter="day",
                ...(chainOfToughts ? { response_format: zodResponseFormat(Response, "response") } : null),
            });

            console.log('Perplexity Response: ', completion);


            return {
                message: completion.choices[0].message,
                // sources: (completion as any).citations.map((citation: string) => "`" + citation + "`").splice(0, 3).join(`\n`)
            };
        } catch (error: any) {
            console.error("Perplexity Error:", (error as Error).message);

            throw error;
        }
    }

    getMappedContext(context: Array<Message>): Array<TextMessage> {
        return [...context].reduce((acc, message) => {
            const textContent = flattenContent(message.content);
            if (acc.length === 0) {
                acc.push({ role: message.role, content: textContent });
                return acc;
            }

            const lastAdded = acc[acc.length - 1];

            if (lastAdded.role === message.role) {
                acc[acc.length - 1].content += `\n${textContent}`;
            } else {
                acc.push({ role: message.role, content: textContent });
            }
            return acc;

        }, [] as Array<TextMessage>);
    }

    async contextInteract(context: Array<Message>, model: string = "sonar", chainOfToughts: boolean = false): Promise<any> {
        try {
            const mappedContext = this.getMappedContext(context);

            console.log(">>>>>>>> Perplexity mappedContext <<<<<<<<", model, mappedContext, mappedContext.length);


            const completion = await this.perplexity.chat.completions.create({
                model,
                messages: [this.systemContext, ...mappedContext],
                // search_recency_filter="day",
                ...(chainOfToughts ? { response_format: zodResponseFormat(Response, "response") } : null),
            });

            console.log('Perplexity Response: ', completion);


            return {
                message: completion.choices[0].message,
                // sources: (completion as any).citations.map((citation: string) => "`" + citation + "`").splice(0, 3).join(`\n`)
            };
        } catch (error: any) {
            console.error("Perplexity Error:", (error as Error).message);

            throw error;
        }
    }
}