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

export interface Message {
    role: "system" | "user" | "assistant";
    content: string | ContentPart[];
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

const MAX_TOOL_RESULT_CHARS = 40000;
const MAX_MALFORMED_RETRIES = 2;
const TOOL_REASONING_EFFORT = "low";
const TOOL_MAX_OUTPUT_TOKENS = 4000;

const toResponsesInput = (m: Message) => ({
    role: m.role,
    content: typeof m.content === "string"
        ? m.content
        : m.content.map(part => part.type === "text"
            ? { type: m.role === "assistant" ? "output_text" : "input_text", text: part.text }
            : { type: "input_image", image_url: part.image_url.url, detail: "auto" }),
});
// the model sometimes prints its tool call as plain text ("assistant to=functions.x ...") instead of calling it
const LEAKED_TOOL_CALL = /\bto=functions\.|<\|(?:call|channel|start|end|message)\|>/;

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
        // gpt-5.6 does not accept function tools together with reasoning on /chat/completions, so this loop uses /responses
        const apiTools = tools.map(t => ({
            type: "function" as const,
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            strict: false,
        }));
        const input: any[] = context.map(toResponsesInput);
        let malformed = 0;

        try {
            for (let round = 0; round <= maxRounds; round++) {
                const lastRound = round === maxRounds;
                const response = await this.openai.responses.create({
                    model,
                    input,
                    tools: apiTools,
                    tool_choice: lastRound ? "none" : "auto",
                    reasoning: { effort: TOOL_REASONING_EFFORT },
                    max_output_tokens: TOOL_MAX_OUTPUT_TOKENS,
                });
                const calls = lastRound ? [] : response.output.filter((item: any) => item.type === "function_call") as any[];
                const text = response.output_text ?? "";
                if (calls.length === 0 && (!text.trim() || LEAKED_TOOL_CALL.test(text))) {
                    if (++malformed > MAX_MALFORMED_RETRIES) throw new Error("Model zwrócił pustą lub uszkodzoną odpowiedź zamiast tekstu");
                    console.warn(`[openai] pusta lub uszkodzona odpowiedź (${text.trim() ? "wyciek wywołania narzędzia" : "brak treści"}), ponawiam (${malformed}/${MAX_MALFORMED_RETRIES})`);
                    round--;
                    continue;
                }
                if (calls.length === 0) return { role: "assistant", content: text };

                input.push(...response.output);
                onRound?.();
                for (const call of calls) {
                    input.push({
                        type: "function_call_output",
                        call_id: call.call_id,
                        output: await this.runTool(byName.get(call.name), call),
                    });
                }
            }
        } catch (error: any) {
            console.error("OpenAI Error:", (error as Error).message);
            throw error;
        }
    }

    private async runTool(tool: ToolSpec | undefined, call: { name: string; arguments?: string }): Promise<string> {
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
