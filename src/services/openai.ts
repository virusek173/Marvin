import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { DEFAULT_MODEL_NAME } from "../utils/consts.js";

const Response = z.object({
    _toughts: z.string(),
    answer: z.string(),
});

export type ContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } };

export interface ToolCall {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
}

export interface Message {
    role: "system" | "user" | "assistant" | "tool";
    content: string | ContentPart[];
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

export interface ToolSpec {
    name: string;
    description: string;
    /** JSON Schema of the arguments object. */
    parameters: Record<string, unknown>;
    run: (args: any) => unknown | Promise<unknown>;
}

export interface ToolLoopOptions {
    model?: string;
    maxRounds?: number;
    /** Called before each tool round, e.g. to refresh the typing indicator. */
    onRound?: () => void;
}

const MAX_TOOL_RESULT_CHARS = 20000;

export class OpenAi {
    private openai: OpenAI;

    constructor() {
        this.openai = new OpenAI();
        this.interact = this.interact.bind(this);
        this.contextInteract = this.contextInteract.bind(this);
    }

    async interact(userPrompt: string, model: string = DEFAULT_MODEL_NAME, chainOfToughts: boolean = false): Promise<any> {
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
                messages: context as any,
                max_completion_tokens: 2500,
                ...(chainOfToughts ? { response_format: zodResponseFormat(Response, "response") } : null),
            });

            return completion.choices[0].message;
        } catch (error: any) {
            console.error("OpenAI Error:", (error as Error).message);
            return null;
        }
    }

    async contextInteract(context: Array<Message>, model: string = DEFAULT_MODEL_NAME, chainOfToughts: boolean = false): Promise<any> {
        try {
            const last = context[context.length - 1];
            console.log(`[openai] ${model}: ${context.length} messages, last: ${String(typeof last?.content === "string" ? last.content : "[parts]").substring(0, 120)}`);
            const completion = await this.openai.chat.completions.create({
                model,
                messages: context as any,
                max_completion_tokens: 2500,
                ...(chainOfToughts ? { response_format: zodResponseFormat(Response, "response") } : null),
            });

            return completion.choices[0].message;
        } catch (error: any) {
            console.error("OpenAI Error:", (error as Error).message);

            throw error;
        }
    }

    /**
     * Like contextInteract, but lets the model call the given tools. Each round the model may request tools; their
     * results are fed back and the model is asked again. After `maxRounds` rounds it must answer without tools.
     */
    async contextInteractWithTools(context: Array<Message>, tools: ToolSpec[], options: ToolLoopOptions = {}): Promise<any> {
        const { model = DEFAULT_MODEL_NAME, maxRounds = 5, onRound } = options;
        const byName = new Map(tools.map(t => [t.name, t]));
        const apiTools = tools.map(t => ({
            type: "function" as const,
            function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        const messages: Message[] = [...context];

        try {
            for (let round = 0; round <= maxRounds; round++) {
                const lastRound = round === maxRounds;
                const completion = await this.openai.chat.completions.create({
                    model,
                    messages: messages as any,
                    max_completion_tokens: 2500,
                    ...(lastRound ? null : { tools: apiTools }),
                });
                const reply = completion.choices[0].message;
                const calls = lastRound ? [] : (reply.tool_calls ?? []).filter(c => c.type === "function");
                if (calls.length === 0) return reply;

                messages.push({ role: "assistant", content: reply.content ?? "", tool_calls: calls as ToolCall[] });
                onRound?.();
                for (const call of calls) {
                    messages.push({ role: "tool", tool_call_id: call.id, content: await this.runTool(byName.get(call.function.name), call.function) });
                }
            }
        } catch (error: any) {
            console.error("OpenAI Error:", (error as Error).message);
            throw error;
        }
    }

    private async runTool(tool: ToolSpec | undefined, call: { name: string; arguments: string }): Promise<string> {
        const started = Date.now();
        let output: unknown;
        try {
            if (!tool) throw new Error(`Nieznane narzędzie: ${call.name}`);
            output = await tool.run(call.arguments ? JSON.parse(call.arguments) : {});
        } catch (error: any) {
            output = { error: String(error?.message ?? error) };
        }
        let text = JSON.stringify(output);
        if (text.length > MAX_TOOL_RESULT_CHARS) text = JSON.stringify({ error: "Wynik za duży, zawęź zapytanie." });
        const count = (output as any)?.count ?? (Array.isArray(output) ? output.length : undefined);
        console.log(`[tool] ${call.name} ${call.arguments} -> ${(output as any)?.error ? "błąd" : `wyników: ${count ?? "?"}`} (${Date.now() - started} ms)`);
        return text;
    }

    async describeImage(url: string): Promise<string> {
        try {
            const completion = await this.openai.chat.completions.create({
                model: DEFAULT_MODEL_NAME,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url } },
                        { type: 'text', text: 'Opisz krótko co widzisz na tym obrazku (max 2 zdania, po polsku).' },
                    ],
                }] as any,
                max_completion_tokens: 300,
            });
            return completion.choices[0].message.content ?? '[nie udało się opisać obrazka]';
        } catch {
            return '[nie udało się opisać obrazka]';
        }
    }

    messageFactory(content: string | ContentPart[], role: 'user' | 'system' | 'assistant' = 'user'): Message {
        return { role, content };
    }

    getDefaultModelName(): string {
        return DEFAULT_MODEL_NAME;
    }
}
