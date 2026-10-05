import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HistoryDb } from "../db";
import { HistoryQuery } from "../query";
import { buildHistoryTools } from "../tools";

describe("buildHistoryTools", () => {
    let dir: string;
    let db: HistoryDb;
    let query: HistoryQuery;
    let tools: ReturnType<typeof buildHistoryTools>;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "marvin-tools-"));
        const file = path.join(dir, "history.db");
        db = new HistoryDb(file);
        db.upsertChannel("c1", "ogolny", null);
        db.insertLive({
            id: "1", channelId: "c1", parentId: null, authorId: "u1", authorName: "Vajrusek", isBot: false,
            content: "jedziemy na urlop w sierpniu", embedsText: "", attachmentsText: "", replyToId: null, type: 0,
            isTechnical: false, createdAt: Date.UTC(2025, 2, 10, 11, 0),
        });
        query = new HistoryQuery(file, { excludedChannelIds: [] });
        tools = buildHistoryTools(query);
    });
    afterEach(() => {
        query.close();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const tool = (name: string) => tools.find(t => t.name === name)!;

    it("get_conversation maps arguments and ignores junk", async () => {
        const res: any = await tool("get_conversation").run({ message_id: "1", gap_minutes: "x", limit: null });
        expect(res).toMatchObject({ count: 1, conversation: { messages: 1 } });
        expect(((await tool("get_conversation").run(null)) as any).note).toBeDefined();
    });

    it("get_stats maps arguments and ignores junk", async () => {
        const res: any = await tool("get_stats").run({ group_by: "author", limit: "many", sort: 5 });
        expect(res).toMatchObject({ total: 1, groupBy: "author", groups: [{ key: "Jacek", count: 1 }] });
        expect(((await tool("get_stats").run({ group_by: "DROP TABLE" })) as any).groupBy).toBe("none");
        expect(((await tool("get_stats").run(null)) as any).total).toBe(1);
    });

    it("get_stats passes with_length and reply_to_author through", async () => {
        db.insertLive({
            id: "2", channelId: "c1", parentId: null, authorId: "u2", authorName: "Madzia", isBot: false,
            content: "super pomysł", embedsText: "", attachmentsText: "", replyToId: "1", type: 0,
            isTechnical: false, createdAt: Date.UTC(2025, 2, 10, 11, 5),
        });
        const lengths: any = await tool("get_stats").run({ group_by: "author", with_length: true });
        expect(lengths.groups.find((g: any) => g.key === "Madzia")).toMatchObject({ avgChars: 12, avgWords: 2 });
        expect(((await tool("get_stats").run({ group_by: "author" })) as any).groups[0]).not.toHaveProperty("avgChars");
        expect(((await tool("get_stats").run({ author: "Madzia", reply_to_author: "Jacek" })) as any).total).toBe(1);
        expect(((await tool("get_stats").run({ author: "Jacek", reply_to_author: "Madzia" })) as any).total).toBe(0);
        expect(((await tool("get_messages").run({ reply_to_author: "Jacek" })) as any).messages).toHaveLength(1);
    });

    it("get_profile returns stored profiles and tolerates junk arguments", async () => {
        db.upsertProfile({ name: "Jacek", summary: "Lubi rowery.", messageCount: 40, lastSeq: 1, updatedAt: Date.UTC(2025, 2, 11, 12, 0) });
        const one: any = await tool("get_profile").run({ person: "Vajrusek" });
        expect(one).toMatchObject({ count: 1, profiles: [{ name: "Jacek", profile: "Lubi rowery.", basedOnMessages: 40, updated: "2025.03.11" }] });
        expect(((await tool("get_profile").run(null)) as any).count).toBe(1);
        expect(((await tool("get_profile").run({ person: 5 })) as any).count).toBe(1);
    });

    it("exposes exactly the seven read-only tools with valid JSON schemas", () => {
        expect(tools.map(t => t.name).sort()).toEqual(["get_conversation", "get_message_context", "get_messages", "get_profile", "get_stats", "list_channels", "search_messages"]);
        for (const t of tools) expect(t.parameters).toMatchObject({ type: "object" });
    });

    it("search_messages passes arguments through and tolerates junk", async () => {
        const res: any = await tool("search_messages").run({ query: "urlop", author: "Jacek", limit: "many" });
        expect(res.count).toBe(1);
        expect(res.messages[0].author).toBe("Jacek");
        expect(((await tool("search_messages").run(null)) as any).note).toBeDefined();
    });

    it("get_messages, get_message_context and list_channels work end to end", async () => {
        expect(((await tool("get_messages").run({ from: "2025-03-10", to: "2025-03-10" })) as any).count).toBe(1);
        expect(((await tool("get_message_context").run({ message_id: "1" })) as any).count).toBe(1);
        expect(((await tool("list_channels").run({})) as any).channels).toEqual([{ id: "c1", name: "ogolny", messages: 1 }]);
    });
});
