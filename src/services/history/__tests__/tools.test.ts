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

    it("get_stats maps arguments and ignores junk", async () => {
        const res: any = await tool("get_stats").run({ group_by: "author", limit: "many", sort: 5 });
        expect(res).toMatchObject({ total: 1, groupBy: "author", groups: [{ key: "Jacek", count: 1 }] });
        expect(((await tool("get_stats").run({ group_by: "DROP TABLE" })) as any).groupBy).toBe("none");
        expect(((await tool("get_stats").run(null)) as any).total).toBe(1);
    });

    it("exposes exactly the five read-only tools with valid JSON schemas", () => {
        expect(tools.map(t => t.name).sort()).toEqual(["get_message_context", "get_messages", "get_stats", "list_channels", "search_messages"]);
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
