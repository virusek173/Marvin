import { HistoryDb, ProfileSourceMessage } from "./db.js";
import { renderBody } from "./context.js";
import { formatWarsaw } from "./time.js";
import { historyLog } from "./log.js";
import { cutText, mapGlobalNameNameToRealName } from "../../utils/helpers.js";

export const PROFILE_LIMITS = {
    /** People with fewer text messages than this get no profile. */
    minMessages: 30,
    /** An existing profile is refreshed only when at least this many new messages arrived... */
    minNew: 20,
    /** ...and at least this many days passed since it was written. */
    refreshDays: 7,
    firstBatch: 500,
    updateBatch: 400,
    lineChars: 300,
    totalChars: 40000,
    summaryChars: 1200,
};

export type AskModel = (system: string, user: string) => Promise<string | null | undefined>;

export interface ProfileServiceOptions {
    excludedChannelIds: string[];
    selfId?: string;
    ask: AskModel;
    systemPrompt: string;
    now?: () => number;
}

export interface ProfileRunResult {
    updated: string[];
    skipped: number;
    failed: string[];
}

/** Builds and incrementally refreshes a short profile of every regular chat participant from their archived messages. */
export class ProfileService {
    constructor(private db: HistoryDb, private options: ProfileServiceOptions) {}

    async updateAll(): Promise<ProfileRunResult> {
        const now = this.options.now ?? Date.now;
        const people = new Map<string, { names: string[]; messages: number; isBot: boolean }>();
        for (const author of this.db.getProfileAuthors(this.options.excludedChannelIds, this.options.selfId)) {
            const name = mapGlobalNameNameToRealName[author.authorName];
            const person = people.get(name) ?? { names: [], messages: 0, isBot: true };
            person.names.push(author.authorName);
            person.messages += author.messages;
            person.isBot = person.isBot && author.isBot;
            people.set(name, person);
        }

        const result: ProfileRunResult = { updated: [], skipped: 0, failed: [] };
        for (const [name, person] of people) {
            if (person.messages < PROFILE_LIMITS.minMessages) { result.skipped++; continue; }
            try {
                if (await this.updateOne(name, person, now()))result.updated.push(name);
                else result.skipped++;
            } catch (error: any) {
                result.failed.push(name);
                historyLog.error(`profil ${name}: nie udało się wygenerować`, error);
            }
        }
        historyLog.info(`profile: zaktualizowano ${result.updated.length} (${result.updated.join(", ") || "-"}), pominięto ${result.skipped}, błędy ${result.failed.length}`);
        return result;
    }

    private async updateOne(name: string, person: { names: string[]; messages: number; isBot: boolean }, now: number): Promise<boolean> {
        const existing = this.db.getProfile(name);
        if (existing && now - existing.updatedAt < PROFILE_LIMITS.refreshDays * 86_400_000) return false;

        const batch = existing ? PROFILE_LIMITS.updateBatch : PROFILE_LIMITS.firstBatch;
        const messages = this.db.getAuthorMessagesAfter(person.names, existing?.lastSeq ?? 0, this.options.excludedChannelIds, batch, this.options.selfId);
        if (existing ? messages.length < PROFILE_LIMITS.minNew : messages.length === 0) return false;

        const reply = await this.options.ask(this.options.systemPrompt, this.buildInput(name, person.isBot, existing?.summary, messages));
        const summary = cutText((reply ?? "").trim(), PROFILE_LIMITS.summaryChars);
        if (!summary) throw new Error("model zwrócił pusty profil");

        this.db.upsertProfile({
            name,
            summary,
            messageCount: person.messages,
            lastSeq: Math.max(...messages.map(m => m.seq)),
            updatedAt: now,
        });
        return true;
    }

    private buildInput(name: string, isBot: boolean, previous: string | undefined, messages: ProfileSourceMessage[]): string {
        const lines = messages.map(m => {
            const text = renderBody(m)
                .replace(/<@!?(\d+)>/g, (_, id: string) => (id === this.options.selfId ? "@Marvin" : "@ktoś"))
                .replace(/\s+/g, " ")
                .trim();
            const clipped = text.length > PROFILE_LIMITS.lineChars ? `${cutText(text, PROFILE_LIMITS.lineChars)}…` : text;
            return `[${formatWarsaw(m.createdAt)}] ${clipped}`;
        });
        let total = 0;
        const kept: string[] = [];
        for (let i = lines.length - 1; i >= 0; i--) {
            total += lines[i].length + 1;
            if (total > PROFILE_LIMITS.totalChars) break;
            kept.unshift(lines[i]);
        }
        return [
            isBot ? `Bot: ${name} (to nie człowiek, tylko bot z serwera)` : `Osoba: ${name}`,
            previous ? `Dotychczasowy profil:\n${previous}` : "Dotychczasowy profil: brak (to pierwszy profil).",
            `Wiadomości ${isBot ? "tego bota" : "tej osoby"} (${kept.length}), od najstarszej:\n${kept.join("\n")}`,
        ].join("\n\n");
    }
}
