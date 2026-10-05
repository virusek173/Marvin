import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HistoryDb } from "../db";
import { ArchiveRow, buildArchiveRow, collectReactions } from "../mapper";

const row = (over: Partial<ArchiveRow> = {}): ArchiveRow => ({
    id: "1",
    channelId: "c1",
    parentId: null,
    authorId: "u1",
    authorName: "Vajrusek",
    isBot: false,
    content: "hej",
    embedsText: "",
    attachmentsText: "",
    replyToId: null,
    type: 0,
    isTechnical: false,
    createdAt: 1_700_000_000_000,
    ...over,
});

const emojiOf = (db: HistoryDb, id: string) => db.db.prepare("SELECT emoji, n FROM message_emoji WHERE message_id = ? ORDER BY emoji").all(id);
const reactionsOf = (db: HistoryDb, id: string) => db.db.prepare("SELECT emoji, n FROM reactions WHERE message_id = ? ORDER BY emoji").all(id);

const discordReaction = (name: string, count: number, id: string | null = null) => ({ count, emoji: { id, name } });
const discordMessage = (reactions?: any[]) => ({
    id: "5",
    channelId: "c1",
    channel: { isThread: () => false },
    author: { id: "u1", username: "vaj", globalName: "Vajrusek", bot: false },
    content: "hej",
    embeds: [],
    attachments: new Map(),
    type: 0,
    createdTimestamp: 1_700_000_000_000,
    ...(reactions ? { reactions: { cache: new Map(reactions.map((r, i) => [String(i), r])) } } : null),
});

describe("collectReactions", () => {
    it("reads reaction counts, naming server emoji by name and merging skin tones", () => {
        const message = discordMessage([discordReaction("😂", 3), discordReaction("👍", 1), discordReaction("👍🏽", 2), discordReaction("pepe", 4, "99"), discordReaction("💀", 0)]);
        expect(collectReactions(message)).toEqual([
            { emoji: "😂", count: 3 },
            { emoji: "👍", count: 3 },
            { emoji: ":pepe:", count: 4 },
        ]);
    });

    it("is undefined when the message carries no reaction data, and part of the archive row", () => {
        expect(collectReactions(discordMessage())).toBeUndefined();
        expect(buildArchiveRow(discordMessage([discordReaction("😂", 1)])).reactions).toEqual([{ emoji: "😂", count: 1 }]);
        expect(buildArchiveRow(discordMessage()).reactions).toBeUndefined();
    });
});

describe("emoji and reactions in HistoryDb", () => {
    let db: HistoryDb;
    beforeEach(() => { db = new HistoryDb(":memory:"); });
    afterEach(() => db.close());

    it("indexes the emoji of live messages and re-indexes when the live row replaces a backfilled one", () => {
        db.insertLive(row({ content: "<:pepe:1> 😂😂" }));
        expect(emojiOf(db, "1")).toEqual([{ emoji: ":pepe:", n: 1 }, { emoji: "😂", n: 2 }]);
        db.insertLive(row({ content: "👍" }));
        expect(emojiOf(db, "1")).toEqual([{ emoji: "👍", n: 1 }]);
    });

    it("stores reactions from a backfilled page, also for messages that already exist, and drops removed ones", () => {
        db.insertLive(row({ id: "1", content: "stara" }));
        db.writePage("c1", [row({ id: "1", reactions: [{ emoji: "😂", count: 2 }] }), row({ id: "2", content: "💀", reactions: [{ emoji: "👍", count: 1 }] })], "2");
        expect(reactionsOf(db, "1")).toEqual([{ emoji: "😂", n: 2 }]);
        expect(reactionsOf(db, "2")).toEqual([{ emoji: "👍", n: 1 }]);
        expect(emojiOf(db, "2")).toEqual([{ emoji: "💀", n: 1 }]);

        db.writePage("c1", [row({ id: "1", reactions: [] }), row({ id: "2" })], "2");
        expect(reactionsOf(db, "1")).toEqual([]);
        expect(reactionsOf(db, "2")).toEqual([{ emoji: "👍", n: 1 }]);
    });

    it("setReactions replaces the reactions of an archived message and ignores unknown ones", () => {
        db.insertLive(row());
        expect(db.setReactions("1", [{ emoji: "😂", count: 2 }, { emoji: "👍", count: 1 }])).toBe(true);
        expect(db.setReactions("1", [{ emoji: "👍", count: 4 }])).toBe(true);
        expect(reactionsOf(db, "1")).toEqual([{ emoji: "👍", n: 4 }]);
        expect(db.setReactions("404", [{ emoji: "👍", count: 1 }])).toBe(false);
        expect(reactionsOf(db, "404")).toEqual([]);
    });

    it("removes emoji and reactions together with purged channels", () => {
        db.insertLive(row({ id: "1", channelId: "gone", content: "😂" }));
        db.insertLive(row({ id: "2", channelId: "keep", content: "😂" }));
        db.setReactions("1", [{ emoji: "👍", count: 1 }]);
        db.setReactions("2", [{ emoji: "👍", count: 1 }]);
        expect(db.purgeChannels(["gone"])).toBe(1);
        expect(emojiOf(db, "1")).toEqual([]);
        expect(reactionsOf(db, "1")).toEqual([]);
        expect(emojiOf(db, "2")).toHaveLength(1);
        expect(reactionsOf(db, "2")).toHaveLength(1);
    });
});

describe("HistoryDb migration of an existing archive", () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "marvin-mig-")); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("indexes the emoji of old messages and resets the sync cursors once", () => {
        const file = path.join(dir, "history.db");
        const old = new HistoryDb(file);
        old.writePage("c1", [row({ id: "1", content: "stare 😂" }), row({ id: "2", content: "bez" })], "2");
        old.db.prepare("DELETE FROM message_emoji").run();
        old.db.pragma("user_version = 0");
        old.close();

        const migrated = new HistoryDb(file);
        expect(emojiOf(migrated, "1")).toEqual([{ emoji: "😂", n: 1 }]);
        expect(emojiOf(migrated, "2")).toEqual([]);
        expect(migrated.getSyncState("c1")?.cursor).toBeNull();
        migrated.writePage("c1", [row({ id: "3" })], "3");
        migrated.close();

        const again = new HistoryDb(file);
        expect(again.getSyncState("c1")?.cursor).toBe("3");
        again.close();
    });
});
