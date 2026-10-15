import {
    RemindersDb,
    ReminderService,
    ReminderRow,
    buildReminderTools,
    buildCommentInput,
    cleanReminderComment,
    formatIn,
    formatReminderMessage,
    formatWarsaw,
    reminderCalendar,
    warsawLocalToUtc,
    MAX_PENDING_PER_AUTHOR,
    MAX_DELIVERY_ATTEMPTS,
} from "../reminders";

// 2026-10-15 12:00 Warsaw (CEST, UTC+2) = 10:00 UTC, a Thursday
const NOW = Date.UTC(2026, 9, 15, 10, 0);
const MIN = 60_000;

describe("warsawLocalToUtc", () => {
    it("converts summer and winter time", () => {
        expect(warsawLocalToUtc(2026, 10, 16, 18, 0)).toBe(Date.UTC(2026, 9, 16, 16, 0));
        expect(warsawLocalToUtc(2026, 12, 1, 18, 0)).toBe(Date.UTC(2026, 11, 1, 17, 0));
    });

    it("rejects dates that do not exist and the hour skipped by the spring clock change", () => {
        expect(warsawLocalToUtc(2026, 2, 31, 10, 0)).toBeNull();
        expect(warsawLocalToUtc(2026, 13, 1, 10, 0)).toBeNull();
        expect(warsawLocalToUtc(2026, 10, 16, 25, 0)).toBeNull();
        expect(warsawLocalToUtc(2026, 3, 29, 2, 30)).toBeNull();
    });

    it("accepts a time that happens twice in autumn (either occurrence)", () => {
        const utc = warsawLocalToUtc(2026, 10, 25, 2, 30);
        expect([Date.UTC(2026, 9, 25, 0, 30), Date.UTC(2026, 9, 25, 1, 30)]).toContain(utc);
    });

    it("handles the day before and after the change", () => {
        expect(warsawLocalToUtc(2026, 3, 28, 12, 0)).toBe(Date.UTC(2026, 2, 28, 11, 0));
        expect(warsawLocalToUtc(2026, 3, 29, 12, 0)).toBe(Date.UTC(2026, 2, 29, 10, 0));
    });
});

describe("formatting", () => {
    it("formats Warsaw time with the weekday", () => {
        expect(formatWarsaw(Date.UTC(2026, 9, 16, 16, 0))).toBe("piątek 16.10.2026 18:00");
    });

    it("formats the distance", () => {
        expect(formatIn(5 * MIN)).toBe("za 5 min");
        expect(formatIn(208 * MIN)).toBe("za 3 godz. 28 min");
        expect(formatIn(5 * 1440 * MIN)).toBe("za 5 dni");
    });

    it("builds a calendar that starts today with weekdays", () => {
        const calendar = reminderCalendar(NOW, 4);
        expect(calendar).toContain("czwartek 15.10.2026 12:00");
        expect(calendar).toContain("dziś: czwartek 2026-10-15");
        expect(calendar).toContain("jutro: piątek 2026-10-16");
        expect(calendar).toContain("pojutrze: sobota 2026-10-17");
        expect(calendar).toContain("niedziela 2026-10-18");
    });
});

