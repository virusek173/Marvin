import { CiteRegistry } from "../cites";

describe("CiteRegistry", () => {
    it("gives the same token to the same link and distinct ones to different links", () => {
        const r = new CiteRegistry();
        expect(r.add("[a](<x>)")).toBe("{c1}");
        expect(r.add("[b](<y>)")).toBe("{c2}");
        expect(r.add("[a](<x>)")).toBe("{c1}");
    });

    it("expands tokens in a reply and drops tokens it never issued", () => {
        const r = new CiteRegistry();
        const link = "[01.10.2026 22:02](<https://discord.com/channels/1/2/3>)";
        r.add(link);
        expect(r.expand("- {c1} Olek kupił rower; {c1} i {c9}")).toBe(`- ${link} Olek kupił rower; ${link} i `);
        expect(r.expand("bez znaczników")).toBe("bez znaczników");
    });
});
