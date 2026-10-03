import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HistoryDb } from "../db";
import { ArchiveRow } from "../mapper";
import { HistoryQuery } from "../query";
import { PROFILE_LIMITS, ProfileService } from "../profiles";

const DAY = 86_400_000;
const BASE = Date.UTC(2025, 2, 10, 11, 0);
let n = 0;
const row = (over: Partial<ArchiveRow> = {}): ArchiveRow => {
    n += 1;
    return {
        id: String(5000 + n), channelId: "c1", parentId: null, authorId: "u1", authorName: "Vajrusek", isBot: false,
        content: `wiadomość ${n}`, embedsText: "", attachmentsText: "", replyToId: null, type: 0, isTechnical: false,
        createdAt: BASE + n * 60_000, ...over,
    };
};

describe("ProfileService", () => {
    let dir: string;
    let file: string;
    let db: HistoryDb;
    let now: number;
    const ask = jest.fn();
    const service = (excluded: string[] = []) =>
        new ProfileService(db, { excludedChannelIds: excluded, selfId: "900", ask, systemPrompt: "SYS", now: () => now });
    const write = (count: number, over: Partial<ArchiveRow> = {}) => {
        for (let i = 0; i < count; i++) db.insertLive(row(over));
    };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "marvin-prof-"));
        file = path.join(dir, "history.db");
        db = new HistoryDb(file);
        now = BASE + 30 * DAY;
        ask.mockReset();
        ask.mockResolvedValue("Lubi rowery i żartuje z Dockera.");
        jest.spyOn(console, "log").mockImplementation(() => {});
        jest.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
        jest.restoreAllMocks();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("writes a first profile for regular people only, merging their usernames under one real name", async () => {
        write(20); // Vajrusek -> Jacek
        write(15, { authorId: "u1b", authorName: "Crook" }); // same person, other username
        write(5, { authorId: "u2", authorName: "Rzadki" }); // too few messages
        write(40, { authorId: "u3", authorName: "Techniczny", isTechnical: true });

        const result = await service().updateAll();

        expect(result.updated).toEqual(["Jacek"]);
        expect(ask).toHaveBeenCalledTimes(1);
        const [system, user] = ask.mock.calls[0];
        expect(system).toBe("SYS");
        expect(user).toContain("Osoba: Jacek");
        expect(user).toContain("brak (to pierwszy profil)");
        expect(user).toContain("Wiadomości tej osoby (35)");
        const profile = db.getProfile("Jacek")!;
        expect(profile).toMatchObject({ summary: "Lubi rowery i żartuje z Dockera.", messageCount: 35, updatedAt: now });
        expect(db.getProfile("Rzadki")).toBeUndefined();
    });

    it("profiles other bots as bots but never Marvin himself", async () => {
        write(40, { authorId: "bot1", authorName: "Mugda", isBot: true });
        write(40, { authorId: "900", authorName: "Marvin", isBot: true });
        write(40, { authorId: "bot1", authorName: "Mugda", isBot: true, isTechnical: true, content: "techniczna" });

        const result = await service().updateAll();

        expect(result.updated).toEqual(["Mugda"]);
        expect(ask).toHaveBeenCalledTimes(1);
        const user: string = ask.mock.calls[0][1];
        expect(user).toContain("Bot: Mugda");
        expect(user).toContain("Wiadomości tego bota (40)");
        expect(user).not.toContain("techniczna");
        expect(db.getProfile("Marvin")).toBeUndefined();
    });

    it("leaves a fresh profile alone, then refreshes it incrementally with the old text and only new messages", async () => {
        write(40);
        await service().updateAll();
        const first = db.getProfile("Jacek")!;

        write(30, { content: "nowość o kubernetesie" });
        now += 2 * DAY;
        expect((await service().updateAll()).updated).toEqual([]);
        expect(ask).toHaveBeenCalledTimes(1);

        now += 6 * DAY;
        ask.mockResolvedValue("Teraz też kubernetes.");
        expect((await service().updateAll()).updated).toEqual(["Jacek"]);
        const [, user] = ask.mock.calls[1];
        expect(user).toContain("Dotychczasowy profil:\nLubi rowery i żartuje z Dockera.");
        expect(user).toContain("Wiadomości tej osoby (30)");
        expect(user).toContain("nowość o kubernetesie");
        expect(user).not.toMatch(/\] wiadomość \d+/);
        const second = db.getProfile("Jacek")!;
        expect(second.summary).toBe("Teraz też kubernetes.");
        expect(second.lastSeq).toBeGreaterThan(first.lastSeq);
        expect(second.messageCount).toBe(70);
    });

    it("does not refresh an old profile when too little was written since", async () => {
        write(40);
        await service().updateAll();
        write(PROFILE_LIMITS.minNew - 1);
        now += 30 * DAY;
        expect((await service().updateAll()).updated).toEqual([]);
        expect(ask).toHaveBeenCalledTimes(1);
    });

    it("ignores excluded channels and threads of excluded channels", async () => {
        write(40, { channelId: "secret" });
        write(40, { channelId: "t1", parentId: "secret" });
        write(10);
        const result = await service(["secret"]).updateAll();
        expect(result.updated).toEqual([]);
        expect(ask).not.toHaveBeenCalled();
    });

    it("replaces mentions with names-free placeholders and keeps only the newest lines within the size budget", async () => {
        write(1, { content: "<@123> patrz <@900>" });
        write(50, { content: "x".repeat(PROFILE_LIMITS.lineChars + 100) });
        await service().updateAll();
        const user: string = ask.mock.calls[0][1];
        expect(user).not.toContain("<@123>");
        expect(user).toContain("…");
        expect(user.length).toBeLessThan(PROFILE_LIMITS.totalChars + 1000);
    });

    it("never sends half of an emoji to the model when it clips a long line", async () => {
        write(40, { content: `${"a".repeat(PROFILE_LIMITS.lineChars - 1)}😀 koniec` });
        await service().updateAll();
        const user: string = ask.mock.calls[0][1];
        expect(user).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
        expect(user).toContain("…");
    });

    it("survives a model failure for one person and does not store an empty profile", async () => {
        write(40);
        write(40, { authorId: "u2", authorName: "Odyn" }); // Madzia
        ask.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("   ");
        const result = await service().updateAll();
        expect(result.updated).toEqual([]);
        expect(result.failed.sort()).toEqual(["Jacek", "Madzia"]);
        expect(db.getProfile("Jacek")).toBeUndefined();
        expect(db.getProfile("Madzia")).toBeUndefined();
    });

    it("caps the stored profile length", async () => {
        write(40);
        ask.mockResolvedValue("a".repeat(5000));
        await service().updateAll();
        expect(db.getProfile("Jacek")!.summary).toHaveLength(PROFILE_LIMITS.summaryChars);
    });

    describe("HistoryQuery.profiles", () => {
        it("finds a person by real name or username, lists everyone without a name, and explains misses", async () => {
            write(40);
            write(40, { authorId: "u2", authorName: "Odyn" });
            await service().updateAll();
            const q = new HistoryQuery(file, { excludedChannelIds: [] });
            try {
                expect(q.profiles("jacek").profiles.map(p => p.name)).toEqual(["Jacek"]);
                expect(q.profiles("magda1812").profiles.map(p => p.name)).toEqual(["Madzia"]);
                expect(q.profiles().count).toBe(2);
                const miss = q.profiles("Nikt");
                expect(miss.count).toBe(0);
                expect(miss.note).toContain("Jacek");
            } finally {
                q.close();
            }
        });

        it("says so when no profile exists yet", () => {
            const q = new HistoryQuery(file, { excludedChannelIds: [] });
            try {
                expect(q.profiles().note).toMatch(/jeszcze nie/);
                expect(q.profiles("Madzia").note).toMatch(/Brak profilu/);
            } finally {
                q.close();
            }
        });
    });
});