describe("create_reminder, list_reminders, cancel_reminder", () => {
    let db: RemindersDb;
    let now: number;
    beforeEach(() => { db = new RemindersDb(":memory:"); now = NOW; });
    afterEach(() => db.close());

    const setup = (authorId = "1", overrides: Partial<Parameters<typeof buildReminderTools>[0]> = {}) => {
        const [create, list, cancel] = buildReminderTools({
            db, authorId, authorName: "Olek", channelId: "c1", sourceMessageId: "m1",
            personIds: () => ({ Adam: "11", Ewa: "22", Beata: "33", Olek: "1" }),
            now: () => now,
            ...overrides,
        });
        return { create: create.run, list: list.run, cancel: cancel.run };
    };

    it("creates a reminder from a Warsaw date and returns the confirmation data", () => {
        const { create } = setup();
        const result: any = create({ text: "spotkanie", at: "2026-10-16 18:00" });
        expect(result).toMatchObject({ id: 1, due: "piątek 16.10.2026 18:00", text: "spotkanie", pinged: ["Olek"] });
        expect(db.get(1)).toMatchObject({ authorId: "1", channelId: "c1", dueAt: Date.UTC(2026, 9, 16, 16, 0), status: "pending" });
    });

    it("creates a reminder from in_minutes", () => {
        const { create } = setup();
        const result: any = create({ text: "herbata", in_minutes: 120 });
        expect(result.in).toBe("za 2 godz. 0 min");
        expect(db.get(result.id)!.dueAt).toBe(NOW + 120 * MIN);
    });

    it("needs exactly one of at and in_minutes", () => {
        const { create } = setup();
        expect(create({ text: "x" })).toHaveProperty("error");
        expect(create({ text: "x", at: "2026-10-16 18:00", in_minutes: 5 })).toHaveProperty("error");
    });

    it("rejects bad input", () => {
        const { create } = setup();
        expect(create({ at: "2026-10-16 18:00" })).toHaveProperty("error");
        expect(create({ text: "x".repeat(301), in_minutes: 5 })).toHaveProperty("error");
        expect(create({ text: "x", at: "jutro o 18" })).toHaveProperty("error");
        expect(create({ text: "x", at: "2026-02-31 10:00" })).toHaveProperty("error");
        expect(create({ text: "x", in_minutes: 0 })).toHaveProperty("error");
        expect(create({ text: "x", in_minutes: "abc" })).toHaveProperty("error");
        expect(db.countPending("1")).toBe(0);
    });

    it("rejects the past, the next few seconds and more than a year ahead", () => {
        const { create } = setup();
        expect(create({ text: "x", at: "2026-10-15 11:00" })).toHaveProperty("error");
        expect(create({ text: "x", at: "2026-10-15 12:00" })).toHaveProperty("error");
        expect(create({ text: "x", at: "2028-01-01 10:00" })).toHaveProperty("error");
        expect(create({ text: "x", at: "2026-10-15 12:02" })).not.toHaveProperty("error");
    });

    it("limits pending reminders per author", () => {
        const { create } = setup();
        for (let i = 0; i < MAX_PENDING_PER_AUTHOR; i++) expect(create({ text: `n${i}`, in_minutes: 10 + i })).not.toHaveProperty("error");
        expect(create({ text: "one too many", in_minutes: 5 })).toHaveProperty("error");
        expect(setup("2").create({ text: "other author", in_minutes: 5 })).not.toHaveProperty("error");
    });

    it("pings the author and named people, but only writes out unknown people and those in noPing", () => {
        const { create } = setup();
        const result: any = create({ text: "grill", at: "2026-10-16 18:00", for: ["adam", "Beata", "Zenek", "Olek", "Adam"] });
        expect(result.pinged).toEqual(["Olek", "Adam"]);
        expect(result.notPinged).toEqual(["Beata", "Zenek"]);
        const row = db.get(result.id)!;
        expect(row.mentions).toEqual([{ id: "1", name: "Olek" }, { id: "11", name: "Adam" }]);
        expect(row.plainNames).toEqual(["Beata", "Zenek"]);
    });

    it("strips markup characters from names that are only written out", () => {
        const { create } = setup();
        const result: any = create({ text: "x", in_minutes: 5, for: ["<@&5>everyone`"] });
        expect(result.notPinged).toEqual(["&5everyone"]);
    });

    it("lists only the asker's pending reminders, soonest first", () => {
        const a = setup("1");
        const b = setup("2");
        a.create({ text: "later", in_minutes: 60 });
        a.create({ text: "sooner", in_minutes: 10 });
        b.create({ text: "not mine", in_minutes: 5 });
        const listed: any = a.list({});
        expect(listed.count).toBe(2);
        expect(listed.reminders.map((r: any) => r.text)).toEqual(["sooner", "later"]);
    });

    it("cancels only the author's own pending reminder", () => {
        const a = setup("1");
        const b = setup("2");
        const id = (a.create({ text: "x", in_minutes: 60 }) as any).id;
        expect(b.cancel({ id })).toHaveProperty("error");
        expect(a.cancel({ id })).toEqual({ cancelled: true, id });
        expect(a.cancel({ id })).toHaveProperty("error");
        expect(a.cancel({ id: "abc" })).toHaveProperty("error");
        expect(db.get(id)!.status).toBe("cancelled");
        expect((a.list({}) as any).count).toBe(0);
    });
});

describe("message text", () => {
    const row = (overrides: Partial<ReminderRow> = {}): ReminderRow => ({
        id: 1, authorId: "1", authorName: "Olek", channelId: "c", sourceMessageId: "m", dueAt: Date.UTC(2026, 9, 16, 16, 0),
        text: "spotkanie", mentions: [{ id: "1", name: "Olek" }, { id: "11", name: "Adam" }], plainNames: ["Beata"],
        status: "pending", attempts: 0, createdAt: NOW, ...overrides,
    });

    it("builds the fixed part from the data", () => {
        expect(formatReminderMessage(row(), false)).toBe("⏰ Przypomnienie dla <@1>, <@11>, Beata: spotkanie");
    });

    it("marks a late reminder and appends the comment on its own line", () => {
        const text = formatReminderMessage(row(), true, "Zero kitu.");
        expect(text).toBe("⏰ Przypomnienie dla <@1>, <@11>, Beata: spotkanie _(spóźnione, miało być 16.10 18:00)_\nZero kitu.");
    });

    it("gives the comment model the reminder as data", () => {
        const input = buildCommentInput(row(), true, NOW);
        expect(input).toContain("Poprosił: Olek");
        expect(input).toContain("Dla: Olek, Adam, Beata");
        expect(input).toContain("Spóźnione: tak");
    });
});

