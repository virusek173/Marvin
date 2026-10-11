import fs from "fs";

const RECHECK_MS = 5000;

interface PeopleFile {
    nicks: Record<string, string>;
    noPing: string[];
}

let cached: PeopleFile = { nicks: {}, noPing: [] };
let loadedMtime = -1;
let lastCheck = 0;
let warnedAbout = "";

const parse = (raw: any): PeopleFile => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error('oczekiwano obiektu {"nicks": {...}, "noPing": [...]}');
    const { nicks, noPing = [] } = raw;
    if (!nicks || typeof nicks !== "object" || Array.isArray(nicks)) throw new Error('brak sekcji "nicks": {nick: imię}');
    if (!Array.isArray(noPing)) throw new Error('"noPing" ma być listą imion');
    return {
        nicks: Object.fromEntries(Object.entries(nicks).filter(([, v]) => typeof v === "string")) as Record<string, string>,
        noPing: noPing.filter((v: unknown): v is string => typeof v === "string"),
    };
};

/** The people file on the data volume (JSON `{"nicks": {nick: name}, "noPing": [name]}`), never in the repo; re-read when the file changes. */
const loadPeople = (): PeopleFile => {
    const now = Date.now();
    if (now - lastCheck < RECHECK_MS) return cached;
    lastCheck = now;
    const file = process.env.PEOPLE_FILE || "data/people.json";
    try {
        const mtime = fs.statSync(file).mtimeMs;
        if (mtime === loadedMtime) return cached;
        cached = parse(JSON.parse(fs.readFileSync(file, "utf8")));
        loadedMtime = mtime;
        warnedAbout = "";
    } catch (error: any) {
        if (error?.code === "ENOENT") {
            cached = { nicks: {}, noPing: [] };
            loadedMtime = -1;
        } else if (warnedAbout !== error?.message) {
            warnedAbout = error?.message;
            console.log(`err (${file}, zostaje poprzednia wersja):`, error?.message);
        }
    }
    return cached;
};

/** Discord username (globalName) -> real first name. */
export const getNicks = (): Record<string, string> => loadPeople().nicks;

/** First names of people who did not agree to be pinged (written as plain names). */
export const getNoPing = (): string[] => loadPeople().noPing;
