const create = jest.fn();
jest.mock("openai", () => ({
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({ responses: { create } })),
}));

import { OpenAi, ToolSpec } from "../openai";

const call = (id: string, name: string, args: unknown) => ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
const answer = (text: string, ...items: any[]) => ({ output: [...items, ...(text ? [{ type: "message" }] : [])], output_text: text });
const toolRequest = (...calls: any[]) => ({ output: [{ type: "reasoning", id: "r1" }, ...calls], output_text: "" });

describe("OpenAi.contextInteractWithTools", () => {
    const search: ToolSpec = {
        name: "search",
        description: "d",
        parameters: { type: "object", properties: {} },
        run: jest.fn(async (args: any) => ({ count: 1, echo: args })),
    };
    const ai = () => new OpenAi();

    beforeEach(() => {
        create.mockReset();
        (search.run as jest.Mock).mockClear();
        jest.spyOn(console, "log").mockImplementation(() => {});
        jest.spyOn(console, "warn").mockImplementation(() => {});
        jest.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    it("returns the first reply when the model asks for no tools", async () => {
        create.mockResolvedValueOnce(answer("cześć"));
        const res = await ai().contextInteractWithTools([{ role: "system", content: "s" }, { role: "user", content: "hej" }], [search]);
        expect(res).toEqual({ role: "assistant", content: "cześć" });
        expect(create).toHaveBeenCalledTimes(1);
        const req = create.mock.calls[0][0];
        expect(req.tools).toEqual([expect.objectContaining({ type: "function", name: "search" })]);
        expect(req.reasoning).toEqual({ effort: "low" });
        expect(req.tool_choice).toBe("auto");
        expect(req.input).toEqual([{ role: "system", content: "s" }, { role: "user", content: "hej" }]);
    });

    it("runs requested tools, feeds results back and returns the final answer", async () => {
        create
            .mockResolvedValueOnce(toolRequest(call("c1", "search", { query: "kot" })))
            .mockResolvedValueOnce(answer("znalazłem"));
        const rounds = jest.fn();
        const res = await ai().contextInteractWithTools([{ role: "user", content: "hej" }], [search], { onRound: rounds });
        expect(res.content).toBe("znalazłem");
        expect(search.run).toHaveBeenCalledWith({ query: "kot" });
        expect(rounds).toHaveBeenCalledTimes(1);
        const second = create.mock.calls[1][0].input;
        expect(second).toEqual(expect.arrayContaining([expect.objectContaining({ type: "reasoning" }), expect.objectContaining({ type: "function_call", call_id: "c1" })]));
        const output = second.find((i: any) => i.type === "function_call_output");
        expect(output.call_id).toBe("c1");
        expect(JSON.parse(output.output)).toMatchObject({ count: 1 });
    });

    it("logs token usage per round and the total over all rounds", async () => {
        const usage = (input: number, cached: number, output: number, reasoning: number) => ({
            usage: { input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: output, output_tokens_details: { reasoning_tokens: reasoning } },
        });
        create
            .mockResolvedValueOnce({ ...toolRequest(call("c1", "search", {})), ...usage(1000, 200, 50, 30) })
            .mockResolvedValueOnce({ ...answer("ok"), ...usage(1500, 900, 120, 80) });
        const log = console.log as jest.Mock;
        await ai().contextInteractWithTools([{ role: "user", content: "hej" }], [search]);
        const lines = log.mock.calls.map(c => String(c[0])).filter(l => l.startsWith("[usage]"));
        expect(lines).toHaveLength(3);
        expect(lines[0]).toContain("runda 1: wejście 1000 (z cache 200), wyjście 50 (w tym rozumowanie 30)");
        expect(lines[2]).toContain("razem 2 wywołań");
        expect(lines[2]).toContain("wejście 2500 (z cache 1100), wyjście 170 (w tym rozumowanie 110)");
    });

    it("reports unknown tools, bad arguments and tool exceptions to the model instead of throwing", async () => {
        const broken: ToolSpec = { ...search, name: "broken", run: () => { throw new Error("boom"); } };
        create
            .mockResolvedValueOnce(toolRequest(
                call("a", "nope", {}),
                { type: "function_call", call_id: "b", name: "search", arguments: "{not json" },
                call("c", "broken", {}),
            ))
            .mockResolvedValueOnce(answer("ok"));
        const res = await ai().contextInteractWithTools([{ role: "user", content: "x" }], [search, broken]);
        expect(res.content).toBe("ok");
        const outputs = create.mock.calls[1][0].input.filter((i: any) => i.type === "function_call_output");
        expect(outputs.map((o: any) => Object.keys(JSON.parse(o.output))[0])).toEqual(["error", "error", "error"]);
    });

    it("forces a final answer without tool calls after the round limit", async () => {
        create
            .mockResolvedValueOnce(toolRequest(call("x", "search", {})))
            .mockResolvedValueOnce(toolRequest(call("y", "search", {})))
            .mockResolvedValueOnce({ output: [call("z", "search", {})], output_text: "w końcu odpowiedź" });
        const res = await ai().contextInteractWithTools([{ role: "user", content: "x" }], [search], { maxRounds: 2 });
        expect(create).toHaveBeenCalledTimes(3);
        expect(create.mock.calls[2][0].tool_choice).toBe("none");
        expect(res.content).toBe("w końcu odpowiedź");
        expect(search.run).toHaveBeenCalledTimes(2);
    });

    it("retries when the model prints its tool call as text, and gives up with an error", async () => {
        const leaked = answer("[assistant to=functions.list_channels კომენტary{}");
        create.mockResolvedValueOnce(leaked).mockResolvedValueOnce(answer("normalna odpowiedź"));
        const res = await ai().contextInteractWithTools([{ role: "user", content: "x" }], [search]);
        expect(res.content).toBe("normalna odpowiedź");
        expect(create).toHaveBeenCalledTimes(2);

        create.mockReset();
        create.mockResolvedValue(leaked);
        await expect(ai().contextInteractWithTools([{ role: "user", content: "x" }], [search])).rejects.toThrow(/uszkodzoną/);
        expect(create).toHaveBeenCalledTimes(5);
    });

    it("retries on tool-channel garbage like '[tool] ... weighted tokens left', but not on an ordinary mention of a tool", async () => {
        create.mockResolvedValueOnce(answer("[tool]\nYou have 1012 weighted tokens left")).mockResolvedValueOnce(answer("normalna odpowiedź"));
        const res = await ai().contextInteractWithTools([{ role: "user", content: "x" }], [search]);
        expect(res.content).toBe("normalna odpowiedź");
        expect(create).toHaveBeenCalledTimes(2);

        create.mockReset();
        create.mockResolvedValue(answer("Mam 3 weighted tokens left"));
        await expect(ai().contextInteractWithTools([{ role: "user", content: "x" }], [search])).rejects.toThrow(/uszkodzoną/);
        expect(create).toHaveBeenCalledTimes(5);

        create.mockReset();
        create.mockResolvedValueOnce(answer("Użyj [tool] w środku zdania, to nie wyciek"));
        const ok = await ai().contextInteractWithTools([{ role: "user", content: "x" }], [search]);
        expect(ok.content).toContain("w środku zdania");
        expect(create).toHaveBeenCalledTimes(1);
    });

    it("retries on gibberish: CJK/Georgian characters or leaked English reasoning", async () => {
        for (const bad of ["[2026.10.03  北京赛车 微信里的", "კომენტary tak", "We need respond continuation timestamp", "[assistant (analysis)"]) {
            create.mockReset();
            create.mockResolvedValueOnce(answer(bad)).mockResolvedValueOnce(answer("normalna odpowiedź"));
            const res = await ai().contextInteractWithTools([{ role: "user", content: "x" }], [search]);
            expect(res.content).toBe("normalna odpowiedź");
            expect(create).toHaveBeenCalledTimes(2);
        }
    });

    it("retries when the reply is only the bare name or header 'Marvin', but not when text follows", async () => {
        for (const bad of ["Marvin", "  Marvin:\n", "Marvin (2026.10.05 12:00):"]) {
            create.mockReset();
            create.mockResolvedValueOnce(answer(bad)).mockResolvedValueOnce(answer("normalna odpowiedź"));
            const res = await ai().contextInteractWithTools([{ role: "user", content: "x" }], [search]);
            expect(res.content).toBe("normalna odpowiedź");
            expect(create).toHaveBeenCalledTimes(2);
        }

        create.mockReset();
        create.mockResolvedValueOnce(answer("Marvin: no cześć"));
        const ok = await ai().contextInteractWithTools([{ role: "user", content: "x" }], [search]);
        expect(ok.content).toBe("Marvin: no cześć");
        expect(create).toHaveBeenCalledTimes(1);
    });

    it("treats an empty reply like a malformed one", async () => {
        create.mockResolvedValueOnce({ output: [], output_text: "  " }).mockResolvedValueOnce(answer("jest"));
        const res = await ai().contextInteractWithTools([{ role: "user", content: "x" }], [search]);
        expect(res.content).toBe("jest");
        expect(create).toHaveBeenCalledTimes(2);
    });

    it("converts content parts to Responses input types", async () => {
        create.mockResolvedValueOnce(answer("ok"));
        await ai().contextInteractWithTools([
            { role: "user", content: [{ type: "text", text: "a" }, { type: "image_url", image_url: { url: "http://i" } }] },
            { role: "assistant", content: [{ type: "text", text: "b" }] },
        ], [search]);
        const [user, assistant] = create.mock.calls[0][0].input;
        expect(user.content).toEqual([{ type: "input_text", text: "a" }, { type: "input_image", image_url: "http://i", detail: "auto" }]);
        expect(assistant.content).toEqual([{ type: "output_text", text: "b" }]);
    });

    it("stops running tools once the total output budget for a question is spent", async () => {
        const chunk: ToolSpec = { ...search, name: "chunk", run: jest.fn(() => ({ text: "a".repeat(15000) })) };
        create
            .mockResolvedValueOnce(toolRequest(call("a", "chunk", {}), call("b", "chunk", {}), call("c", "chunk", {})))
            .mockResolvedValueOnce(answer("ok"));
        await ai().contextInteractWithTools([{ role: "user", content: "x" }], [chunk]);
        expect(chunk.run).toHaveBeenCalledTimes(2);
        const outputs = create.mock.calls[1][0].input.filter((i: any) => i.type === "function_call_output");
        expect(JSON.parse(outputs[2].output).error).toMatch(/Budżet/);
    });

    it("replaces oversized tool output with an error", async () => {
        const big: ToolSpec = { ...search, name: "big", run: () => ({ text: "a".repeat(70000) }) };
        create
            .mockResolvedValueOnce(toolRequest(call("a", "big", {})))
            .mockResolvedValueOnce(answer("ok"));
        await ai().contextInteractWithTools([{ role: "user", content: "x" }], [big]);
        const output = create.mock.calls[1][0].input.find((i: any) => i.type === "function_call_output");
        expect(JSON.parse(output.output).error).toMatch(/za duży/);
    });
});
