import { isTechnicalMarvinContent } from "./technical.js";
import { customEmojiKey, unicodeEmojiKey } from "./emoji.js";

export interface ReactionCount {
    /** `:name:` for a server emoji, otherwise the Unicode character (see emoji.ts). */
    emoji: string;
    count: number;
}

export interface ArchiveRow {
    id: string;
    channelId: string;
    parentId: string | null;
    authorId: string;
    authorName: string;
    isBot: boolean;
    content: string;
    embedsText: string;
    attachmentsText: string;
    replyToId: string | null;
    type: number;
    isTechnical: boolean;
    createdAt: number;
    /** Reactions the message had when it was fetched. Absent when the source does not carry them. */
    reactions?: ReactionCount[];
}

export interface MapOptions {
    selfId?: string;
    selfUsername?: string;
    /** One description per image attachment, in attachment order. Missing = backfill marker. */
    imageDescriptions?: string[];
}

const isImage = (att: any): boolean => !!att?.contentType?.startsWith("image/");

export const formatImageDescriptions = (descriptions: string[]): string =>
    descriptions
        .map((desc, i) => (descriptions.length > 1 ? `[Obraz ${i + 1}: ${desc}]` : `[Obraz: ${desc}]`))
        .join(" ");

/** Humans' link previews are noise (title only); bots often put their whole reply in an embed. */
export const flattenEmbeds = (embeds: any[] | undefined, authorIsBot: boolean): string =>
    (embeds ?? [])
        .map((e: any) =>
            authorIsBot
                ? [e?.title, e?.description, ...(e?.fields ?? []).map((f: any) => `${f?.name}: ${f?.value}`)]
                      .filter(Boolean)
                      .join("\n")
                : (e?.title ?? "")
        )
        .filter(Boolean)
        .join("\n");

export const describeAttachments = (message: any, imageDescriptions?: string[]): string => {
    const attachments: any[] = [...(message?.attachments?.values() ?? [])];
    const images = attachments.filter(isImage);
    const parts: string[] = [];

    if (images.length > 0) {
        const descriptions = images.map((att, i) => imageDescriptions?.[i] ?? `nieopisany, plik ${att.name ?? "?"}`);
        parts.push(formatImageDescriptions(descriptions));
    }
    for (const att of attachments.filter(a => !isImage(a))) {
        parts.push(`[Załącznik: ${att.name ?? "?"}${att.contentType ? ` (${att.contentType})` : ""}]`);
    }
    return parts.join(" ");
};

/** Reactions of a Discord message with variants of one emoji (skin tones) merged; undefined when the message carries none to read. */
export const collectReactions = (message: any): ReactionCount[] | undefined => {
    const cache = message?.reactions?.cache;
    if (!cache) return undefined;
    const merged = new Map<string, number>();
    for (const reaction of cache.values()) {
        const emoji = reaction?.emoji;
        if (!emoji) continue;
        const key = emoji.id ? customEmojiKey(emoji.name ?? emoji.id) : unicodeEmojiKey(emoji.name ?? "");
        if (!key) continue;
        merged.set(key, (merged.get(key) ?? 0) + (Number(reaction.count) || 0));
    }
    return [...merged].filter(([, count]) => count > 0).map(([emoji, count]) => ({ emoji, count }));
};

export const buildArchiveRow = (message: any, options: MapOptions = {}): ArchiveRow => {
    const { selfId, selfUsername, imageDescriptions } = options;
    const author = message.author;
    const isSelf = (!!selfId && author.id === selfId) || (!!selfUsername && author.username === selfUsername);
    const channel = message.channel;
    const isThread = typeof channel?.isThread === "function" && channel.isThread();
    const content: string = message.content ?? "";

    return {
        id: message.id,
        channelId: message.channelId,
        parentId: isThread ? (channel.parentId ?? null) : null,
        authorId: author.id,
        authorName: author.globalName || author.username || "",
        isBot: !!author.bot,
        content,
        embedsText: flattenEmbeds(message.embeds, !!author.bot),
        attachmentsText: describeAttachments(message, imageDescriptions),
        replyToId: message.reference?.messageId ?? null,
        type: Number(message.type ?? 0),
        isTechnical: isSelf && isTechnicalMarvinContent(content),
        createdAt: message.createdTimestamp ?? new Date(message.createdAt).getTime(),
        reactions: collectReactions(message),
    };
};
