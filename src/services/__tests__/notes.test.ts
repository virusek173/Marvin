import { NotesDb, buildNoteTools, cleanNoteName, MAX_NOTES, MAX_NOTE_CHARS } from "../notes";
import { getNotesPrompt } from "../../utils/prompts";

const NOW = Date.UTC(2026, 10, 15, 10, 0);

const setup = () => {
    const db = new NotesDb(":memory:");
    const tools = (authorId = "1", authorName = "Ania") => {
        const list = buildNoteTools({ db, authorId, authorName, now: () => NOW });
        return Object.fromEntries(list.map(t => [t.name, t.run])) as Record<string, (args: any) => any>;
    };
    return { db, tools };
};

describe("note tools", () => {
    it("saves, reads (case-insensitive) and replaces a note", () => {
        const { db, tools } = setup();
        expect(tools().save_note({ name: "sesja D&D", text: "Uczestnicy: Ania, Adam." })).toMatchObject({ saved: true, replaced: false });
        expect(tools().get_note({ name: "SESJA d&d" })).toMatchObject({ name: "sesja D&D", text: "Uczestnicy: Ania, Adam.", savedBy: "Ania", updated: "15.11.2026" });

        expect(tools("2", "Adam").save_note({ name: "Sesja D&D", text: "Uczestnicy: Ania, Adam, Ewa." })).toMatchObject({ replaced: true });
        expect(db.names()).toEqual(["Sesja D&D"]);
        expect(tools().get_note({ name: "sesja d&d" })).toMatchObject({ text: "Uczestnicy: Ania, Adam, Ewa.", savedBy: "Adam" });
    });

    it("deletes a note and reports unknown names with the list", () => {
        const { db, tools } = setup();
        tools().save_note({ name: "planszówki", text: "U Adama w soboty." });
        expect(tools().get_note({ name: "nie ma" })).toMatchObject({ error: expect.any(String), notes: ["planszówki"] });
        expect(tools().delete_note({ name: "Planszówki" })).toEqual({ deleted: true, name: "Planszówki" });
        expect(db.count()).toBe(0);
        expect(tools().delete_note({ name: "planszówki" })).toHaveProperty("error");
    });

    it("validates name, text and limits", () => {
        const { db, tools } = setup();
        expect(tools().save_note({ name: "", text: "x" })).toHaveProperty("error");
        expect(tools().save_note({ name: "a", text: "  " })).toHaveProperty("error");
        expect(tools().save_note({ name: "a", text: "x".repeat(MAX_NOTE_CHARS + 1) })).toHaveProperty("error");
        for (let i = 0; i < MAX_NOTES; i++) db.save(`n${i}`, "x", "1", "Ania", NOW);
        expect(tools().save_note({ name: "nowa", text: "x" })).toHaveProperty("error");
        expect(tools().save_note({ name: "N0", text: "y" })).toMatchObject({ saved: true, replaced: true });
    });

    it("cleans names so they cannot break the prompt or ping anyone", () => {
        expect(cleanNoteName('  sesja\n"D&D" <@123> ')).toBe("sesja D&D 123");
        expect(cleanNoteName(42)).toBe("");
        expect(cleanNoteName("x".repeat(100))).toHaveLength(60);
    });
});

describe("getNotesPrompt", () => {
    it("lists only the names, not the texts", () => {
        const prompt = getNotesPrompt(["sesja D&D", "planszówki"]);
        expect(prompt).toContain('"sesja D&D", "planszówki"');
        expect(getNotesPrompt([])).toContain("(brak)");
    });
});
