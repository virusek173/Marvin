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
        it("matches the channel name ignoring case and Polish diacritics", () => {
            db.upsertChannel("c3", "Ogólny-Żart", null);
            db.insertLive(row({ content: "dowcip dnia", channelId: "c3" }));
            expect(q.search({ query: "dowcip", channel: "ogolny-zart" }).count).toBe(1);
            expect(q.search({ query: "dowcip", channel: "#OGÓLNY-ŻART" }).count).toBe(1);
        });

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

        it("skips bot messages unless an author or include_bots is given", () => {
            db.insertLive(row({ content: "wyjazd do Basi planowany", authorName: "Vajrusek" }));
            db.insertLive(row({ content: "wyjazd do Basi w bajce", authorId: MARVIN, authorName: "Marvin", isBot: true }));
            expect(q.search({ query: "wyjazd" }).messages.map(m => m.text)).toEqual(["wyjazd do Basi planowany"]);
            expect(q.search({ query: "wyjazd", includeBots: true }).count).toBe(2);
            expect(q.search({ query: "wyjazd", author: "Marvin" }).messages.map(m => m.text)).toEqual(["wyjazd do Basi w bajce"]);
        });

        it("falls back to any of the words when no message has all of them", () => {
            db.insertLive(row({ content: "Basia jedzie nad morze" }));
            db.insertLive(row({ content: "wyjazd jest w piątek" }));
            const res = q.search({ query: "wyjazd Basi" });
            expect(res.count).toBe(2);
            expect(res.note).toMatch(/którymkolwiek/);
            db.insertLive(row({ content: "wyjazd Basi w sobotę" }));
            const exact = q.search({ query: "wyjazd Basi" });
            expect(exact.messages.map(m => m.text)).toEqual(["wyjazd Basi w sobotę"]);
            expect(exact.note).toBeUndefined();
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
            expect(res.truncated).toBe(false);
            expect(q.range({ limit: 3 }).messages.map(m => m.text)).toEqual(["m1", "m2", "m3"]);
            expect(q.range({ limit: 3 }).truncated).toBe(true);
            expect(q.range({ limit: 50, newest: true }).truncated).toBe(false);
        });

        it("keeps the whole serialized result (metadata and links included) within the budget", () => {
            q.close();
            q = new HistoryQuery(file, { excludedChannelIds: [], selfId: MARVIN, guildId: () => "1279484250936311909" });
            for (let i = 0; i < 100; i++) db.insertLive(row({ content: "ą".repeat(1500) }));
            const res = q.range({ limit: 100 });
            expect(JSON.stringify(res).length).toBeLessThanOrEqual(LIMITS.totalChars + 500);
            expect(res.truncated).toBe(true);
        });

        it("with newest still flags a cut caused by the size budget", () => {
            for (let i = 0; i < 100; i++) db.insertLive(row({ content: "x".repeat(2000) }));
            const res = q.range({ limit: 100, newest: true });
            expect(res.count).toBeLessThan(100);
            expect(res.truncated).toBe(true);
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

    describe("scoped (hides the question being answered and newer messages)", () => {
        it("excludes the cutoff message and everything after it from every query", () => {
            const old1 = row({ content: "rower stary" });
            const old2 = row({ content: "rower drugi" });
            const question = row({ content: "ile mamy rower" });
            const after = row({ content: "rower po pytaniu" });
            [old1, old2, question, after].forEach(r => db.insertLive(r));
            const s = q.scoped(question.id);

            expect(s.search({ query: "rower" }).messages.map(m => m.text).sort()).toEqual(["rower drugi", "rower stary"]);
            expect(s.range({ newest: true, limit: 10 }).messages.map(m => m.text)).toEqual(["rower stary", "rower drugi"]);
            expect(s.stats({ query: "rower" }).total).toBe(2);
            expect(s.stats({}).total).toBe(2);
            expect(s.around({ messageId: old2.id, after: 5 }).messages.map(m => m.text)).toEqual(["rower stary", "rower drugi"]);
            expect(s.conversation({ messageId: old2.id }).messages.map(m => m.text)).toEqual(["rower stary", "rower drugi"]);
            expect(s.around({ messageId: question.id }).count).toBe(0);
            expect(s.conversation({ messageId: after.id }).count).toBe(0);
        });

        it("leaves the unscoped query untouched and ignores a non-numeric id", () => {
            const r = row({ content: "rower" });
            db.insertLive(r);
            q.scoped(r.id);
            expect(q.search({ query: "rower" }).count).toBe(1);
            expect(q.scoped("abc")).toBe(q);
        });

        it("combines with excluded channels", () => {
            const a = row({ content: "rower a" });
            const hidden = row({ content: "rower b", channelId: "secret" });
            const question = row({ content: "pytanie" });
            [a, hidden, question].forEach(r => db.insertLive(r));
            open(["secret"]);
            expect(q.scoped(question.id).search({ query: "rower" }).messages.map(m => m.text)).toEqual(["rower a"]);
        });
    });

    describe("conversation", () => {
        const at = (minutes: number, over: Partial<ArchiveRow> = {}) => {
            const r = row({ createdAt: BASE + minutes * 60_000, content: `m${minutes}`, ...over });
            db.insertLive(r);
            return r;
        };

        it("returns the whole conversation around a message, split by gaps longer than the limit", () => {
            at(0); at(10); at(25);
            const anchor = at(40);
            at(60);
            at(200); at(210);
            const res = q.conversation({ messageId: anchor.id });
            expect(res.messages.map(m => m.text)).toEqual(["m0", "m10", "m25", "m40", "m60"]);
            expect(res.conversation).toMatchObject({ messages: 5, gapMinutes: 30, start: "2025.03.10 12:00", end: "2025.03.10 13:00" });
            expect(res.truncated).toBe(false);
            expect(q.conversation({ messageId: anchor.id, gapMinutes: 10 }).messages.map(m => m.text)).toEqual(["m40"]);
            expect(q.conversation({ messageId: anchor.id, gapMinutes: 15 }).messages.map(m => m.text)).toEqual(["m0", "m10", "m25", "m40"]);
            expect(q.conversation({ messageId: anchor.id, gapMinutes: 500 }).count).toBe(7);
        });

        it("stays in the channel and ignores technical messages", () => {
            at(0);
            const anchor = at(5);
            at(6, { channelId: "c2" });
            at(7, { isTechnical: true });
            at(8);
            expect(q.conversation({ messageId: anchor.id }).messages.map(m => m.text)).toEqual(["m0", "m5", "m8"]);
        });

        it("returns a window centred on the message when the conversation exceeds the limit", () => {
            const rows = Array.from({ length: 21 }, (_, i) => at(i));
            const res = q.conversation({ messageId: rows[10].id, limit: 5 });
            expect(res.messages.map(m => m.text)).toEqual(["m8", "m9", "m10", "m11", "m12"]);
            expect(res.truncated).toBe(true);
            expect(res.conversation?.messages).toBe(21);
            const edge = q.conversation({ messageId: rows[1].id, limit: 5 });
            expect(edge.messages.map(m => m.text)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
        });

        it("handles a single message, an unknown id and excluded channels", () => {
            const lone = at(0);
            expect(q.conversation({ messageId: lone.id })).toMatchObject({ count: 1, conversation: { messages: 1 } });
            expect(q.conversation({ messageId: "nope" }).note).toBeDefined();
            const hidden = at(1, { channelId: "secret" });
            open(["secret"]);
            expect(q.conversation({ messageId: hidden.id }).count).toBe(0);
        });
    });

    describe("stats", () => {
        const keys = (res: { groups: { key: string; count: number }[] }) => res.groups.map(g => `${g.key}=${g.count}`);

        it("counts per author, merging usernames of one person and skipping bots by default", () => {
            for (let i = 0; i < 3; i++) db.insertLive(row({ authorId: "u1", authorName: "Vajrusek" }));
            for (let i = 0; i < 2; i++) db.insertLive(row({ authorId: "u2", authorName: "Madzia" }));
            db.insertLive(row({ authorId: MARVIN, authorName: "Marvin", isBot: true }));
            db.insertLive(row({ authorId: "u1", authorName: "Vajrusek", isTechnical: true }));

            const res = q.stats({ groupBy: "author" });
            expect(res.total).toBe(5);
            expect(keys(res)).toEqual(["Jacek=3", "Madzia=2"]);
            expect(res.groups[0].share).toBe(60);

            const withBots = q.stats({ groupBy: "author", includeBots: true });
            expect(withBots.total).toBe(6);
            expect(keys(withBots)).toContain("Marvin=1");
            expect(keys(q.stats({ groupBy: "author", author: "Marvin" }))).toEqual(["Marvin=1"]);
        });

        it("groups per channel, naming threads after their parent", () => {
            db.insertLive(row({ channelId: "c1" }));
            db.insertLive(row({ channelId: "c1" }));
            db.insertLive(row({ channelId: "t1", parentId: "secret" }));
            expect(keys(q.stats({ groupBy: "channel" }))).toEqual(["ogolny=2", "wątek (wątek w #tajny)=1"]);
        });

        it("buckets by Warsaw-time day, month, weekday and hour", () => {
            const at = (utc: number) => db.insertLive(row({ createdAt: utc }));
            at(Date.UTC(2025, 2, 10, 22, 30)); // Mon 23:30 Warsaw
            at(Date.UTC(2025, 2, 10, 23, 30)); // Tue 00:30 Warsaw
            at(Date.UTC(2025, 3, 5, 9, 0)); // Sat 11:00 Warsaw (CEST)
            expect(keys(q.stats({ groupBy: "day", sort: "key" }))).toEqual(["2025-03-10=1", "2025-03-11=1", "2025-04-05=1"]);
            expect(keys(q.stats({ groupBy: "month" }))).toEqual(["2025-03=2", "2025-04=1"]);
            expect(keys(q.stats({ groupBy: "weekday" }))).toEqual(["poniedziałek=1", "wtorek=1", "sobota=1"]);
            expect(keys(q.stats({ groupBy: "hour" }))).toEqual(["00:00=1", "11:00=1", "23:00=1"]);
        });

        it("applies the query, channel and date filters", () => {
            db.insertLive(row({ content: "rower jest super", createdAt: Date.UTC(2025, 2, 10, 11, 0) }));
            db.insertLive(row({ content: "mój rower", createdAt: Date.UTC(2025, 5, 10, 11, 0) }));
            db.insertLive(row({ content: "coś innego", createdAt: Date.UTC(2025, 5, 11, 11, 0) }));
            expect(q.stats({ query: "rower" }).total).toBe(2);
            expect(keys(q.stats({ query: "rower", groupBy: "month" }))).toEqual(["2025-03=1", "2025-06=1"]);
            expect(q.stats({ from: "2025-06-01" }).total).toBe(2);
            expect(q.stats({ channel: "memy" }).total).toBe(0);
            expect(q.stats({ channel: "nie ma takiego" }).note).toMatch(/Nie znam kanału/);
        });

        it("returns the total with first and last message time when not grouped", () => {
            db.insertLive(row({ createdAt: Date.UTC(2025, 2, 10, 11, 0) }));
            db.insertLive(row({ createdAt: Date.UTC(2025, 2, 12, 11, 0) }));
            const res = q.stats({});
            expect(res).toMatchObject({ total: 2, groupBy: "none", groups: [], first: "2025.03.10 12:00", last: "2025.03.12 12:00" });
        });

        it("limits the number of groups and flags the cut", () => {
            for (let i = 0; i < 5; i++) db.insertLive(row({ authorId: `x${i}`, authorName: `user${i}` }));
            const res = q.stats({ groupBy: "author", limit: 2 });
            expect(res.groups).toHaveLength(2);
            expect(res.truncated).toBe(true);
            expect(res.total).toBe(5);
        });

        it("hides excluded channels", () => {
            db.insertLive(row({ channelId: "c1" }));
            db.insertLive(row({ channelId: "secret" }));
            db.insertLive(row({ channelId: "t1", parentId: "secret" }));
            open(["secret"]);
            expect(q.stats({ groupBy: "channel" }).total).toBe(1);
        });

        it("filters replies by the author of the replied-to message", () => {
            db.insertLive(row({ id: "m1", authorId: "u1", authorName: "Vajrusek" }));
            db.insertLive(row({ id: "m2", authorId: "u2", authorName: "Madzia" }));
            db.insertLive(row({ authorId: "u2", authorName: "Madzia", replyToId: "m1" }));
            db.insertLive(row({ authorId: "u2", authorName: "Madzia", replyToId: "m1" }));
            db.insertLive(row({ authorId: "u1", authorName: "Vajrusek", replyToId: "m2" }));
            db.insertLive(row({ authorId: "u2", authorName: "Madzia", replyToId: "nie-ma" }));
            expect(q.stats({ author: "Madzia", replyTo: "Jacek" }).total).toBe(2);
            expect(q.stats({ author: "Jacek", replyTo: "Madzia" }).total).toBe(1);
            expect(q.stats({ replyTo: "Jacek", groupBy: "author" }).groups.map(g => g.key)).toEqual(["Madzia"]);
            expect(q.stats({ replyTo: "Nikt" }).total).toBe(0);
            expect(q.range({ author: "Madzia", replyTo: "Jacek" }).messages).toHaveLength(2);
        });

        it("adds average message length only with withLength (or sort length), ignoring empty text", () => {
            db.insertLive(row({ authorId: "u1", authorName: "Vajrusek", content: "ala ma kota" }));
            db.insertLive(row({ authorId: "u1", authorName: "Vajrusek", content: "ok" }));
            db.insertLive(row({ authorId: "u1", authorName: "Vajrusek", content: "", attachmentsText: "zdjęcie" }));
            db.insertLive(row({ authorId: "u2", authorName: "Madzia", content: "a" }));

            expect(q.stats({ groupBy: "author" }).groups[0]).not.toHaveProperty("avgChars");

            const res = q.stats({ groupBy: "author", withLength: true });
            expect(res).toMatchObject({ total: 4, textMessages: 3, avgChars: 4.7, avgWords: 1.7 });
            expect(res.groups.find(g => g.key === "Jacek")).toMatchObject({ count: 3, textMessages: 2, avgChars: 6.5, avgWords: 2 });

            const sorted = q.stats({ groupBy: "author", sort: "length" });
            expect(sorted.groups.map(g => g.key)).toEqual(["Jacek", "Madzia"]);
            expect(sorted.groups[1]).toMatchObject({ avgChars: 1, avgWords: 1 });
        });

        it("reports the archive start as a Warsaw date, ignoring technical and excluded messages", () => {
            expect(q.archiveStart()).toBeUndefined();
            db.insertLive(row({ createdAt: Date.UTC(2021, 0, 15, 10, 0), channelId: "secret" }));
            db.insertLive(row({ createdAt: Date.UTC(2021, 0, 10, 10, 0), isTechnical: true }));
            db.insertLive(row({ createdAt: Date.UTC(2022, 5, 1, 10, 0) }));
            expect(q.archiveStart()).toBe("15.01.2021");
            open(["secret"]);
            expect(q.archiveStart()).toBe("01.06.2022");
        });
    });

    describe("emoji and reactions", () => {
        const add = (over: Partial<ArchiveRow>, reactions: { emoji: string; count: number }[] = []) => {
            const r = row(over);
            db.insertLive(r);
            if (reactions.length) db.setReactions(r.id, reactions);
            return r;
        };

        it("filters by emoji in the text and by reaction received, accepting several spellings", () => {
            add({ content: "haha 😂😂" });
            add({ content: "<:pepe:1> smutek" }, [{ emoji: "😂", count: 2 }]);
            add({ content: "zwykły tekst" }, [{ emoji: ":pepe:", count: 1 }]);
            expect(q.stats({ emoji: "😂" }).total).toBe(1);
            expect(q.stats({ emoji: ":pepe:" }).total).toBe(1);
            expect(q.stats({ emoji: "PEPE" }).total).toBe(1);
            expect(q.stats({ reaction: "😂" }).total).toBe(1);
            expect(q.stats({ reaction: "pepe" }).total).toBe(1);
            expect(q.stats({ emoji: "😂", reaction: "😂" }).total).toBe(0);
            expect(q.search({ query: "tekst", reaction: ":pepe:" }).count).toBe(1);
            expect(q.range({ emoji: "😂" }).messages).toHaveLength(1);
            expect(q.stats({ emoji: "to nie emoji!" }).note).toMatch(/Nie rozpoznaję emoji/);
        });

        it("reports how many times an emoji was used next to the number of messages containing it", () => {
            add({ content: "😂😂😂" });
            add({ content: "ha 😂" });
            add({ content: "nic" });
            expect(q.stats({ emoji: "😂" })).toMatchObject({ total: 2, emojiUses: 4 });
            expect(q.stats({})).not.toHaveProperty("emojiUses");
        });

        it("groups by emoji used in text and by reaction, with the share of all uses", () => {
            add({ content: "😂😂 i 👍" });
            add({ content: "<:pepe:1> 😂" }, [{ emoji: "👍", count: 3 }, { emoji: "😂", count: 1 }]);
            add({ content: "bot 😂", authorId: "u9", authorName: "Rescheduler", isBot: true });

            const used = q.stats({ groupBy: "emoji" });
            expect(used.groups[0]).toMatchObject({ key: "😂", count: 3 });
            expect(used.groups.slice(1).map(g => g.key).sort()).toEqual([":pepe:", "👍"]);
            expect(used.totalUses).toBe(5);

            const reacted = q.stats({ groupBy: "reaction" });
            expect(reacted.groups.map(g => [g.key, g.count])).toEqual([["👍", 3], ["😂", 1]]);
            expect(reacted.totalUses).toBe(4);
            expect(q.stats({ groupBy: "emoji", author: "Rescheduler" }).groups).toEqual([expect.objectContaining({ key: "😂", count: 1 })]);
        });

        it("adds received reaction counts with withReactions and sorts by them", () => {
            add({ authorId: "u1", authorName: "Vajrusek" }, [{ emoji: "👍", count: 2 }]);
            add({ authorId: "u2", authorName: "Madzia" }, [{ emoji: "😂", count: 5 }, { emoji: "👍", count: 1 }]);
            add({ authorId: "u2", authorName: "Madzia" });

            expect(q.stats({ groupBy: "author" }).groups[0]).not.toHaveProperty("reactions");
            const res = q.stats({ groupBy: "author", sort: "reactions" });
            expect(res.reactions).toBe(8);
            expect(res.groups.map(g => [g.key, g.reactions])).toEqual([["Madzia", 6], ["Jacek", 2]]);

            const onlyLaugh = q.stats({ groupBy: "author", withReactions: true, reaction: "😂" });
            expect(onlyLaugh.groups).toEqual([expect.objectContaining({ key: "Madzia", reactions: 5 })]);
        });

        it("renders reactions on messages and server emoji as :name:", () => {
            add({ content: "patrz <:pepe:123456789> proszę" }, [{ emoji: "😂", count: 2 }, { emoji: ":pepe:", count: 1 }]);
            const msg = q.range({}).messages[0];
            expect(msg.text).toBe("patrz :pepe: proszę");
            expect(msg.reactions).toEqual({ "😂": 2, ":pepe:": 1 });
        });

        it("topReacted ranks by total reactions, or by one reaction, humans only by default", () => {
            const a = add({ content: "skromna" }, [{ emoji: "👍", count: 1 }]);
            const b = add({ content: "hit" }, [{ emoji: "👍", count: 2 }, { emoji: "😂", count: 6 }]);
            const c = add({ content: "pochwała" }, [{ emoji: "👍", count: 4 }]);
            add({ content: "bot", authorId: "u9", authorName: "Rescheduler", isBot: true }, [{ emoji: "👍", count: 50 }]);
            add({ content: "bez reakcji" });

            const top = q.topReacted({});
            expect(top.messages.map(m => m.id)).toEqual([b.id, c.id, a.id]);
            expect(top.messages[0]).toMatchObject({ reactionCount: 8, reactions: { "😂": 6, "👍": 2 } });

            expect(q.topReacted({ reaction: "👍" }).messages.map(m => m.id)).toEqual([c.id, b.id, a.id]);
            expect(q.topReacted({ limit: 1 }).messages).toHaveLength(1);
            expect(q.topReacted({ includeBots: true }).messages[0].text).toBe("bot");
            expect(q.topReacted({ reaction: "💀" }).note).toBeDefined();
        });

        it("hides reactions on the asking message and newer ones in a scoped view", () => {
            const old = add({ content: "stare" }, [{ emoji: "👍", count: 1 }]);
            const question = add({ content: "marvin, co lubimy?" }, [{ emoji: "👍", count: 9 }]);
            const s = q.scoped(question.id);
            expect(s.topReacted({}).messages.map(m => m.id)).toEqual([old.id]);
            expect(s.stats({ groupBy: "reaction" }).totalUses).toBe(1);
        });

        it("keeps excluded channels out of emoji and reaction results", () => {
            add({ content: "tajne 😂", channelId: "secret" }, [{ emoji: "😂", count: 4 }]);
            open(["secret"]);
            expect(q.stats({ groupBy: "emoji" }).groups).toEqual([]);
            expect(q.stats({ groupBy: "reaction" }).groups).toEqual([]);
            expect(q.topReacted({}).messages).toEqual([]);
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
