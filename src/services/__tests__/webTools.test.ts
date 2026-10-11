import { buildWebTools } from "../webTools";
import { scrapeUrl } from "../scraper";

jest.mock("../scraper", () => ({
    ...jest.requireActual("../scraper"),
    scrapeUrl: jest.fn(),
}));

describe("fetch_url tool", () => {
    const scrape = scrapeUrl as jest.Mock;
    beforeEach(() => scrape.mockReset());

    const setup = () => {
        const onFetch = jest.fn();
        const [tool] = buildWebTools(onFetch);
        return { tool, onFetch };
    };

    it("returns the page text and reports the fetch", async () => {
        scrape.mockResolvedValueOnce("Treść strony");
        const { tool, onFetch } = setup();
        expect(await tool.run({ url: "https://example.com/a" })).toEqual({ url: "https://example.com/a", content: "Treść strony" });
        expect(onFetch).toHaveBeenCalledTimes(1);
    });

    it("does not report a fetch when the page could not be read", async () => {
        scrape.mockResolvedValueOnce(null);
        const { tool, onFetch } = setup();
        expect(await tool.run({ url: "https://example.com/a" })).toEqual({ error: "Nie udało się pobrać strony." });
        expect(onFetch).not.toHaveBeenCalled();
    });

    it("rejects non-http input and Discord message links without scraping", async () => {
        const { tool, onFetch } = setup();
        expect(await tool.run({ url: "file:///etc/passwd" })).toHaveProperty("error");
        expect(await tool.run({})).toHaveProperty("error");
        expect(await tool.run({ url: "https://discord.com/channels/1/2/3" })).toHaveProperty("error");
        expect(scrape).not.toHaveBeenCalled();
        expect(onFetch).not.toHaveBeenCalled();
    });

    it("allows at most 3 pages per question", async () => {
        scrape.mockResolvedValue("x");
        const { tool } = setup();
        for (let i = 0; i < 3; i++) expect(await tool.run({ url: `https://example.com/${i}` })).toHaveProperty("content");
        expect(await tool.run({ url: "https://example.com/4" })).toHaveProperty("error");
        expect(scrape).toHaveBeenCalledTimes(3);
    });
});
