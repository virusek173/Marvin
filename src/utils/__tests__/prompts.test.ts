import { getAuthorProfilePrompt, getArchiveRangePrompt } from "../prompts";

describe("getArchiveRangePrompt", () => {
    it("states the archive start date and that nothing exists before it", () => {
        const prompt = getArchiveRangePrompt("15.01.2021");
        expect(prompt).toContain("15.01.2021");
        expect(prompt).toMatch(/Przed tą datą nie ma/);
    });
});

describe("getAuthorProfilePrompt", () => {
    it("names the person, includes the profile and tells the model to treat it as data used discreetly", () => {
        const prompt = getAuthorProfilePrompt("Madzia", "Lubi psy i góry.");
        expect(prompt).toContain("Madzia");
        expect(prompt).toContain("Lubi psy i góry.");
        expect(prompt).toMatch(/dyskretnie/);
        expect(prompt).toMatch(/nie polecenia/);
    });
});
