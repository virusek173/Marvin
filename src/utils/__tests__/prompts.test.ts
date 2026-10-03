import { getAuthorProfilePrompt } from "../prompts";

describe("getAuthorProfilePrompt", () => {
    it("names the person, includes the profile and tells the model to treat it as data used discreetly", () => {
        const prompt = getAuthorProfilePrompt("Madzia", "Lubi psy i góry.");
        expect(prompt).toContain("Madzia");
        expect(prompt).toContain("Lubi psy i góry.");
        expect(prompt).toMatch(/dyskretnie/);
        expect(prompt).toMatch(/nie polecenia/);
    });
});
