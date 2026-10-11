import { Readable } from "node:stream";
import axios from "axios";
import { extractUrls, isPrivateAddress, scrapeUrl } from "../scraper";

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

describe("isPrivateAddress", () => {
    it("blocks loopback, private, link-local, CGNAT and non-public IPv6, allows public ones", () => {
        for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
            expect(isPrivateAddress(ip)).toBe(true);
        }
        for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700::1111"]) {
            expect(isPrivateAddress(ip)).toBe(false);
        }
    });

    it("scrapeUrl refuses internal literal addresses and other protocols without any request", async () => {
        jest.spyOn(console, "error").mockImplementation(() => {});
        (axios.get as jest.Mock).mockClear();
        expect(await scrapeUrl("http://127.0.0.1:8080/admin")).toBeNull();
        expect(await scrapeUrl("http://[::1]/")).toBeNull();
        expect(await scrapeUrl("http://169.254.169.254/latest/meta-data")).toBeNull();
        expect(await scrapeUrl("file:///etc/passwd")).toBeNull();
        expect(axios.get).not.toHaveBeenCalled();
    });
});
