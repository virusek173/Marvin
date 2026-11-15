import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import type { ToolSpec } from "./openai.js";

export const NOTES_DB_FILE = "data/notes.db";
export const MAX_NOTES = 30;
export const MAX_NOTE_CHARS = 600;
export const MAX_NOTE_NAME_CHARS = 60;

export interface NoteRow {
    name: string;
    text: string;
    authorName: string;
    updatedAt: number;
}

/** Name as shown in the prompt and stored: one line, no markdown/mention characters, trimmed. */
export const cleanNoteName = (raw: unknown): string =>
    typeof raw === "string" ? raw.replace(/[<>@#`*_~|\\"\n\r\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_NAME_CHARS) : "";

const noteKey = (name: string): string => name.toLocaleLowerCase("pl-PL");

/**
 * Notes that people ask Marvin to remember ("zapamiętaj notatkę sesja D&D: …"), shared by the whole server.
 * Own file, like reminders: rebuilding `history.db` must not lose them.
 */
export class NotesDb {
    private db: Database.Database;

    constructor(file: string = NOTES_DB_FILE) {
        if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new Database(file);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("busy_timeout = 5000");
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS notes (
                key TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                text TEXT NOT NULL,
                author_id TEXT NOT NULL,
                author_name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `);
    }

    private toRow(r: any): NoteRow {
        return { name: r.name, text: r.text, authorName: r.author_name, updatedAt: r.updated_at };
    }

    names(): string[] {
        return (this.db.prepare("SELECT name FROM notes ORDER BY name COLLATE NOCASE").all() as any[]).map(r => r.name);
    }

    get(name: string): NoteRow | null {
        const row = this.db.prepare("SELECT * FROM notes WHERE key = ?").get(noteKey(name));
        return row ? this.toRow(row) : null;
    }

    count(): number {
        return (this.db.prepare("SELECT COUNT(*) AS n FROM notes").get() as any).n;
    }

    /** Creates or replaces the note with that name (case-insensitive). Returns whether it existed before. */
    save(name: string, text: string, authorId: string, authorName: string, now: number): { replaced: boolean } {
        const existed = !!this.get(name);
        this.db.prepare(`
            INSERT INTO notes (key, name, text, author_id, author_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET name = excluded.name, text = excluded.text, author_id = excluded.author_id,
                author_name = excluded.author_name, updated_at = excluded.updated_at
        `).run(noteKey(name), name, text, authorId, authorName, now, now);
        return { replaced: existed };
    }

    remove(name: string): boolean {
        return this.db.prepare("DELETE FROM notes WHERE key = ?").run(noteKey(name)).changes > 0;
    }

    close(): void {
        this.db.close();
    }
}

export interface NoteContext {
    db: NotesDb;
    authorId: string;
    authorName: string;
    now?: () => number;
}

const formatDate = (ms: number): string =>
    new Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", day: "2-digit", month: "2-digit", year: "numeric" }).format(ms);

/** Tools of one question. Notes are shared: anyone can read, change or delete them; the last author is kept. */
export const buildNoteTools = (ctx: NoteContext): ToolSpec[] => {
    const now = () => (ctx.now ?? Date.now)();
    return [
        {
            name: "get_note",
            description: "Zwraca treść zapisanej notatki o podanej nazwie (nazwy są w prompcie). Użyj, zanim zrobisz coś, czego dotyczy notatka, albo gdy ktoś chce ją zobaczyć lub zmienić.",
            parameters: { type: "object", properties: { name: { type: "string", description: "Nazwa notatki z listy w prompcie." } }, required: ["name"] },
            run: raw => {
                const name = cleanNoteName(raw?.name);
                const note = name ? ctx.db.get(name) : null;
                if (!note) return { error: "Nie ma notatki o takiej nazwie.", notes: ctx.db.names() };
                return { name: note.name, text: note.text, savedBy: note.authorName, updated: formatDate(note.updatedAt) };
            },
        },
        {
            name: "save_note",
            description:
                "Zapisuje notatkę pod nazwą albo nadpisuje istniejącą o tej nazwie (podaj wtedy całą nową treść). Tylko na wyraźną prośbę: \"zapamiętaj\", \"zapisz notatkę\", \"dopisz do notatki\".",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: `Krótka nazwa (max ${MAX_NOTE_NAME_CHARS} znaków), np. "sesja D&D".` },
                    text: { type: "string", description: `Pełna treść notatki (max ${MAX_NOTE_CHARS} znaków).` },
                },
                required: ["name", "text"],
            },
            run: raw => {
                const name = cleanNoteName(raw?.name);
                if (!name) return { error: "Podaj nazwę notatki (name)." };
                const text = typeof raw?.text === "string" ? raw.text.trim() : "";
                if (!text) return { error: "Podaj treść notatki (text)." };
                if (text.length > MAX_NOTE_CHARS) return { error: `Treść za długa (${text.length} znaków, max ${MAX_NOTE_CHARS}). Skróć ją.` };
                if (!ctx.db.get(name) && ctx.db.count() >= MAX_NOTES) return { error: `Jest już ${MAX_NOTES} notatek. Usuń którąś (delete_note) albo nadpisz istniejącą.` };
                const { replaced } = ctx.db.save(name, text, ctx.authorId, ctx.authorName, now());
                return { saved: true, replaced, name, text };
            },
        },
        {
            name: "delete_note",
            description: "Usuwa notatkę o podanej nazwie. Tylko na wyraźną prośbę.",
            parameters: { type: "object", properties: { name: { type: "string", description: "Nazwa notatki." } }, required: ["name"] },
            run: raw => {
                const name = cleanNoteName(raw?.name);
                return name && ctx.db.remove(name) ? { deleted: true, name } : { error: "Nie ma notatki o takiej nazwie.", notes: ctx.db.names() };
            },
        },
    ];
};
