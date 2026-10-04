import { extractUrls } from "../scraper";

describe("extractUrls", () => {
    it("finds plain and angle-bracketed urls", () => {
        expect(extractUrls("zobacz https://example.com/a oraz <https://example.org/b>")).toEqual([
            "https://example.com/a",
            "https://example.org/b",
        ]);
    });

    it("skips Discord message links (Marvin cites them in its answers)", () => {
        const text = "[19.02.2025 21:01](<https://discord.com/channels/1/2/3>) i https://ptb.discord.com/channels/1/2/4 oraz https://example.com";
        expect(extractUrls(text)).toEqual(["https://example.com"]);
    });
});
