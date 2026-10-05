import { extractEmoji, emojiKeyFromInput } from "../emoji";

const asObject = (content: string) => Object.fromEntries(extractEmoji(content));

describe("extractEmoji", () => {
    it("counts Unicode emoji, merging skin tones and variation selectors", () => {
        expect(asObject("haha 😂😂 ok 👍 i 👍🏽, ❤️")).toEqual({ "😂": 2, "👍": 2, "❤": 1 });
    });

    it("keeps ZWJ sequences and flags as one emoji", () => {
        expect(asObject("👨‍👩‍👧 i 🇵🇱")).toEqual({ "👨‍👩‍👧": 1, "🇵🇱": 1 });
    });

    it("counts server emoji by name, animated ones too", () => {
        expect(asObject("<:pepe:123456789012345678> a <a:dance:99> i <:pepe:123456789012345678>")).toEqual({ ":pepe:": 2, ":dance:": 1 });
    });

    it("ignores plain symbols, digits and text", () => {
        expect(asObject("© ® ™ #1 *2 100% :) xd")).toEqual({});
        expect(asObject("")).toEqual({});
    });
});

describe("emojiKeyFromInput", () => {
    it("understands the forms the model may pass", () => {
        expect(emojiKeyFromInput("😂")).toBe("😂");
        expect(emojiKeyFromInput("👍🏽")).toBe("👍");
        expect(emojiKeyFromInput("❤")).toBe("❤");
        expect(emojiKeyFromInput(":pepe:")).toBe(":pepe:");
        expect(emojiKeyFromInput("pepe")).toBe(":pepe:");
        expect(emojiKeyFromInput("<:pepe:123>")).toBe(":pepe:");
    });

    it("returns null for input that is not an emoji", () => {
        expect(emojiKeyFromInput("")).toBeNull();
        expect(emojiKeyFromInput("to nie emoji!")).toBeNull();
    });
});
