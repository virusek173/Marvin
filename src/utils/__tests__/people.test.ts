import fs from "fs";
import os from "os";
import path from "path";

describe("collectPersonIds", () => {
    it("turns <NAME>_ID variables into <Name>Id and skips channel ids and empty values", () => {
        const { collectPersonIds } = require("../people");
        expect(collectPersonIds({
            MARVIN_ID: "9", CHANNEL_ID: "1", BOTS_CHANNEL_ID: "2", ANNA_ID: "11", BOT2_ID: "22", EMPTY_ID: "",
            EXCLUDED_CHANNEL_IDS: "3,4", DISCORD_CLIENT_TOKEN: "x", lower_ID: "5",
        })).toEqual({ MarvinId: "9", AnnaId: "11", Bot2Id: "22" });
    });
});

describe("name map from a file", () => {
    const original = process.env.PEOPLE_FILE;
    let dir: string;

    beforeEach(() => {
        jest.resetModules();
        jest.spyOn(Date, "now").mockReturnValue(1_000_000);
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "people-"));
        process.env.PEOPLE_FILE = path.join(dir, "people.json");
    });
    afterEach(() => {
        process.env.PEOPLE_FILE = original;
        jest.restoreAllMocks();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const load = () => require("../helpers").mapGlobalNameNameToRealName as Record<string, string>;

    it("falls back to the username when the file is missing", () => {
        expect(load()["ktoś"]).toBe("ktoś");
        expect(Object.keys(load())).toEqual([]);
    });

    it("maps usernames from the file and lists them", () => {
        fs.writeFileSync(process.env.PEOPLE_FILE!, JSON.stringify({ nick1: "Ala", nick2: "Ola" }));
        const map = load();
        expect(map.nick1).toBe("Ala");
        expect(map.unknown).toBe("unknown");
        expect(map.constructor).toBe("constructor");
        expect(Object.entries(map)).toEqual([["nick1", "Ala"], ["nick2", "Ola"]]);
    });

    it("re-reads the file after it changes and keeps the old data when it becomes invalid", () => {
        const file = process.env.PEOPLE_FILE!;
        fs.writeFileSync(file, JSON.stringify({ nick1: "Ala" }));
        const map = load();
        expect(map.nick1).toBe("Ala");

        jest.spyOn(console, "log").mockImplementation(() => {});
        (Date.now as jest.Mock).mockReturnValue(2_000_000);
        fs.writeFileSync(file, JSON.stringify({ nick1: "Ela" }));
        fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
        expect(map.nick1).toBe("Ela");

        (Date.now as jest.Mock).mockReturnValue(3_000_000);
        fs.writeFileSync(file, "{ nie json");
        fs.utimesSync(file, new Date(), new Date(Date.now() + 9000));
        expect(map.nick1).toBe("Ela");
    });
});
