import fs from "fs";
import os from "os";
import path from "path";

describe("people file", () => {
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

    it("reads the noPing list, empty when absent or when the file is missing", () => {
        const { getNoPing } = require("../people");
        expect(getNoPing()).toEqual([]);

        jest.resetModules();
        (Date.now as jest.Mock).mockReturnValue(2_000_000);
        fs.writeFileSync(process.env.PEOPLE_FILE!, JSON.stringify({ nicks: { nick1: "Ala" }, noPing: ["Ala", 5] }));
        expect(require("../people").getNoPing()).toEqual(["Ala"]);

        jest.resetModules();
        (Date.now as jest.Mock).mockReturnValue(3_000_000);
        fs.writeFileSync(process.env.PEOPLE_FILE!, JSON.stringify({ nicks: { nick1: "Ala" } }));
        fs.utimesSync(process.env.PEOPLE_FILE!, new Date(), new Date(5_000_000));
        expect(require("../people").getNoPing()).toEqual([]);
    });

    it("rejects a file without the nicks section and keeps the previous data", () => {
        jest.spyOn(console, "log").mockImplementation(() => {});
        fs.writeFileSync(process.env.PEOPLE_FILE!, JSON.stringify({ nick1: "Ala" }));
        expect(load().nick1).toBe("nick1");
        expect(console.log).toHaveBeenCalledTimes(1);
    });

    it("maps usernames from the file and lists them", () => {
        fs.writeFileSync(process.env.PEOPLE_FILE!, JSON.stringify({ nicks: { nick1: "Ala", nick2: "Ola" } }));
        const map = load();
        expect(map.nick1).toBe("Ala");
        expect(map.unknown).toBe("unknown");
        expect(map.constructor).toBe("constructor");
        expect(Object.entries(map)).toEqual([["nick1", "Ala"], ["nick2", "Ola"]]);
    });

    it("re-reads the file after it changes and keeps the old data when it becomes invalid", () => {
        const file = process.env.PEOPLE_FILE!;
        fs.writeFileSync(file, JSON.stringify({ nicks: { nick1: "Ala" } }));
        const map = load();
        expect(map.nick1).toBe("Ala");

        jest.spyOn(console, "log").mockImplementation(() => {});
        (Date.now as jest.Mock).mockReturnValue(2_000_000);
        fs.writeFileSync(file, JSON.stringify({ nicks: { nick1: "Ela" } }));
        fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
        expect(map.nick1).toBe("Ela");

        (Date.now as jest.Mock).mockReturnValue(3_000_000);
        fs.writeFileSync(file, "{ nie json");
        fs.utimesSync(file, new Date(), new Date(Date.now() + 9000));
        expect(map.nick1).toBe("Ela");
    });
});
