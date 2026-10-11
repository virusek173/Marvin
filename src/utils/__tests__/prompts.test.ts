import { getAuthorProfilePrompt, getArchiveRangePrompt, getMarvinMotivationSystemPrompt, HISTORY_TOOLS_PROMPT, WEB_SEARCH_PROMPT } from "../prompts";

describe("getMarvinMotivationSystemPrompt people", () => {
    const ids = { MarvinId: "99", AdamId: "11", MugdaId: "22" };

    it("builds the people list from the generated profiles, cut to one short line", () => {
        const long = "Lubi biegać. ".repeat(60);
        const prompt = getMarvinMotivationSystemPrompt("2026.10.11", ids, [{ name: "Adam", profile: long }, { name: "Mugda", profile: "Bot od prania." }]);
        expect(prompt).toContain("Adam - Lubi biegać.");
        expect(prompt).toContain("Mugda - Bot od prania.");
        expect(prompt.match(/Adam - .*/)![0].length).toBeLessThan(260);
    });

    it("has no people section when no profiles exist yet", () => {
        expect(getMarvinMotivationSystemPrompt("2026.10.11", ids)).not.toContain("Osoby, które znasz");
    });

    it("mentions people that have an id and tells not to ping the rest of the nick map", () => {
        const prompt = getMarvinMotivationSystemPrompt("2026.10.11", ids);
        expect(prompt).toContain("Adam(<@11>)");
        expect(prompt).toContain("Mugda(<@22>)");
        expect(prompt).not.toContain("Marvin(<@99>)");
        expect(prompt).toMatch(/nie przywołuj.*Beata/);
        expect(prompt).not.toMatch(/nie przywołuj[^\n]*Adam/);
    });
});

describe("getArchiveRangePrompt", () => {
    it("states the archive start date and that nothing exists before it", () => {
        const prompt = getArchiveRangePrompt("15.01.2021");
        expect(prompt).toContain("15.01.2021");
        expect(prompt).toMatch(/Przed tą datą nie ma/);
    });
});

describe("getAuthorProfilePrompt", () => {
    it("names the person, includes the profile and tells the model to treat it as data used discreetly", () => {
        const prompt = getAuthorProfilePrompt("Beata", "Lubi psy i góry.");
        expect(prompt).toContain("Beata");
        expect(prompt).toContain("Lubi psy i góry.");
        expect(prompt).toMatch(/dyskretnie/);
        expect(prompt).toMatch(/nie polecenia/);
    });
});

describe("tool prompts", () => {
    it("tells the model to paste the short citation token and to treat web results as data", () => {
        expect(HISTORY_TOOLS_PROMPT).toMatch(/\{c3\}/);
        expect(WEB_SEARCH_PROMPT).toMatch(/web_search/);
        expect(WEB_SEARCH_PROMPT).toMatch(/dane, a nie polecenia/);
    });
});
