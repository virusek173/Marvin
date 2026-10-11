import { Readable } from "node:stream";
import axios from "axios";
import { extractUrls, scrapeUrl } from "../scraper";

jest.mock("axios");

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

describe("scrapeUrl", () => {
    const serve = (html: string) => (axios.get as jest.Mock).mockResolvedValueOnce({ data: Readable.from([Buffer.from(html)]) });

    it("keeps the article and drops navigation, scripts and data attributes", async () => {
        serve(`<html><body><nav>MENU</nav><main><p data-mw='{"x":1}'>Treść artykułu</p><script>var a=1</script></main><footer>STOPKA</footer></body></html>`);
        expect(await scrapeUrl("https://example.com")).toBe("Treść artykułu");
    });

    it("reads only the beginning of a huge page instead of failing", async () => {
        serve(`<main><p>Początek</p>${"<p>x</p>".repeat(200_000)}</main>`);
        const text = await scrapeUrl("https://example.com/big");
        expect(text?.startsWith("Początek")).toBe(true);
        expect(text?.length).toBe(4000);
    });

    it("returns null when the request fails", async () => {
        (axios.get as jest.Mock).mockRejectedValueOnce(new Error("boom"));
        jest.spyOn(console, "error").mockImplementation(() => {});
        expect(await scrapeUrl("https://example.com")).toBeNull();
    });
});
