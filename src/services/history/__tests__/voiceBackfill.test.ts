import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HistoryDb } from "../db";
import { ArchiveRow, UNTRANSCRIBED_VOICE_TEXT } from "../mapper";
import { VoiceBackfill } from "../voiceBackfill";

let n = 0;
const row = (over: Partial<ArchiveRow> = {}): ArchiveRow => {
    n += 1;
    return {
        id: String(5000 + n), channelId: "c1", parentId: null, authorId: "u1", authorName: "Adam", isBot: false,
        content: "", embedsText: "", attachmentsText: UNTRANSCRIBED_VOICE_TEXT, replyToId: null, type: 0, isTechnical: false,
        createdAt: 1_700_000_000_000 + n, ...over,
    };
};

const voiceMessage = (over: Record<string, unknown> = {}) => ({
    attachments: new Map([["1", { name: "voice-message.ogg", contentType: "audio/ogg", duration: 5, size: 1000, url: "https://cdn.discordapp.com/a.ogg", ...over }]]),
});

describe("VoiceBackfill", () => {
    let dir: string;
    let db: HistoryDb;
    const download = jest.fn(async () => Buffer.from("x"));
    const transcribe = jest.fn(async () => "Dzień dobry");
    const sleep = async () => {};
    const make = (fetchMessage: (c: string, id: string) => Promise<any>, extra: object = {}) =>
        new VoiceBackfill(db, { fetchMessage }, transcribe, { excludedChannelIds: ["secret"], download, sleep, ...extra });
    const stored = (id: string) => (db.db.prepare("SELECT attachments_text AS t FROM messages WHERE id = ?").get(id) as any).t;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "marvin-vb-"));
        db = new HistoryDb(path.join(dir, "history.db"));
        download.mockClear();
        transcribe.mockClear();
        jest.spyOn(console, "warn").mockImplementation(() => {});
        jest.spyOn(console, "log").mockImplementation(() => {});
        jest.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
        jest.restoreAllMocks();
    });

    it("rewrites untranscribed voice rows with the transcript and makes them searchable", async () => {
        const r = row();
        db.insertLive(r);
        const summary = await make(async () => voiceMessage()).runOnce();
        expect(summary).toEqual({ found: 1, transcribed: 1, final: 0, retryLater: 0 });
        expect(stored(r.id)).toBe("[Głosówka: Dzień dobry]");
        expect((db.db.prepare("SELECT count(*) AS c FROM messages_fts WHERE messages_fts MATCH 'dobry'").get() as any).c).toBe(1);
        expect((await make(async () => voiceMessage()).runOnce()).found).toBe(0);
    });

    it("skips bots, excluded channels, threads of excluded channels and rows that are not a bare voice marker", async () => {
        db.insertLive(row({ isBot: true }));
        db.insertLive(row({ channelId: "secret" }));
        db.insertLive(row({ channelId: "t1", parentId: "secret" }));
        db.insertLive(row({ attachmentsText: "[Głosówka: już jest]" }));
        db.insertLive(row({ attachmentsText: "[Załącznik: voice-message.ogg (audio/ogg)] [Obraz: coś]" }));
        const fetchMessage = jest.fn(async () => voiceMessage());
        expect((await make(fetchMessage).runOnce()).found).toBe(0);
        expect(fetchMessage).not.toHaveBeenCalled();
    });

    it("closes messages that are gone for good, retries transient failures and gives up after maxAttempts", async () => {
        const gone = row();
        const flaky = row();
        db.insertLive(gone);
        db.insertLive(flaky);
        const fetchMessage = async (_c: string, id: string) => {
            if (id === gone.id) throw Object.assign(new Error("Unknown Message"), { status: 404, code: 10008 });
            throw new Error("network down");
        };
        const backfill = make(fetchMessage, { maxAttempts: 2 });
        expect(await backfill.runOnce()).toEqual({ found: 2, transcribed: 0, final: 1, retryLater: 1 });
        expect(stored(gone.id)).toBe("[Głosówka: [nie udało się przepisać]]");
        expect(stored(flaky.id)).toBe(UNTRANSCRIBED_VOICE_TEXT);
        expect(await backfill.runOnce()).toEqual({ found: 1, transcribed: 0, final: 1, retryLater: 0 });
        expect(stored(flaky.id)).toBe("[Głosówka: [nie udało się przepisać]]");
    });

    it("keeps the row for a later run when the transcription API fails", async () => {
        const r = row();
        db.insertLive(r);
        transcribe.mockRejectedValueOnce(new Error("429"));
        expect((await make(async () => voiceMessage()).runOnce()).retryLater).toBe(1);
        expect(stored(r.id)).toBe(UNTRANSCRIBED_VOICE_TEXT);
        expect((await make(async () => voiceMessage()).runOnce()).transcribed).toBe(1);
    });

    it("stores a marker for recordings that are too long and handles at most perRun messages", async () => {
        const rows = [row(), row(), row()];
        rows.forEach(r => db.insertLive(r));
        const summary = await make(async () => voiceMessage({ duration: 900 }), { perRun: 2 }).runOnce();
        expect(summary.found).toBe(2);
        expect(stored(rows[0].id)).toMatch(/za długa, 900 s/);
        expect(stored(rows[2].id)).toBe(UNTRANSCRIBED_VOICE_TEXT);
        expect(download).not.toHaveBeenCalled();
    });
});
