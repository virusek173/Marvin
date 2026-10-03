import { buildArchiveRow, flattenEmbeds } from "../mapper";
import { isTechnicalMarvinContent, linksNotice, INTERNET_NOTICE } from "../technical";
import { IMAGE_LAZY_REPLIES } from "../../../utils/prompts";

const base = (over: any = {}) => ({
    id: "5",
    channelId: "c1",
    channel: { isThread: () => false },
    author: { id: "u1", username: "vaj", globalName: "Vajrusek", bot: false },
    content: "hej",
    embeds: [],
    attachments: new Map(),
    type: 0,
    createdTimestamp: 1_700_000_000_000,
    ...over,
});

describe("buildArchiveRow", () => {
    it("maps basic fields and falls back to username when there is no global name", () => {
        const r = buildArchiveRow(base({ author: { id: "u2", username: "kot", globalName: null, bot: false } }));
        expect(r).toMatchObject({ id: "5", channelId: "c1", parentId: null, authorId: "u2", authorName: "kot", isBot: false, content: "hej", createdAt: 1_700_000_000_000 });
    });

    it("records the parent channel for threads and the reply target", () => {
        const r = buildArchiveRow(base({ channel: { isThread: () => true, parentId: "p1" }, reference: { messageId: "4" } }));
        expect(r.parentId).toBe("p1");
        expect(r.replyToId).toBe("4");
    });

    it("stores image descriptions when given and a marker otherwise", () => {
        const atts = new Map([["a", { contentType: "image/png", name: "a.png" }]]);
        expect(buildArchiveRow(base({ attachments: atts }), { imageDescriptions: ["kot"] }).attachmentsText).toBe("[Obraz: kot]");
        expect(buildArchiveRow(base({ attachments: atts })).attachmentsText).toBe("[Obraz: nieopisany, plik a.png]");
    });

    it("marks only Marvin's fixed phrases as technical", () => {
        const marvin = { id: "m", username: "marvin", globalName: "Marvin", bot: true };
        const opts = { selfId: "m", selfUsername: "marvin" };
        expect(buildArchiveRow(base({ author: marvin, content: IMAGE_LAZY_REPLIES[0] }), opts).isTechnical).toBe(true);
        expect(buildArchiveRow(base({ author: marvin, content: "Wywaliłem się... POWÓD: x" }), opts).isTechnical).toBe(true);
        expect(buildArchiveRow(base({ author: marvin, content: "normalna odpowiedź" }), opts).isTechnical).toBe(false);
        expect(buildArchiveRow(base({ content: IMAGE_LAZY_REPLIES[0] }), opts).isTechnical).toBe(false);
    });
});

describe("flattenEmbeds", () => {
    const embeds = [{ title: "Tytuł", description: "Opis", fields: [{ name: "a", value: "b" }] }];
    it("keeps the full text for bots and only the title for humans", () => {
        expect(flattenEmbeds(embeds, true)).toBe("Tytuł\nOpis\na: b");
        expect(flattenEmbeds(embeds, false)).toBe("Tytuł");
        expect(flattenEmbeds(undefined, true)).toBe("");
    });
});

describe("isTechnicalMarvinContent", () => {
    it("recognises the fixed notices", () => {
        expect(isTechnicalMarvinContent(INTERNET_NOTICE)).toBe(true);
        expect(isTechnicalMarvinContent(linksNotice(1))).toBe(true);
        expect(isTechnicalMarvinContent(linksNotice(3))).toBe(true);
        expect(isTechnicalMarvinContent("Zaglądam do lodówki")).toBe(false);
    });
});
