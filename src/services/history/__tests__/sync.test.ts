import { HistoryDb } from "../db";
import { ChannelInfo, DiscordSource, HistorySync, isPermanentError } from "../sync";
import { buildArchiveRow } from "../mapper";

const msg = (id: number, channelId = "c1", content = `msg ${id}`) => ({
    id: String(id),
    channelId,
    channel: { isThread: () => false },
    author: { id: "u1", username: "vaj", globalName: "Vajrusek", bot: false },
    content,
    embeds: [],
    attachments: new Map(),
    type: 0,
    createdTimestamp: 1_700_000_000_000 + id,
});

class FakeSource implements DiscordSource {
    channels: ChannelInfo[] = [{ id: "c1", name: "ogolny", parentId: null, kind: "text" }];
    messages = new Map<string, any[]>();
    calls: { channelId: string; after?: string; limit: number }[] = [];
    failures = new Map<string, any[]>();

    add(channelId: string, ids: number[]) {
        this.messages.set(channelId, [...(this.messages.get(channelId) ?? []), ...ids.map(i => msg(i, channelId))]);
    }

    async listChannels() { return this.channels; }

    async fetchPage(channelId: string, { after, limit }: { after?: string; limit: number }) {
        this.calls.push({ channelId, after, limit });
        const queue = this.failures.get(channelId);
        if (queue?.length) throw queue.shift();
        const all = this.messages.get(channelId) ?? [];
        if (after === undefined) return [...all].sort((a, b) => +b.id - +a.id).slice(0, limit);
        // Discord semantics: the oldest `limit` messages newer than `after`, returned newest-first
        return all.filter(m => BigInt(m.id) > BigInt(after)).sort((a, b) => +a.id - +b.id).slice(0, limit).reverse();
    }
}

const makeSync = (db: HistoryDb, source: FakeSource, extra: any = {}) =>
    new HistorySync(db, source, { excludedChannelIds: [], pageSize: 3, retryBaseMs: 1, sleep: async () => {}, yieldToEventLoop: async () => {}, ...extra });

const ids = (db: HistoryDb, channelId = "c1") =>
    (db.db.prepare("SELECT id FROM messages WHERE channel_id = ? ORDER BY created_at").all(channelId) as any[]).map(r => r.id);