describe("cleanReminderComment", () => {
    it("keeps one clean line without prefix, icons or pings", () => {
        expect(cleanReminderComment("Marvin (2026.10.15 12:00): 🌐 <@5> Idź już.\n@everyone Teraz.")).toBe("Idź już. Teraz.");
    });

    it("cuts at a word and handles non-strings", () => {
        const long = cleanReminderComment("słowo ".repeat(100));
        expect(long.length).toBeLessThanOrEqual(201);
        expect(long.endsWith("…")).toBe(true);
        expect(cleanReminderComment(null)).toBe("");
    });
});

describe("ReminderService", () => {
    let db: RemindersDb;
    let now: number;
    let sent: Array<{ channelId: string; content: string; userIds: string[] }>;
    beforeEach(() => { db = new RemindersDb(":memory:"); now = NOW; sent = []; });
    afterEach(() => db.close());

    const add = (dueAt: number, text = "coś", channelId = "c1") =>
        db.add({ authorId: "1", authorName: "Olek", channelId, sourceMessageId: "m", dueAt, text, mentions: [{ id: "1", name: "Olek" }], plainNames: [] }, NOW - 1000);

    const service = (overrides: Partial<ConstructorParameters<typeof ReminderService>[0]> = {}) =>
        new ReminderService({
            db,
            now: () => now,
            send: async (channelId, content, userIds) => { sent.push({ channelId, content, userIds }); },
            comment: async () => "Zero kitu.",
            ...overrides,
        });

    it("sends due reminders with the comment, pings only the listed users and marks them sent", async () => {
        const id = add(NOW - 10_000);
        add(NOW + 10 * MIN, "później");
        expect(await service().processDue()).toBe(1);
        expect(sent).toEqual([{ channelId: "c1", content: "⏰ Przypomnienie dla <@1>: coś\nZero kitu.", userIds: ["1"] }]);
        expect(db.get(id)!.status).toBe("sent");
        expect(await service().processDue()).toBe(0);
        expect(sent).toHaveLength(1);
    });

    it("sends a reminder that became due during downtime with the late note", async () => {
        add(NOW - 3 * 3600_000);
        await service().processDue();
        expect(sent[0].content).toContain("spóźnione");
    });

    it("sends without a comment when the comment fails, returns nothing or times out", async () => {
        add(NOW - 1000, "a");
        add(NOW - 1000, "b");
        add(NOW - 1000, "c");
        const comments = [() => Promise.reject(new Error("api")), () => Promise.resolve(null), () => new Promise<string>(() => {})];
        let i = 0;
        await service({ comment: () => comments[i++](), commentTimeoutMs: 20 }).processDue();
        expect(sent.map(s => s.content).sort()).toEqual([
            "⏰ Przypomnienie dla <@1>: a",
            "⏰ Przypomnienie dla <@1>: b",
            "⏰ Przypomnienie dla <@1>: c",
        ]);
    });

    it("retries a failed send on the next tick and gives up after the attempt limit", async () => {
        const id = add(NOW - 1000);
        const failing = service({ send: async () => { throw new Error("brak kanału"); } });
        for (let i = 0; i < MAX_DELIVERY_ATTEMPTS - 1; i++) {
            await failing.processDue();
            expect(db.get(id)!.status).toBe("pending");
        }
        await failing.processDue();
        expect(db.get(id)!.status).toBe("failed");
        expect(db.get(id)!.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
        await failing.processDue();
        expect(sent).toHaveLength(0);
    });

    it("delivers after a transient failure", async () => {
        const id = add(NOW - 1000);
        let calls = 0;
        const flaky = service({ send: async (c, content, u) => { if (calls++ === 0) throw new Error("503"); sent.push({ channelId: c, content, userIds: u }); } });
        await flaky.processDue();
        await flaky.processDue();
        expect(sent).toHaveLength(1);
        expect(db.get(id)!.status).toBe("sent");
    });

    it("never delivers a cancelled reminder and never claims the same one twice at once", async () => {
        const cancelled = add(NOW - 1000);
        db.cancel(cancelled, "1");
        const id = add(NOW - 1000);
        const s = service();
        const [a, b] = await Promise.all([s.processDue(), s.processDue()]);
        expect(a + b).toBe(1);
        expect(db.claimDue(NOW)).toEqual([]);
        expect(sent).toHaveLength(1);
        expect(db.get(id)!.status).toBe("sent");
    });

    it("puts reminders interrupted by a crash back in the queue", async () => {
        const id = add(NOW - 1000);
        db.claimDue(NOW);
        expect(db.get(id)!.status).toBe("sending");
        service().recover();
        expect(db.get(id)!.status).toBe("pending");
        await service().processDue();
        expect(sent).toHaveLength(1);
    });
});
