const transcriptionsCreate = jest.fn();
jest.mock("openai", () => ({
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({ audio: { transcriptions: { create: transcriptionsCreate } } })),
    toFile: jest.fn(async (_data: unknown, name: string, options: any) => ({ name, type: options?.type })),
}));

const record = jest.fn();
jest.mock("../usage", () => ({ usageTracker: { record: (...args: unknown[]) => record(...args) } }));

import { OpenAi } from "../openai";

describe("transcribeAudio", () => {
    beforeEach(() => { transcriptionsCreate.mockReset(); record.mockReset(); });

    it("sends the audio in Polish, returns trimmed text and records token usage as kind voice", async () => {
        transcriptionsCreate.mockResolvedValueOnce({ text: " Cześć. ", usage: { type: "tokens", input_tokens: 56, output_tokens: 30 } });
        const text = await new OpenAi().transcribeAudio(Buffer.from("x"), "voice-message.ogg", "audio/ogg");
        expect(text).toBe("Cześć.");
        expect(transcriptionsCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-4o-mini-transcribe", language: "pl", file: { name: "voice-message.ogg", type: "audio/ogg" } }));
        expect(record).toHaveBeenCalledWith("voice", "gpt-4o-mini-transcribe", { input: 56, cached: 0, output: 30, reasoning: 0 });
    });

    it("propagates API errors to the caller", async () => {
        transcriptionsCreate.mockRejectedValueOnce(new Error("429"));
        await expect(new OpenAi().transcribeAudio(Buffer.from("x"), "v.ogg", "audio/ogg")).rejects.toThrow("429");
    });
});
