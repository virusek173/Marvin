import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HistoryDb } from "../db";
import { ArchiveRow } from "../mapper";
import { HistoryQuery } from "../query";
import { PhraseCounter, tokenize } from "../phrases";
import { collectMonthlyReport, monthOf, parseMonthKey, previousMonth, renderReportBlock, reportFacts, warsawDayOfMonth } from "../report";

const SEPT = Date.UTC(2026, 8, 10, 10, 0);
let n = 0;
const row = (over: Partial<ArchiveRow> = {}): ArchiveRow => {
    n += 1;
    return {
        id: String(7000 + n), channelId: "c1", parentId: null, authorId: "u1", authorName: "Vajrusek", isBot: false,
        content: `wiadomość ${n}`, embedsText: "", attachmentsText: "", replyToId: null, type: 0, isTechnical: false,
        createdAt: SEPT + n * 60_000, ...over,
    };
};

describe("phrases", () => {
    it("drops links, mentions, code, filler words, laughter and numbers", () => {
        const useful = tokenize("Patrz https://x.pl/abc <@123> `kod` hahaha xdxdxd 2024 rower jest świetny")
            .filter(t => t.useful)
            .map(t => t.word);
        expect(useful).toEqual(["patrz", "rower", "świetny"]);
    });

    it("counts a word at most once per message and returns the most common first", () => {
        const c = new PhraseCounter();
        c.add("rower rower rower");
        c.add("rower górski");
        c.add("górski rower");
        c.add("rower górski");
        expect(c.top("words", 5, 1)).toEqual([{ phrase: "rower", count: 4 }, { phrase: "górski", count: 3 }]);
        expect(c.top("pairs", 5, 2)).toEqual([{ phrase: "rower górski", count: 2 }]);
        expect(c.top("words", 5, 4)).toEqual([{ phrase: "rower", count: 4 }]);
    });
});

describe("months", () => {
    it("finds the previous month in Warsaw time, across New Year too", () => {
        expect(previousMonth(Date.UTC(2026, 9, 1, 18, 0)).key).toBe("2026-09");
        expect(previousMonth(Date.UTC(2027, 0, 1, 18, 0)).key).toBe("2026-12");
        // 31.12 23:30 UTC is already 1 January in Warsaw
        expect(previousMonth(Date.UTC(2026, 11, 31, 23, 30)).key).toBe("2026-12");
        expect(warsawDayOfMonth(Date.UTC(2026, 11, 31, 23, 30))).toBe(1);
    });

    it("builds month ranges and parses keys", () => {
        expect(monthOf(2028, 2)).toMatchObject({ from: "2028-02-01", to: "2028-02-29", label: "luty 2028" });
        expect(parseMonthKey("2026-09")?.label).toBe("wrzesień 2026");
        expect(parseMonthKey("2026-13")).toBeNull();
        expect(parseMonthKey("")).toBeNull();
    });
});

describe("monthly report", () => {
    let dir: string;
    let db: HistoryDb;
    let query: HistoryQuery;
    const write = (count: number, over: Partial<ArchiveRow> = {}) => {
        for (let i = 0; i < count; i++) db.insertLive(row(over));
    };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "marvin-report-"));
        const file = path.join(dir, "history.db");
        db = new HistoryDb(file);
        db.upsertChannel("c1", "ogólny", null);
        query = new HistoryQuery(file, { excludedChannelIds: [] });
    });
    afterEach(() => {
        query.close();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("counts only the requested month and only humans, and renders charts from those numbers", () => {
        write(12, { content: "znowu ten rower górski" });
        write(6, { authorId: "u2", authorName: "Odyn", content: "rower górski jest super" });
        write(5, { isBot: true, authorId: "b1", authorName: "Mugda", content: "rower rower" });
        write(8, { createdAt: Date.UTC(2026, 9, 5, 10, 0), content: "październik rower" }); // another month

        const month = monthOf(2026, 9);
        const data = collectMonthlyReport(query, month);

        expect(data.total).toBe(18);
        expect(data.authors).toEqual([{ name: "Jacek", count: 12 }, { name: "Madzia", count: 6 }]);
        expect(data.loudestDays[0]).toEqual({ name: "2026-09-10", count: 18 });
        expect(data.words).toEqual(expect.arrayContaining([{ name: "rower", count: 18 }, { name: "górski", count: 18 }]));
        expect(data.words.map(w => w.name)).not.toContain("październik");
        expect(data.pairs[0]).toEqual({ name: "rower górski", count: 18 });

        const block = renderReportBlock(data);
        expect(block).toContain("Jacek");
        expect(block).toMatch(/Jacek\s+█+ 12/);
        expect(block).toMatch(/Madzia\s+█+ 6/);
        expect(block).toContain("10.09");
        expect(block).not.toMatch(/poprzedni/i);

        const facts = reportFacts(data);
        expect(facts).toContain("wrzesień 2026");
        expect(facts).toContain("Jacek 12");
    });

    it("keeps every chart section within one Discord message part", () => {
        write(30);
        const block = renderReportBlock(collectMonthlyReport(query, monthOf(2026, 9)));
        for (const section of block.split("\n\n")) expect(section.length).toBeLessThan(1900);
    });

    it("returns an empty report for a month without messages", () => {
        const data = collectMonthlyReport(query, monthOf(2026, 1));
        expect(data.total).toBe(0);
        expect(renderReportBlock(data)).toBe("");
    });
});
