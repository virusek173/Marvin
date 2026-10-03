import { ChannelType } from "discord.js";
import { ChannelInfo, DiscordSource } from "./sync.js";
import { historyLog } from "./log.js";

const MESSAGE_CHANNEL_TYPES = new Set<number>([
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildVoice,
    ChannelType.GuildStageVoice,
]);
const THREAD_PARENT_TYPES = new Set<number>([
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildForum,
    ChannelType.GuildMedia,
]);

/**
 * Read-only Discord access for the history sync: only list/fetch calls, nothing that sends, edits, deletes,
 * joins or unarchives. Private archived threads need Manage Threads (deliberately not granted) and are skipped.
 */
export class DiscordJsSource implements DiscordSource {
    private known = new Map<string, any>();
    private warned = new Set<string>();

    constructor(private client: any) {}

    private warnOnce(key: string, text: string): void {
        if (this.warned.has(key)) return;
        this.warned.add(key);
        historyLog.warn(text);
    }

    async listChannels(): Promise<ChannelInfo[]> {
        const result = new Map<string, ChannelInfo>();
        const add = (channel: any, kind: string) => {
            this.known.set(channel.id, channel);
            result.set(channel.id, { id: channel.id, name: channel.name ?? "", parentId: channel.parentId ?? null, kind });
        };

        for (const guild of this.client.guilds.cache.values()) {
            const parents: any[] = [];
            const channels = await guild.channels.fetch();
            for (const channel of channels.values()) {
                if (!channel) continue;
                if (!channel.viewable) {
                    this.warnOnce(`view:${channel.id}`, `kanał ${channel.id} (#${channel.name}) niewidoczny dla bota — pomijam`);
                    continue;
                }
                if (MESSAGE_CHANNEL_TYPES.has(channel.type)) add(channel, ChannelType[channel.type]);
                if (THREAD_PARENT_TYPES.has(channel.type)) parents.push(channel);
            }

            try {
                const active = await guild.channels.fetchActiveThreads();
                for (const thread of active.threads.values()) add(thread, "thread");
            } catch (error: any) {
                historyLog.warn(`aktywne wątki gildii ${guild.id} niedostępne: ${error?.message}`);
            }

            for (const parent of parents) {
                try {
                    let before: any;
                    for (;;) {
                        const page = await parent.threads.fetchArchived({ type: "public", limit: 100, before });
                        for (const thread of page.threads.values()) add(thread, "thread");
                        if (!page.hasMore || page.threads.size === 0) break;
                        before = page.threads.last();
                    }
                } catch (error: any) {
                    this.warnOnce(`archived:${parent.id}`, `archiwalne wątki kanału ${parent.id} (#${parent.name}) niedostępne: ${error?.message}`);
                }
            }
        }
        this.warnOnce("private-archived", "prywatne archiwalne wątki są pomijane (wymagają Manage Threads, którego bot celowo nie ma)");
        return [...result.values()];
    }

    async fetchPage(channelId: string, options: { after?: string; limit: number }): Promise<any[]> {
        const channel = this.known.get(channelId) ?? (await this.client.channels.fetch(channelId));
        if (!channel?.messages) throw new Error(`kanał ${channelId} nie ma wiadomości do pobrania`);
        const page = await channel.messages.fetch({ limit: options.limit, ...(options.after ? { after: options.after } : {}) });
        return [...page.values()];
    }
}
