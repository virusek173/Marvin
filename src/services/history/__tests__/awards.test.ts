import { Award, awardCandidates, awardFacts, expandAwardTokens, isLaughEmoji, pickAwards } from "../awards.js";
import { AwardActivity, AwardMessage, AwardSource } from "../query.js";

const MIN = 60_000;
const DAY = 86_400_000;
// 2026-11-03 12:00 Warsaw (CET, UTC+1)
const NOON = Date.UTC(2026, 10, 3, 11, 0);
// 2026-11-03 02:00 Warsaw
const NIGHT = Date.UTC(2026, 10, 3, 1, 0);
// 2026-11-03 06:00 Warsaw
const MORNING = Date.UTC(2026, 10, 3, 5, 0);

let counter = 0;
const msg = (author: string, createdAt: number, text = "tekst", extra: Partial<AwardMessage> = {}): AwardMessage => ({
    id: String(++counter),
    channelId: "c1",
    author,
    createdAt,
    text,
    isVoice: false,
    emoji: [],
    ...extra,
});

const source = (messages: AwardMessage[], reactions: Record<string, Record<string, number>> = {}, activity: [string, AwardActivity][] = []): AwardSource => ({
    since: NOON - 3 * DAY,
    messages,
    activity: new Map(activity),
    reactions: new Map(Object.entries(reactions)),
    link: m => `[link ${m.id}]`,
});

const kindOf = (s: AwardSource, kind: Award["kind"]) => awardCandidates(s).find(x => x.kind === kind);

