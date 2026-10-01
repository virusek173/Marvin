import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HistoryDb } from "../db";
import { ArchiveRow } from "../mapper";
import { HistoryQuery, buildFtsQuery, LIMITS } from "../query";
import { formatWarsaw, parseWarsaw } from "../time";

const MARVIN = "900";
// 2025-03-10 12:00 Warsaw (CET, UTC+1) = 11:00 UTC
const BASE = Date.UTC(2025, 2, 10, 11, 0);
let seq = 0;
const row = (over: Partial<ArchiveRow> = {}): ArchiveRow => {
    seq += 1;
    return {
        id: String(2000 + seq),
        channelId: "c1",
        parentId: null,
        authorId: "u1",
        authorName: "Vajrusek",
        isBot: false,
        content: `wiadomość ${seq}`,
        embedsText: "",
        attachmentsText: "",
        replyToId: null,
        type: 0,
        isTechnical: false,
        createdAt: BASE + seq * 60_000,
        ...over,
    };
};

describe("HistoryQuery", () => {
    let dir: string;
    let file: string;
    let db: HistoryDb;
    let q: HistoryQuery;

    const open = (excluded: string[] = []) => {
        q?.close();
        q = new HistoryQuery(file, { excludedChannelIds: excluded, selfId: MARVIN });
    };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "marvin-q-"));
        file = path.join(dir, "history.db");
        db = new HistoryDb(file);
        db.upsertChannel("c1", "ogolny", null);
        db.upsertChannel("c2", "memy", null);
        db.upsertChannel("secret", "tajny", null);
        db.upsertChannel("t1", "wątek", "secret");
        db.upsertChannel("222", "memy", null);
        open();
    });
    afterEach(() => {
        q.close();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("cannot write: the connection is read-only", () => {
        expect(() => (q as any).db.prepare("DELETE FROM messages").run()).toThrow();
        expect(() => (q as any).db.prepare("INSERT INTO channels (id, updated_at) VALUES ('x', 1)").run()).toThrow();
    });

    describe("search", () => {
        it("finds Polish text ignoring diacritics, prefix-matches inflections, ranks and renders Warsaw time", () => {
            db.insertLive(row({ content: "Kupiłem nową żółtą kurtkę", createdAt: BASE }));
            db.insertLive(row({ content: "nic ciekawego" }));
            const res = q.search({ query: "zolta kurtk" });
            expect(res.count).toBe(1);
            expect(res.timezone).toBe("Europe/Warsaw");
            expect(res.messages[0]).toMatchObject({ author: "Jacek", channel: "ogolny", time: "2025.03.10 12:00" });
            expect(q.search({ query: "kurtk" }).count).toBe(1);
        });

        it("adds a ready-to-paste citation to each message only when the server id is known", () => {
            db.insertLive(row({ id: "777", content: "link test", channelId: "c1", createdAt: BASE }));
            expect(q.search({ query: "link" }).messages[0].cite).toBeUndefined();

            q.close();
            q = new HistoryQuery(file, { excludedChannelIds: [], selfId: MARVIN, guildId: () => "G1" });
            expect(q.search({ query: "link" }).messages[0].cite).toBe("[10.03.2025 12:00](<https://discord.com/channels/G1/c1/777>)");
        });

        it("treats operators and quotes in the query as plain text, never as FTS syntax or SQL", () => {
            db.insertLive(row({ content: "hello world" }));
            expect(() => q.search({ query: `hello" OR world* NEAR(a b) -- ; DROP TABLE messages` })).not.toThrow();
            expect(q.search({ query: `"" ) (` }).note).toBeDefined();
            expect(db.countMessages()).toBe(1);
        });

        it("filters by author given as a real name (all of that person's usernames), channel and dates", () => {
            db.insertLive(row({ content: "pizza jacek", authorName: "Vajrusek" }));
            db.insertLive(row({ content: "pizza jacek stary nick", authorName: "Crook", authorId: "u9" }));
            db.insertLive(row({ content: "pizza domin", authorName: "Hardik", authorId: "u2" }));
            db.insertLive(row({ content: "pizza memy", channelId: "c2" }));
            expect(q.search({ query: "pizza", author: "jacek" }).messages.map(m => m.text).sort())
                .toEqual(["pizza jacek", "pizza jacek stary nick", "pizza memy"]);
            expect(q.search({ query: "pizza", author: "Domin" }).count).toBe(1);
            expect(q.search({ query: "pizza", channel: "#memy" }).count).toBe(1);
            expect(q.search({ query: "pizza", channel: "nieistnieje" }).note).toMatch(/Nie znam kanału/);
            expect(q.search({ query: "pizza", from: "2025-03-11" }).count).toBe(0);
            expect(q.search({ query: "pizza", from: "2025-03-10", to: "2025-03-10" }).count).toBe(4);
            expect(q.search({ query: "pizza", from: "wczoraj" }).note).toMatch(/Niepoprawna data/);
        });

        it("caps the number of results", () => {
            for (let i = 0; i < 40; i++) db.insertLive(row({ content: "powtarzalne słowo" }));
            const res = q.search({ query: "powtarzalne", limit: 1000 });
            expect(res.count).toBe(LIMITS.searchMax);
            expect(res.truncated).toBe(true);
            expect(q.search({ query: "powtarzalne" }).count).toBe(LIMITS.searchDefault);
        });

        it("clips long messages and the total size", () => {
            for (let i = 0; i < 40; i++) db.insertLive(row({ content: `długie ${"a".repeat(2000)}` }));
            const res = q.search({ query: "długie", limit: 25 });
            expect(res.messages[0].text.length).toBeLessThanOrEqual(LIMITS.textChars + 1);
            expect(res.messages.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(LIMITS.totalChars);
            expect(res.truncated).toBe(true);
        });

        it("keeps the matched word visible when it sits far into a long message", () => {
            db.insertLive(row({ content: `${"Wstęp ".repeat(120)}Uwaga ROWERY! i dalej ${"koniec ".repeat(100)}` }));
            const text = q.search({ query: "rowery" }).messages[0].text;
            expect(text).toMatch(/ROWERY/);
            expect(text.length).toBeLessThanOrEqual(LIMITS.textChars + 2);
            expect(text.startsWith("…")).toBe(true);
        });

        it("hides excluded channels and their threads even if old data remains, and technical messages", () => {
            db.insertLive(row({ content: "sekret", channelId: "secret" }));
            db.insertLive(row({ content: "sekret w wątku", channelId: "t1", parentId: "secret" }));
            db.insertLive(row({ content: "sekret jawny" }));
            db.insertLive(row({ content: "sekret techniczny", isTechnical: true, authorId: MARVIN, authorName: "Marvin" }));
            open(["secret"]);
            expect(q.search({ query: "sekret" }).messages.map(m => m.text)).toEqual(["sekret jawny"]);
            expect(q.range({}).messages.map(m => m.text)).toEqual(["sekret jawny"]);
            expect(q.listChannels().map(c => c.id)).not.toContain("secret");
            expect(q.listChannels().map(c => c.id)).not.toContain("t1");
        });

        it("replaces mentions with names", () => {
            db.insertLive(row({ authorId: "123", authorName: "Hardik", content: "elo" }));
            db.insertLive(row({ content: `<@123> i <@${MARVIN}> patrzcie na <#222> oraz <@555>` }));
            const res = q.search({ query: "patrzcie" });
            expect(res.messages[0].text).toBe("@Domin i @Marvin patrzcie na #memy oraz @ktoś");
        });
    });

    describe("range", () => {
        it("returns messages oldest first within Warsaw date bounds", () => {
            db.insertLive(row({ content: "wcześnie", createdAt: Date.UTC(2025, 2, 9, 22, 30) })); // 23:30 on the 9th Warsaw
            db.insertLive(row({ content: "dzień", createdAt: Date.UTC(2025, 2, 10, 8, 0) }));
            db.insertLive(row({ content: "wieczór", createdAt: Date.UTC(2025, 2, 10, 22, 59) })); // 23:59 Warsaw
            db.insertLive(row({ content: "jutro", createdAt: Date.UTC(2025, 2, 10, 23, 1) })); // 00:01 on the 11th
            const res = q.range({ from: "2025-03-10", to: "2025-03-10" });
            expect(res.messages.map(m => m.text)).toEqual(["dzień", "wieczór"]);
        });

        it("with newest returns the latest messages of the range, still oldest first", () => {
            for (let i = 1; i <= 10; i++) db.insertLive(row({ content: `m${i}` }));
            const res = q.range({ limit: 3, newest: true });
            expect(res.messages.map(m => m.text)).toEqual(["m8", "m9", "m10"]);
            expect(res.truncated).toBe(true);
            expect(q.range({ limit: 3 }).messages.map(m => m.text)).toEqual(["m1", "m2", "m3"]);
            expect(q.range({ limit: 50, newest: true }).truncated).toBe(false);
        });

        it("caps results and marks truncation", () => {
            for (let i = 0; i < 150; i++) db.insertLive(row());
            const res = q.range({ limit: 500 });
            expect(res.count).toBe(LIMITS.rangeMax);
            expect(res.truncated).toBe(true);
        });
    });

    describe("around", () => {
        it("returns neighbours in the same channel, in order, capped", () => {
            const rows = Array.from({ length: 10 }, (_, i) => row({ content: `n${i}` }));
            rows.forEach(r => db.insertLive(r));
            db.insertLive(row({ content: "inny kanał", channelId: "c2" }));
            const res = q.around({ messageId: rows[5].id, before: 2, after: 3 });
            expect(res.messages.map(m => m.text)).toEqual(["n3", "n4", "n5", "n6", "n7", "n8"]);
            expect(q.around({ messageId: rows[5].id, before: 999, after: 999 }).count).toBe(10);
            expect(q.around({ messageId: "nope" }).note).toBeDefined();
        });

        it("refuses to show messages from excluded channels", () => {
            const r = row({ channelId: "secret" });
            db.insertLive(r);
            open(["secret"]);
            expect(q.around({ messageId: r.id }).count).toBe(0);
        });
    });

    it("lists channels with names, thread parents and counts", () => {
        db.insertLive(row());
        db.insertLive(row({ channelId: "t1", parentId: "secret" }));
        const list = q.listChannels();
        expect(list.find(c => c.id === "c1")).toMatchObject({ name: "ogolny", messages: 1 });
        expect(list.find(c => c.id === "t1")).toMatchObject({ name: "wątek", parentName: "tajny" });
        expect(list.find(c => c.id === "c2")).toBeUndefined();
    });
});

describe("buildFtsQuery", () => {
    it("quotes folded tokens as prefix terms", () => {
        expect(buildFtsQuery("Łódź, kot!")).toBe('"Lódź"* "kot"*');
        expect(buildFtsQuery("  ")).toBeNull();
    });
});

describe("Warsaw time", () => {
    it("formats in Warsaw time, with and without DST", () => {
        expect(formatWarsaw(Date.UTC(2025, 0, 15, 11, 0))).toBe("2025.01.15 12:00");
        expect(formatWarsaw(Date.UTC(2025, 6, 15, 10, 0))).toBe("2025.07.15 12:00");
    });

    it("parses date-only and date-time bounds", () => {
        expect(parseWarsaw("2025-01-15")).toBe(Date.UTC(2025, 0, 14, 23, 0));
        expect(parseWarsaw("2025-01-15", true)).toBe(Date.UTC(2025, 0, 15, 23, 0));
        expect(parseWarsaw("2025-07-15T12:30")).toBe(Date.UTC(2025, 6, 15, 10, 30));
        expect(parseWarsaw("2025-02-30")).toBeNull();
        expect(parseWarsaw("2025-01-15T25:00")).toBeNull();
        expect(parseWarsaw("jutro")).toBeNull();
    });
});
