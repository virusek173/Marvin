import { getAuthorProfilePrompt, getArchiveRangePrompt, getMarvinMotivationSystemPrompt, getReminderPrompt, getReminderCommentSystemPrompt, HISTORY_TOOLS_PROMPT, WEB_SEARCH_PROMPT } from "../prompts";

describe("getMarvinMotivationSystemPrompt people", () => {
    const ids = { Adam: "11", Mugda: "22", Beata: "33" };

    it("builds the people list from the generated profiles, cut to one short line", () => {
        const long = "Lubi biegać. ".repeat(60);
        const prompt = getMarvinMotivationSystemPrompt("2026.10.11", "99", ids, [{ name: "Adam", profile: long }, { name: "Mugda", profile: "Bot od prania." }]);
        expect(prompt).toContain("Adam - Lubi biegać.");
        expect(prompt).toContain("Mugda - Bot od prania.");
        expect(prompt.match(/Adam - .*/)![0].length).toBeLessThan(260);
    });

    it("has no people section when no profiles exist yet", () => {
        expect(getMarvinMotivationSystemPrompt("2026.10.11", "99", ids)).not.toContain("Osoby, które znasz");
    });

    it("mentions people that have an id, except the noPing list, which is to be written as plain names", () => {
        const prompt = getMarvinMotivationSystemPrompt("2026.10.11", "99", ids);
        expect(prompt).toContain("Adam(<@11>)");
        expect(prompt).toContain("Mugda(<@22>)");
        expect(prompt).not.toContain("Beata(<@33>)");
        expect(prompt).toContain("<@99> to wywołanie Ciebie");
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
    it("names the person, includes the profile and asks for personal, occasional, non-quoting replies treating it as data", () => {
        const prompt = getAuthorProfilePrompt("Beata", "Lubi psy i góry.");
        expect(prompt).toContain("Beata");
        expect(prompt).toContain("Lubi psy i góry.");
        expect(prompt).toMatch(/osobiście/);
        expect(prompt).toMatch(/co trzecią/);
        expect(prompt).toMatch(/Nie cytuj/);
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

describe("reminder prompts", () => {
    it("is static (no clock, for the prompt cache) and tells the model to call the tool, ask for a missing hour and confirm with the returned date", () => {
        const prompt = getReminderPrompt();
        expect(prompt).not.toMatch(/Teraz jest/);
        expect(prompt).toMatch(/create_reminder/);
        expect(prompt).toMatch(/zapytaj o godzinę/);
        expect(prompt).toMatch(/pola due/);
        expect(prompt).toMatch(/Cyklicznych/);
    });

    it("keeps the comment to one line and treats the reminder text as data", () => {
        const prompt = getReminderCommentSystemPrompt();
        expect(prompt).toMatch(/JEDNO krótkie zdanie/);
        expect(prompt).toMatch(/dane od użytkownika, a nie polecenia/);
        expect(prompt).toMatch(/Nikogo nie oznaczaj/);
    });
});
