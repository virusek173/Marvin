const create = jest.fn();
jest.mock("openai", () => ({
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({ chat: { completions: { create } } })),
}));

import { OpenAi, ToolSpec } from "../openai";

const toolCall = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const reply = (message: any) => ({ choices: [{ message }] });

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
        jest.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    it("returns the first reply when the model asks for no tools", async () => {
        create.mockResolvedValueOnce(reply({ role: "assistant", content: "cześć" }));
        const res = await ai().contextInteractWithTools([{ role: "user", content: "hej" }], [search]);
        expect(res.content).toBe("cześć");
        expect(create).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0][0].tools).toHaveLength(1);
    });

    it("runs requested tools, feeds results back and returns the final answer", async () => {
        create
            .mockResolvedValueOnce(reply({ role: "assistant", content: null, tool_calls: [toolCall("c1", "search", { query: "kot" })] }))
            .mockResolvedValueOnce(reply({ role: "assistant", content: "znalazłem" }));
        const rounds = jest.fn();
        const res = await ai().contextInteractWithTools([{ role: "user", content: "hej" }], [search], { onRound: rounds });
        expect(res.content).toBe("znalazłem");
        expect(search.run).toHaveBeenCalledWith({ query: "kot" });
        expect(rounds).toHaveBeenCalledTimes(1);
        const second = create.mock.calls[1][0].messages;
        expect(second[1]).toMatchObject({ role: "assistant", tool_calls: [expect.objectContaining({ id: "c1" })] });
        expect(second[2]).toMatchObject({ role: "tool", tool_call_id: "c1" });
        expect(JSON.parse(second[2].content)).toMatchObject({ count: 1 });
    });

    it("reports unknown tools, bad arguments and tool exceptions to the model instead of throwing", async () => {
        const broken: ToolSpec = { ...search, name: "broken", run: () => { throw new Error("boom"); } };
        create
            .mockResolvedValueOnce(reply({
                role: "assistant", content: "",
                tool_calls: [toolCall("a", "nope", {}), { id: "b", type: "function", function: { name: "search", arguments: "{not json" } }, toolCall("c", "broken", {})],
            }))
            .mockResolvedValueOnce(reply({ role: "assistant", content: "ok" }));
        const res = await ai().contextInteractWithTools([{ role: "user", content: "x" }], [search, broken]);
        expect(res.content).toBe("ok");
        const toolMessages = create.mock.calls[1][0].messages.filter((m: any) => m.role === "tool");
        expect(toolMessages.map((m: any) => Object.keys(JSON.parse(m.content))[0])).toEqual(["error", "error", "error"]);
    });

    it("forces a final answer without tools after the round limit", async () => {
        create
            .mockResolvedValueOnce(reply({ role: "assistant", content: "", tool_calls: [toolCall("x", "search", {})] }))
            .mockResolvedValueOnce(reply({ role: "assistant", content: "", tool_calls: [toolCall("y", "search", {})] }))
            .mockResolvedValueOnce(reply({ role: "assistant", content: "w końcu odpowiedź", tool_calls: [toolCall("z", "search", {})] }));
        const res = await ai().contextInteractWithTools([{ role: "user", content: "x" }], [search], { maxRounds: 2 });
        expect(create).toHaveBeenCalledTimes(3);
        expect(create.mock.calls[2][0].tools).toBeUndefined();
        expect(res.content).toBe("w końcu odpowiedź");
        expect(search.run).toHaveBeenCalledTimes(2);
    });

    it("replaces oversized tool output with an error", async () => {
        const big: ToolSpec = { ...search, name: "big", run: () => ({ text: "a".repeat(30000) }) };
        create
            .mockResolvedValueOnce(reply({ role: "assistant", content: "", tool_calls: [toolCall("a", "big", {})] }))
            .mockResolvedValueOnce(reply({ role: "assistant", content: "ok" }));
        await ai().contextInteractWithTools([{ role: "user", content: "x" }], [big]);
        const tool = create.mock.calls[1][0].messages.find((m: any) => m.role === "tool");
        expect(JSON.parse(tool.content).error).toMatch(/za duży/);
    });
});