describe("awardCandidates", () => {
    it("gives the message with the most reactions as Hit okresu, the newer one on a tie", () => {
        const a = msg("Ania", NOON);
        const b = msg("Bartek", NOON + MIN);
        const c = msg("Celina", NOON + 2 * MIN);
        const hit = kindOf(source([a, b, c], { [a.id]: { "👍": 4 }, [b.id]: { "❤️": 2, "👍": 2 }, [c.id]: { "👍": 1 } }), "hit")!;
        expect(hit.winner).toBe("Bartek");
        expect(hit.link).toBe(`[link ${b.id}]`);
        expect(hit.facts).toContain(": 4.");
    });

    it("needs at least 3 reactions for a hit and 2 laughing ones for Złoty Śmiech", () => {
        const a = msg("Ania", NOON);
        expect(awardCandidates(source([a], { [a.id]: { "👍": 2 } }))).toEqual([]);
        expect(awardCandidates(source([a], { [a.id]: { "😂": 2 } })).map(x => x.kind)).toEqual(["laugh"]);
    });

    it("counts server laughing emoji and ignores others for Złoty Śmiech", () => {
        expect(isLaughEmoji("😂")).toBe(true);
        expect(isLaughEmoji(":xdd:")).toBe(true);
        expect(isLaughEmoji(":LOL:")).toBe(true);
        expect(isLaughEmoji(":pepeXD:")).toBe(true);
        expect(isLaughEmoji(":xd_cry:")).toBe(true);
        expect(isLaughEmoji(":KEKW:")).toBe(true);
        expect(isLaughEmoji("👍")).toBe(false);
        expect(isLaughEmoji(":pepe:")).toBe(false);
    });

    it("names the author with the most messages between 00:00 and 05:00 as Nocny Marek (minimum 5)", () => {
        const few = Array.from({ length: 4 }, (_, i) => msg("Ania", NIGHT + i * MIN));
        expect(kindOf(source(few), "night")).toBeUndefined();
        const many = [...few, msg("Ania", NIGHT + 5 * MIN), msg("Bartek", NIGHT), msg("Bartek", NOON)];
        const night = kindOf(source(many), "night")!;
        expect(night.winner).toBe("Ania");
        expect(night.facts).toContain("5");
    });

    it("gives Skowronek for morning messages between 05:00 and 08:00 (minimum 4)", () => {
        const morning = Array.from({ length: 4 }, (_, i) => msg("Ania", MORNING + i * MIN));
        expect(kindOf(source(morning), "early")!.winner).toBe("Ania");
        expect(kindOf(source(morning.slice(0, 3)), "early")).toBeUndefined();
        expect(kindOf(source(Array.from({ length: 6 }, (_, i) => msg("Ania", NIGHT + i * MIN))), "early")).toBeUndefined();
    });

    it("gives Radio Maryja for the longest message (at least 400 characters), with a link", () => {
        const long = msg("Ania", NOON, "a".repeat(450));
        const longer = msg("Bartek", NOON + MIN, "b".repeat(900));
        const award = kindOf(source([long, longer, msg("Celina", NOON, "c".repeat(399))]), "long")!;
        expect(award.winner).toBe("Bartek");
        expect(award.link).toBe(`[link ${longer.id}]`);
        expect(award.facts).toContain(": 900.");
        expect(kindOf(source([msg("Celina", NOON, "c".repeat(399))]), "long")).toBeUndefined();
    });

    it("gives Streszczacz for the most very short messages (minimum 8)", () => {
        const shorts = Array.from({ length: 8 }, (_, i) => msg("Ania", NOON + i * MIN, "ok"));
        expect(kindOf(source(shorts), "short")!.winner).toBe("Ania");
        expect(kindOf(source(shorts.slice(0, 7)), "short")).toBeUndefined();
        expect(kindOf(source(Array.from({ length: 8 }, (_, i) => msg("Ania", NOON + i * MIN, "dłuższa wiadomość"))), "short")).toBeUndefined();
    });

    it("gives Rozmówca for replies to other people's messages, not to one's own", () => {
        const replies = Array.from({ length: 8 }, (_, i) => msg("Ania", NOON + i * MIN, "tak", { replyTo: "Bartek" }));
        expect(kindOf(source(replies), "replier")!.winner).toBe("Ania");
        expect(kindOf(source(replies.map(r => ({ ...r, replyTo: "Ania" }))), "replier")).toBeUndefined();
    });

    it("gives Kolekcjoner emoji for the most different emoji (minimum 6)", () => {
        const emoji = ["😂", "👍", ":pepe:", "🔥", "❤️", "🎉"];
        const spread = emoji.map((e, i) => msg("Ania", NOON + i * MIN, "x", { emoji: [e] }));
        expect(kindOf(source(spread), "emoji")!.facts).toContain(": 6");
        expect(kindOf(source(spread.slice(0, 5)), "emoji")).toBeUndefined();
        expect(kindOf(source(Array.from({ length: 10 }, (_, i) => msg("Ania", NOON + i * MIN, "x", { emoji: ["😂"] }))), "emoji")).toBeUndefined();
    });

    it("gives Głosówkowicz for voice messages (minimum 3)", () => {
        const voices = Array.from({ length: 3 }, (_, i) => msg("Ania", NOON + i * MIN, "", { isVoice: true }));
        expect(kindOf(source(voices), "voice")!.winner).toBe("Ania");
        expect(kindOf(source(voices.slice(0, 2)), "voice")).toBeUndefined();
    });

    it("gives Cichy jak grób to someone who wrote a lot before and nothing in the window", () => {
        const activity: [string, AwardActivity][] = [["Ania", { prior30: 60, lastBefore: NOON - 4 * DAY }], ["Bartek", { prior30: 40, lastBefore: NOON - 5 * DAY }], ["Celina", { prior30: 5, lastBefore: NOON - 5 * DAY }]];
        const award = kindOf(source([msg("Bartek", NOON)], {}, activity), "quiet")!;
        expect(award.winner).toBe("Ania");
        expect(award.facts).toContain("60");
        expect(kindOf(source([msg("Ania", NOON)], {}, [["Ania", { prior30: 60, lastBefore: NOON - 4 * DAY }]]), "quiet")).toBeUndefined();
    });

    it("gives Comeback to someone back after at least two weeks with at least 3 messages", () => {
        const back = [msg("Ania", NOON), msg("Ania", NOON + MIN), msg("Ania", NOON + 2 * MIN)];
        const award = kindOf(source(back, {}, [["Ania", { prior30: 0, lastBefore: NOON - 20 * DAY }]]), "comeback")!;
        expect(award.winner).toBe("Ania");
        expect(award.facts).toContain("20 dniach");
        expect(kindOf(source(back, {}, [["Ania", { prior30: 9, lastBefore: NOON - 5 * DAY }]]), "comeback")).toBeUndefined();
        expect(kindOf(source(back.slice(0, 2), {}, [["Ania", { prior30: 0, lastBefore: NOON - 20 * DAY }]]), "comeback")).toBeUndefined();
        expect(kindOf(source(back), "comeback")).toBeUndefined();
    });
});

