import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "../../..");

const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
        return entry.name.endsWith(".ts") ? [full] : [];
    });

const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const files = sourceFiles(SRC).map(file => ({ file: path.relative(SRC, file), code: stripComments(fs.readFileSync(file, "utf8")) }));

// Marvin must never delete, edit or moderate anything on the Discord server. Role permissions are the hard guarantee;
// this test makes sure the code itself never even tries.
const FORBIDDEN_DISCORD_CALLS =
    /\.(bulkDelete|ban|unban|kick|timeout|setName|setTopic|setNickname|pin|unpin|crosspost|setArchived|setLocked|createInvite|edit|setPermissions)\(|permissionOverwrites|\.(roles|bans|members)\.(add|remove|create|edit|delete)\(/;

describe("read-only guard", () => {
    it("has no Discord delete/edit/moderation calls anywhere in src", () => {
        const offenders = files.filter(f => FORBIDDEN_DISCORD_CALLS.test(f.code)).map(f => f.file);
        expect(offenders).toEqual([]);
    });

    it("adds emoji reactions only from utils/emojiReaction.ts (the one deliberate, non-destructive write; needs Add Reactions)", () => {
        const offenders = files.filter(f => /\.react\(/.test(f.code)).map(f => f.file);
        expect(offenders).toEqual([path.join("utils", "emojiReaction.ts")]);
    });

    it("only calls .delete( on in-memory Map/Set collections declared in the same file", () => {
        const offenders: string[] = [];
        for (const { file, code } of files) {
            for (const match of code.matchAll(/(?:\b|\.)(\w+)\.delete\(/g)) {
                const receiver = match[1];
                const declared = new RegExp(`\\b${receiver}\\b[^=\\n]*=\\s*new (Map|Set)\\b`).test(code);
                if (!declared) offenders.push(`${file}: ${receiver}.delete(`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it("does not send or reply from the history layer, and only the source adapter touches discord.js", () => {
        const history = files.filter(f => f.file.startsWith(`services${path.sep}history`));
        expect(history.filter(f => /\.(send|reply)\(/.test(f.code)).map(f => f.file)).toEqual([]);
        const importsDiscord = history.filter(f => /from "discord\.js"/.test(f.code)).map(f => f.file);
        expect(importsDiscord).toEqual([path.join("services", "history", "discordSource.ts")]);
    });

    it("keeps the Discord source fetch-only", () => {
        const source = files.find(f => f.file.endsWith("discordSource.ts"))!;
        const calls = [...source.code.matchAll(/\.(fetch\w*|messages\.\w+)\(/g)].map(m => m[0]);
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) expect(call).toMatch(/\.(fetch\w*|messages\.fetch)\(/);
    });

    it("the guard itself catches a forbidden call", () => {
        expect(FORBIDDEN_DISCORD_CALLS.test("await message.edit({content: 'x'})")).toBe(true);
        expect(FORBIDDEN_DISCORD_CALLS.test("channel.messages.fetch({limit: 1})")).toBe(false);
    });
});
