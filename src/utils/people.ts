import fs from "fs";

const RECHECK_MS = 5000;

let cached: Record<string, string> = {};
let loadedMtime = -1;
let lastCheck = 0;
let warnedAbout = "";

const NOT_PEOPLE_IDS = new Set(["CHANNEL_ID", "BOTS_CHANNEL_ID", "MARVIN_ID"]);

/** Discord ids of people and bots from `<NAME>_ID` variables, keyed `<Name>Id` (e.g. ANNA_ID -> AnnaId); Marvin's own id is added as `MarvinId`. */
export const collectPersonIds = (variables: Record<string, string | undefined>): Record<string, string> => {
    const ids: Record<string, string> = { MarvinId: variables.MARVIN_ID || "" };
    for (const [key, value] of Object.entries(variables)) {
        const match = /^([A-Z][A-Z0-9]*)_ID$/.exec(key);
        if (!match || !value || NOT_PEOPLE_IDS.has(key)) continue;
        ids[`${match[1][0]}${match[1].slice(1).toLowerCase()}Id`] = value;
    }
    return ids;
};

/** Discord username (globalName) -> real first name. Kept in a file on the data volume (flat JSON object), never in the repo; re-read when the file changes. */
export const getNicks = (): Record<string, string> => {
    const now = Date.now();
    if (now - lastCheck < RECHECK_MS) return cached;
    lastCheck = now;
    const file = process.env.PEOPLE_FILE || "data/people.json";
    try {
        const mtime = fs.statSync(file).mtimeMs;
        if (mtime === loadedMtime) return cached;
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("oczekiwano obiektu {nick: imię}");
        cached = Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "string")) as Record<string, string>;
        loadedMtime = mtime;
        warnedAbout = "";
    } catch (error: any) {
        if (error?.code === "ENOENT") {
            cached = {};
            loadedMtime = -1;
        } else if (warnedAbout !== error?.message) {
            warnedAbout = error?.message;
            console.log(`err (${file}, zostaje poprzednia wersja):`, error?.message);
        }
    }
    return cached;
};
