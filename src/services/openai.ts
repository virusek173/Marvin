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

const MAX_TOOL_RESULT_CHARS = 60000;
const MAX_TOTAL_TOOL_CHARS = 30000;
const MAX_MALFORMED_RETRIES = 4;
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
// the model sometimes prints its tool call as plain text ("assistant to=functions.x ...") instead of calling it,
// a bare speaker header ("Marvin", "Marvin (2026.10.05 12:00):") with no text after it, or emits tool-channel garbage ("[tool]\nYou have N weighted tokens left") as the answer
const LEAKED_TOOL_CALL = /\bto=functions\.|<\|(?:call|channel|start|end|message)\|>|^\s*\[tool\]|weighted tokens left|[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u10a0-\u10ff]|\bWe need (?:to )?respond|^\s*\[assistant\b|^\s*Marvin\s*(?:\([^)\n]*\))?\s*:?\s*$/i;

interface TokenUsage {
    input: number;
    cached: number;
    output: number;
    reasoning: number;
}

const NO_USAGE: TokenUsage = { input: 0, cached: 0, output: 0, reasoning: 0 };

/** Normalizes both API shapes: Responses (`input_tokens`) and chat completions (`prompt_tokens`). */
const readUsage = (usage: any): TokenUsage => ({
    input: usage?.input_tokens ?? usage?.prompt_tokens ?? 0,
    cached: usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0,
    output: usage?.output_tokens ?? usage?.completion_tokens ?? 0,
    reasoning: usage?.output_tokens_details?.reasoning_tokens ?? usage?.completion_tokens_details?.reasoning_tokens ?? 0,
});

const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
    input: a.input + b.input,
    cached: a.cached + b.cached,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
});

const formatUsage = (u: TokenUsage): string => `wejście ${u.input} (z cache ${u.cached}), wyjście ${u.output} (w tym rozumowanie ${u.reasoning})`;

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
            console.log(`[usage] ${model}: ${formatUsage(readUsage(completion.usage))}`);

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
        const spent = { chars: 0 };
        let total = NO_USAGE;
        let calls = 0;
        const logTotal = () => {
            if (calls > 1) console.log(`[usage] razem ${calls} wywołań ${model}: ${formatUsage(total)}`);
        };

        try {
            for (let round = 0; round <= maxRounds; round++) {
                const lastRound = round === maxRounds;
                const forceText = lastRound || malformed >= 2;
                const response = await this.openai.responses.create({
                    model,
                    input,
                    tools: apiTools,
                    tool_choice: forceText ? "none" : "auto",
                    reasoning: { effort: TOOL_REASONING_EFFORT },
                    max_output_tokens: TOOL_MAX_OUTPUT_TOKENS,
                });
                const used = readUsage(response.usage);
                total = addUsage(total, used);
                calls++;
                console.log(`[usage] ${model} runda ${round + 1}: ${formatUsage(used)}`);
                const toolCalls = forceText ? [] : response.output.filter((item: any) => item.type === "function_call") as any[];
                const text = response.output_text ?? "";
                if (toolCalls.length === 0 && (!text.trim() || LEAKED_TOOL_CALL.test(text))) {
                    if (++malformed > MAX_MALFORMED_RETRIES) throw new Error("Model zwrócił pustą lub uszkodzoną odpowiedź zamiast tekstu");
                    console.warn(`[openai] pusta lub uszkodzona odpowiedź (${text.trim() ? "wyciek wywołania narzędzia" : "brak treści"}), ponawiam (${malformed}/${MAX_MALFORMED_RETRIES})`, JSON.stringify({ status: (response as any).status, incomplete: (response as any).incomplete_details, output: response.output.map((item: any) => ({ type: item.type, status: item.status, refusal: item.content?.find?.((c: any) => c.type === "refusal")?.refusal })) }));
                    round--;
                    continue;
                }
                if (toolCalls.length === 0) {
                    logTotal();
                    return { role: "assistant", content: text };
                }

                input.push(...response.output);
                onRound?.();
                for (const call of toolCalls) {
                    input.push({
                        type: "function_call_output",
                        call_id: call.call_id,
                        output: await this.runTool(byName.get(call.name), call, spent),
                    });
                }
            }
        } catch (error: any) {
            console.error("OpenAI Error:", (error as Error).message);
            throw error;
        }
    }

    private async runTool(tool: ToolSpec | undefined, call: { name: string; arguments?: string }, spent: { chars: number }): Promise<string> {
        const started = Date.now();
        let output: unknown;
        try {
            if (!tool) throw new Error(`Nieznane narzędzie: ${call.name}`);
            if (spent.chars >= MAX_TOTAL_TOOL_CHARS) throw new Error("Budżet danych na to pytanie wyczerpany. Odpowiedz na podstawie tego, co już masz.");
            output = await tool.run(call.arguments ? JSON.parse(call.arguments) : {});
        } catch (error: any) {
            output = { error: String(error?.message ?? error) };
        }
        let text = JSON.stringify(output);
        if (text.length > MAX_TOOL_RESULT_CHARS) text = JSON.stringify({ error: "Wynik za duży, zawęź zapytanie." });
        spent.chars += text.length;
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
