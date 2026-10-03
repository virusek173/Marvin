import { HistoryDb, foldForSearch } from "../db";
import { ArchiveRow } from "../mapper";
import { MessageArchive, getExcludedChannelIds } from "../archive";

const row = (over: Partial<ArchiveRow> = {}): ArchiveRow => ({
    id: "1",
    channelId: "c1",
    parentId: null,
    authorId: "u1",
    authorName: "Vajrusek",
    isBot: false,
    content: "Zażółć gęślą jaźń",
    embedsText: "",
    attachmentsText: "",
    replyToId: null,
    type: 0,
    isTechnical: false,
    createdAt: 1_700_000_000_000,
    ...over,
});

const search = (db: HistoryDb, q: string): string[] =>
    (db.db
        .prepare("SELECT m.id FROM messages_fts f JOIN messages m ON m.seq = f.rowid WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts)")
        .all(foldForSearch(q)) as { id: string }[]).map(r => r.id);

describe("HistoryDb", () => {
    let db: HistoryDb;
    beforeEach(() => { db = new HistoryDb(":memory:"); });
    afterEach(() => db.close());

    it("indexes messages for full-text search ignoring Polish diacritics, including ł", () => {
        db.insertLive(row());
        expect(search(db, "zazolc")).toEqual(["1"]);
        expect(search(db, "GĘŚLĄ")).toEqual(["1"]);
        expect(search(db, "jazn")).toEqual(["1"]);
        expect(search(db, "kot")).toEqual([]);
    });

    it("indexes embeds and attachment descriptions", () => {
        db.insertLive(row({ id: "2", content: "", embedsText: "Niedziela handlowa", attachmentsText: "[Obraz: pies na łące]" }));
        expect(search(db, "niedziela")).toEqual(["2"]);
        expect(search(db, "lace")).toEqual(["2"]);
    });

    it("does not duplicate a message inserted twice and lets the richer live row win", () => {
        db.insertLive(row({ attachmentsText: "[Obraz: nieopisany, plik a.png]" }));
        db.insertLive(row({ attachmentsText: "[Obraz: kot na kanapie]" }));
        expect(db.countMessages()).toBe(1);
        expect(search(db, "kanapie")).toEqual(["1"]);
        expect(search(db, "nieopisany")).toEqual([]);
    });

    it("keeps the full-text index consistent when rows are purged", () => {
        db.insertLive(row({ id: "1", channelId: "keep" }));
        db.insertLive(row({ id: "2", channelId: "drop" }));
        db.insertLive(row({ id: "3", channelId: "thread", parentId: "drop" }));
        db.upsertChannel("drop", "tajny", null);
        db.upsertChannel("thread", "wątek", "drop");
        expect(db.purgeChannels(["drop"])).toBe(2);
        expect(search(db, "zazolc")).toEqual(["1"]);
        expect((db.db.prepare("SELECT COUNT(*) AS n FROM channels").get() as any).n).toBe(0);
    });

    it("stores booleans and nullable fields", () => {
        db.insertLive(row({ isBot: true, isTechnical: true, replyToId: "9" }));
        const r = db.db.prepare("SELECT is_bot, is_technical, reply_to_id FROM messages").get() as any;
        expect(r).toEqual({ is_bot: 1, is_technical: 1, reply_to_id: "9" });
    });
});

describe("MessageArchive", () => {
    const message = (over: any = {}) => ({
        id: "100",
        channelId: "c1",
        channel: { name: "ogólny", isThread: () => false },
        author: { id: "u1", username: "vaj", globalName: "Vajrusek", bot: false },
        content: "cześć",
        embeds: [],
        attachments: new Map(),
        type: 0,
        createdTimestamp: 1_700_000_000_000,
        ...over,
    });

    it("skips excluded channels, including threads of excluded channels", () => {
        const db = new HistoryDb(":memory:");
        const archive = new MessageArchive(db, { excludedChannelIds: ["secret"] });
        archive.archive(message({ id: "1", channelId: "secret" }));
        archive.archive(message({ id: "2", channelId: "t1", channel: { name: "t", isThread: () => true, parentId: "secret" } }));
        archive.archive(message({ id: "3" }));
        expect(db.countMessages()).toBe(1);
    });

    it("never throws when the database fails", () => {
        const db = new HistoryDb(":memory:");
        const archive = new MessageArchive(db, { excludedChannelIds: [] });
        db.close();
        const errors = jest.spyOn(console, "error").mockImplementation(() => {});
        expect(() => archive.archive(message())).not.toThrow();
        expect(errors).toHaveBeenCalled();
        errors.mockRestore();
    });

    it("does nothing when the database is unavailable", () => {
        expect(() => new MessageArchive(null, { excludedChannelIds: [] }).archive(message())).not.toThrow();
    });
});

describe("getExcludedChannelIds", () => {
    it("merges the new and legacy variables without duplicates", () => {
        expect(getExcludedChannelIds({ EXCLUDED_CHANNEL_IDS: "1, 2", SUMMARY_EXCLUDED_CHANNEL_IDS: "2,3" } as any)).toEqual(["1", "2", "3"]);
        expect(getExcludedChannelIds({} as any)).toEqual([]);
    });
});