describe("HistorySync", () => {
    let db: HistoryDb;
    let source: FakeSource;
    beforeEach(() => {
        db = new HistoryDb(":memory:");
        source = new FakeSource();
        jest.spyOn(console, "log").mockImplementation(() => {});
        jest.spyOn(console, "warn").mockImplementation(() => {});
        jest.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => { db.close(); jest.restoreAllMocks(); });

    it("imports the whole history oldest-first across several pages and ends at the newest id", async () => {
        source.add("c1", [1, 2, 3, 4, 5, 6, 7, 8]);
        const summary = await makeSync(db, source).runAll("test");
        expect(summary).toMatchObject({ ok: 1, failed: 0, inserted: 8 });
        expect(ids(db)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
        expect(db.getSyncState("c1")?.cursor).toBe("8");
        expect(source.calls[0].after).toBe("0");
    });

    it("resumes from the stored cursor and only fetches newer messages", async () => {
        source.add("c1", [1, 2, 3]);
        await makeSync(db, source).runAll("first");
        source.calls = [];
        source.add("c1", [4, 5]);
        const summary = await makeSync(db, source).runAll("second");
        expect(summary.inserted).toBe(2);
        expect(source.calls[0].after).toBe("3");
        expect(ids(db)).toEqual(["1", "2", "3", "4", "5"]);
    });

    it("does not skip a gap when live writes happened while the bot was down (live never moves the cursor)", async () => {
        source.add("c1", [1, 2, 3, 4, 5, 6]);
        await makeSync(db, source).runAll("first");
        // bot goes down; 7..9 are posted; after restart a live message 10 arrives before the catch-up runs
        source.add("c1", [7, 8, 9, 10]);
        db.insertLive(buildArchiveRow(msg(10)));
        expect(db.getSyncState("c1")?.cursor).toBe("6");

        await makeSync(db, source).runAll("restart");
        expect(ids(db)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
        expect(db.getSyncState("c1")?.cursor).toBe("10");
    });

    it("is idempotent: re-running changes nothing and keeps a richer live row", async () => {
        source.add("c1", [1, 2]);
        db.insertLive(buildArchiveRow(msg(2), { imageDescriptions: [] }));
        db.db.prepare("UPDATE messages SET attachments_text = '[Obraz: kot]' WHERE id = '2'").run();
        await makeSync(db, source).runAll("a");
        await makeSync(db, source).runAll("b");
        expect(db.countMessages()).toBe(2);
        expect((db.db.prepare("SELECT attachments_text AS t FROM messages WHERE id = '2'").get() as any).t).toBe("[Obraz: kot]");
    });

    it("never moves the cursor backwards", () => {
        db.writePage("c1", [], "50");
        db.writePage("c1", [], "10");
        expect(db.getSyncState("c1")?.cursor).toBe("50");
    });

    it("keeps going after one channel fails, recording the error and not retrying permanent ones", async () => {
        source.channels.push({ id: "c2", name: "tajny", parentId: null, kind: "text" });
        source.add("c1", [1, 2]);
        source.add("c2", [3]);
        source.failures.set("c1", [Object.assign(new Error("Missing Access"), { status: 403, code: 50001 })]);
        const summary = await makeSync(db, source).runAll("test");
        expect(summary).toMatchObject({ ok: 1, failed: 1 });
        expect(source.calls.filter(c => c.channelId === "c1")).toHaveLength(1);
        expect(db.getSyncState("c1")?.lastError).toContain("Missing Access");
        expect(ids(db, "c2")).toEqual(["3"]);
    });

    it("retries transient errors with growing delays and then succeeds", async () => {
        source.add("c1", [1]);
        source.failures.set("c1", [new Error("boom"), new Error("boom")]);
        const delays: number[] = [];
        const summary = await makeSync(db, source, { retryBaseMs: 10, sleep: async (ms: number) => { delays.push(ms); } }).runAll("test");
        expect(summary).toMatchObject({ ok: 1, failed: 0, inserted: 1 });
        expect(delays).toEqual([10, 20]);
    });

    it("gives up after the retry limit and records the failure", async () => {
        source.failures.set("c1", Array.from({ length: 10 }, () => new Error("down")));
        const summary = await makeSync(db, source, { maxRetries: 2 }).runAll("test");
        expect(summary.failed).toBe(1);
        expect(db.getSyncState("c1")?.lastError).toContain("down");
    });

    it("skips excluded channels and threads of excluded channels", async () => {
        source.channels.push(
            { id: "secret", name: "s", parentId: null, kind: "text" },
            { id: "t1", name: "t", parentId: "secret", kind: "thread" }
        );
        source.add("secret", [1]);
        source.add("t1", [2]);
        await makeSync(db, source, { excludedChannelIds: ["secret"] }).runAll("test");
        expect(source.calls.map(c => c.channelId)).not.toContain("secret");
        expect(source.calls.map(c => c.channelId)).not.toContain("t1");
    });

    it("skips a run that overlaps with a running one", async () => {
        source.add("c1", [1]);
        const sync = makeSync(db, source);
        const first = sync.runAll("a");
        const second = await sync.runAll("b");
        expect(second.skipped).toBe(true);
        expect((await first).skipped).toBe(false);
    });

    it("flags Marvin's own technical messages during backfill", async () => {
        source.messages.set("c1", [{ ...msg(1, "c1", "Zaglądam do linka. 🔗"), author: { id: "m", username: "marvin", globalName: "Marvin", bot: true } }]);
        await makeSync(db, source, { selfId: "m", selfUsername: "marvin" }).runAll("test");
        expect((db.db.prepare("SELECT is_technical AS t FROM messages").get() as any).t).toBe(1);
    });

    describe("ensureChannelFresh", () => {
        it("fetches the newest messages without a cursor when the backfill has not reached the channel", async () => {
            source.add("c1", [1, 2, 3, 4, 5]);
            await makeSync(db, source).ensureChannelFresh("c1");
            expect(ids(db)).toEqual(["3", "4", "5"]);
            expect(db.getSyncState("c1")?.cursor ?? null).toBeNull();
        });

        it("catches up from the cursor when there is one, and only once per channel", async () => {
            source.add("c1", [1, 2]);
            const sync = makeSync(db, source);
            await sync.runAll("first");
            source.add("c1", [3]);
            await sync.ensureChannelFresh("c1");
            expect(ids(db)).toEqual(["1", "2", "3"]);
            source.calls = [];
            await sync.ensureChannelFresh("c1");
            expect(source.calls).toHaveLength(0);
        });

        it("ignores excluded channels", async () => {
            await makeSync(db, source, { excludedChannelIds: ["c1"] }).ensureChannelFresh("c1");
            expect(source.calls).toHaveLength(0);
        });
    });
});

describe("isPermanentError", () => {
    it("treats 403/404 and permission codes as permanent", () => {
        expect(isPermanentError({ status: 403 })).toBe(true);
        expect(isPermanentError({ code: 50013 })).toBe(true);
        expect(isPermanentError({ status: 500 })).toBe(false);
        expect(isPermanentError(new Error("x"))).toBe(false);
    });
});
