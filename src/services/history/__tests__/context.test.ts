import { HistoryDb } from "../db";
import { ArchiveRow } from "../mapper";
import { HistoryContext } from "../context";
import { ContextService } from "../../context";

const MARVIN = "marvin-id";
let seq = 0;
const row = (over: Partial<ArchiveRow> = {}): ArchiveRow => {
    seq += 1;
    return {
        id: String(1000 + seq),
        channelId: "c1",
        parentId: null,
        authorId: "u1",
        authorName: "Vajrusek",
        isBot: false,
        content: `msg ${seq}`,
        embedsText: "",
        attachmentsText: "",
        replyToId: null,
        type: 0,
        isTechnical: false,
        createdAt: 1_700_000_000_000 + seq * 1000,
        ...over,
    };
};

describe("HistoryContext", () => {
    let db: HistoryDb;
    let fallback: ContextService;
    const make = (excluded: string[] = [], limit = 30) => new HistoryContext(db, fallback, excluded, MARVIN, limit);

    beforeEach(() => {
        db = new HistoryDb(":memory:");
        fallback = new ContextService({});
        jest.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => { db.close(); jest.restoreAllMocks(); });

    it("returns the newest messages oldest-first, limited, only from the given channel", () => {
        const rows = [row(), row(), row(), row({ channelId: "c2" })];
        rows.forEach(r => db.insertLive(r));
        const ctx = make([], 2).getContext("c1");
        expect(ctx.map(m => m.content)).toEqual([
            expect.stringContaining("msg 2"),
            expect.stringContaining("msg 3"),
        ]);
    });

    it("renders `[time] Name: text` with the real name and maps Marvin to the assistant role", () => {
        db.insertLive(row({ content: "hej" }));
        db.insertLive(row({ authorId: MARVIN, authorName: "Marvin", isBot: true, content: "no cześć" }));
        db.insertLive(row({ authorId: "bot2", authorName: "Mugda", isBot: true, content: "pranie" }));
        const [human, marvin, otherBot] = make().getContext("c1");
        expect(human.role).toBe("user");
        expect(human.content).toMatch(/^\[\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}\] Jacek: hej$/);
        expect(marvin.role).toBe("assistant");
        expect(marvin.content).toMatch(/\] Marvin: no cześć$/);
        expect(otherBot.role).toBe("user");
    });

    it("includes embeds and attachment descriptions and skips technical and empty messages", () => {
        db.insertLive(row({ content: "zobacz", attachmentsText: "[Obraz: kot]", embedsText: "tytuł" }));
        db.insertLive(row({ authorId: MARVIN, authorName: "Marvin", content: "Zaglądam do linka. 🔗", isTechnical: true }));
        db.insertLive(row({ content: "" }));
        const ctx = make().getContext("c1");
        expect(ctx).toHaveLength(1);
        expect(ctx[0].content).toMatch(/zobacz tytuł \[Obraz: kot\]$/);
    });

    it("uses the in-memory fallback for excluded channels and their threads", () => {
        fallback.pushWithLimit({ role: "user", content: "from memory" }, "secret");
        db.insertLive(row({ channelId: "secret", content: "should not be read" }));
        expect(make(["secret"]).getContext("secret")).toEqual([{ role: "user", content: "from memory" }]);
        fallback.pushWithLimit({ role: "user", content: "thread memory" }, "t1");
        expect(make(["secret"]).getContext("t1", "secret")).toEqual([{ role: "user", content: "thread memory" }]);
    });

    it("falls back to memory when the current message was not archived", () => {
        fallback.pushWithLimit({ role: "user", content: "from memory" }, "c1");
        db.insertLive(row());
        expect(make().getContext("c1", null, "missing-id")).toEqual([{ role: "user", content: "from memory" }]);
    });

    it("falls back to memory when the database read fails", () => {
        fallback.pushWithLimit({ role: "user", content: "from memory" }, "c1");
        db.close();
        expect(make().getContext("c1")).toEqual([{ role: "user", content: "from memory" }]);
        db = new HistoryDb(":memory:");
    });

    it("uses the fallback when there is no database", () => {
        fallback.pushWithLimit({ role: "user", content: "from memory" }, "c1");
        expect(new HistoryContext(null, fallback, [], MARVIN).getContext("c1")).toEqual([{ role: "user", content: "from memory" }]);
    });
});

describe("HistoryDb.getSince", () => {
    it("returns messages after the cutoff, skipping excluded channels, their threads and technical rows", () => {
        const db = new HistoryDb(":memory:");
        const old = row({ createdAt: 1000 });
        db.insertLive(old);
        db.insertLive(row({ createdAt: 5000, content: "ok" }));
        db.insertLive(row({ createdAt: 5001, channelId: "secret", content: "no" }));
        db.insertLive(row({ createdAt: 5002, channelId: "t1", parentId: "secret", content: "no" }));
        db.insertLive(row({ createdAt: 5003, isTechnical: true, content: "no" }));
        expect(db.getSince(2000, ["secret"], 100).map(m => m.content)).toEqual(["ok"]);
        expect(db.getSince(2000, [], 100)).toHaveLength(3);
        db.close();
    });
});
