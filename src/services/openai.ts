import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";

const Response = z.object({
    _toughts: z.string(),
    answer: z.string(),
});

export interface Message {
    role: "system" | "user";
    content: string;
}

export class OpenAi {
    private openai: OpenAI;

    constructor() {
        this.openai = new OpenAI();
        this.interact = this.interact.bind(this);
        this.contextInteract = this.contextInteract.bind(this);
    }

    async interact(userPrompt: string, model: string = "gpt-4o-mini", chainOfToughts: boolean = false): Promise<any> {
        try {
            const context: Message[] = [
                {
                    role: 'system',
                    content: 'You are a helpful assistant.'
                },
                {
                    role: 'user',
                    content: userPrompt
                }
            ]
            const completion = await this.openai.chat.completions.create({
                model,
                messages: context,
                max_tokens: 2500,
                ...(chainOfToughts ? { response_format: zodResponseFormat(Response, "response") } : null),
            });

            return completion.choices[0].message;
        } catch (error: any) {
            console.error("OpenAI Error:", (error as Error).message);
            return null;
        }
    }

    async contextInteract(context: Array<Message>, model: string = "gpt-4o-mini", chainOfToughts: boolean = false): Promise<any> {
        try {
            console.log(">>>>>>>> context <<<<<<<<", model, context, context.length);
            const completion = await this.openai.chat.completions.create({
                model,
                messages: context,
                max_tokens: 2500,
                ...(chainOfToughts ? { response_format: zodResponseFormat(Response, "response") } : null),
            });

            return completion.choices[0].message;
        } catch (error: any) {
            console.error("OpenAI Error:", (error as Error).message);

            throw error;
        }
    }

    messageFactory(content: string, role: 'user' | 'system' = 'user'): Message {
        return {
            role,
            content,
        }
    }
}