const award = (kind: Award["kind"], winner: string, messageId?: string): Award => ({ kind, title: kind, winner, facts: "fakt", messageId });

describe("pickAwards", () => {
    const four = [award("hit", "Ania", "1"), award("laugh", "Bartek", "2"), award("night", "Celina"), award("long", "Dawid", "4")];

    it("returns at most two awards for different people", () => {
        const picked = pickAwards(four, { kinds: [], winners: [] }, () => 0.3);
        expect(picked).toHaveLength(2);
        expect(new Set(picked.map(p => p.winner)).size).toBe(2);
    });

    it("avoids the kinds and winners from the previous summary when others exist", () => {
        const picked = pickAwards(four, { kinds: ["hit"], winners: ["Celina"] }, () => 0.5);
        expect(picked.map(p => p.kind).sort()).toEqual(["laugh", "long"]);
        // too few fresh winners: only the kinds are still avoided
        const kindsOnly = pickAwards(four, { kinds: ["hit", "laugh"], winners: ["Celina"] }, () => 0.5);
        expect(kindsOnly.map(p => p.kind).sort()).toEqual(["long", "night"]);
    });

    it("falls back to repeating when the previous ones are all that is left, but never gives two awards to one person", () => {
        const picked = pickAwards([award("hit", "Ania", "1"), award("laugh", "Ania", "2")], { kinds: ["hit", "laugh"], winners: ["Ania"] });
        expect(picked).toHaveLength(1);
        expect(picked[0].winner).toBe("Ania");
    });

    it("returns nothing without candidates", () => {
        expect(pickAwards([], { kinds: [], winners: [] })).toEqual([]);
    });
});

describe("award text helpers", () => {
    const awards: Award[] = [{ ...award("hit", "Ania", "1"), link: "[01.01.2026 10:00](<https://x>)" }, award("night", "Bartek")];

    it("lists the facts with link tokens only for awards that have a link", () => {
        const facts = awardFacts(awards);
        expect(facts).toContain("Nagroda 1: „hit” dla {p1} (Ania). fakt Link: {a1}");
        expect(facts).toContain("Nagroda 2: „night” dla {p2} (Bartek). fakt");
        expect(facts.split("\n")[1]).not.toContain("{a");
    });

    it("expands link tokens, and drops unknown or linkless ones", () => {
        expect(expandAwardTokens("🏆 **Hit** Ania {a1}\n🏆 **Marek** Bartek {a2} {a9}", awards)).toBe("🏆 **Hit** Ania [01.01.2026 10:00](<https://x>)\n🏆 **Marek** Bartek");
    });

    it("turns winner tokens into mentions, or the plain name when the person cannot be pinged, and keeps unknown tokens", () => {
        const mention = (name: string) => (name === "Ania" ? "<@11>" : name);
        expect(expandAwardTokens("Mamy nagrody! **Hit** dla {p1}, **Marek** dla {p2} {p7}", awards, mention)).toBe("Mamy nagrody! **Hit** dla <@11>, **Marek** dla Bartek {p7}");
    });
});
