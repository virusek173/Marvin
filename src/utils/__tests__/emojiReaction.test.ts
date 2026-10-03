import { getEmojiReactionSystemPrompt, isMissingPermission, isReactable, parseEmojiChoice, shouldRollReaction } from "../emojiReaction";

const custom = [{ id: "111", name: "KEKW" }, { id: "222", name: "pepe_sad" }];

describe("parseEmojiChoice", () => {
    it("accepts a single unicode emoji", () => {
        expect(parseEmojiChoice("😂", custom)).toBe("😂");
        expect(parseEmojiChoice(" 👍🏽 ", custom)).toBe("👍🏽");
        expect(parseEmojiChoice("❤️", custom)).toBe("❤️");
        expect(parseEmojiChoice("🇵🇱", custom)).toBe("🇵🇱");
    });

    it("resolves a custom emoji by name to its id, case-insensitively", () => {
        expect(parseEmojiChoice(":KEKW:", custom)).toBe("111");
        expect(parseEmojiChoice(":pepe_SAD:", custom)).toBe("222");
    });

    it("rejects no-reaction, unknown names, text and multiple emoji", () => {
        for (const bad of ["-", "", "  ", ":nieznana:", "haha", "😂😂", "😂 super", "a", undefined, null, 5]) {
            expect(parseEmojiChoice(bad as any, custom)).toBeNull();
        }
    });
});

describe("isReactable", () => {
    it("needs some real text", () => {
        expect(isReactable("ale jaja")).toBe(true);
        expect(isReactable("https://example.com/x")).toBe(false);
        expect(isReactable("<@123456> ")).toBe(false);
        expect(isReactable("<:KEKW:111>")).toBe(false);
        expect(isReactable("ok")).toBe(false);
        expect(isReactable("")).toBe(false);
        expect(isReactable(undefined)).toBe(false);
        expect(isReactable("x".repeat(501))).toBe(false);
    });
});

describe("shouldRollReaction", () => {
    it("is true only below the chance", () => {
        expect(shouldRollReaction(() => 0.019, 0.02)).toBe(true);
        expect(shouldRollReaction(() => 0.02, 0.02)).toBe(false);
    });
});

describe("prompt and permission", () => {
    it("lists server emojis only when present", () => {
        expect(getEmojiReactionSystemPrompt(custom)).toContain(":KEKW: :pepe_sad:");
        expect(getEmojiReactionSystemPrompt([])).not.toContain("Emotki tego serwera");
    });

    it("recognises a missing-permission error", () => {
        expect(isMissingPermission({ code: 50013 })).toBe(true);
        expect(isMissingPermission({ status: 403 })).toBe(true);
        expect(isMissingPermission(new Error("x"))).toBe(false);
    });
});
